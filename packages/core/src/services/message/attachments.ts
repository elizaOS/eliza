/** Loads and describes complete message attachments through the shared media boundary, preserving byte-budget rejection and stored references. */

import { describeImageCached } from "../../media";
import {
	fetchRemoteMedia,
	MediaFetchError,
	readResponseWithLimit,
} from "../../media/fetch";
import { imageDescriptionTemplate } from "../../prompts";
import { ModelType } from "../../types/model";
import type { Media } from "../../types/primitives";
import { ContentType } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import { getLocalServerUrl } from "../../utils";
import { resolveOptimizedPromptForRuntime } from "../optimized-prompt-resolver";
import {
	ATTACHMENT_FETCH_MAX_BYTES,
	ATTACHMENT_TURN_MAX_BYTES,
	type AttachmentByteBudget,
	attachmentFailure,
	type MediaWithInlineData,
	sanitizedAttachmentDiagnostic,
} from "./attachment-input.js";
export class MessageAttachments {
	/**
	 * Processes attachments by generating descriptions for supported media types.
	 */
	async processAttachments(
		runtime: IAgentRuntime,
		attachments: Media[],
	): Promise<Media[]> {
		if (!attachments || attachments.length === 0) {
			return [];
		}
		runtime.logger.debug(
			{ src: "service:message", count: attachments.length },
			"Processing attachments",
		);

		const processedAttachments: Media[] = [];
		const byteBudget: AttachmentByteBudget = {
			remaining: ATTACHMENT_TURN_MAX_BYTES,
		};
		// Enrichment is deliberately ordered. In particular, transcription models
		// are often backed by one local GPU/process; launching an attacker-sized
		// attachment array concurrently caused memory spikes and provider storms.
		for (const attachment of attachments) {
			const processed = await (async () => {
				const processedAttachment: Media = { ...attachment };

				const isRemote = /^(http|https):\/\//.test(attachment.url);
				const url = isRemote
					? attachment.url
					: getLocalServerUrl(attachment.url);

				try {
					// Only process images that don't already have descriptions
					if (
						attachment.contentType === ContentType.IMAGE &&
						!attachment.description
					) {
						// Skip image analysis when vision / image-description is explicitly
						// disabled (e.g. the user toggled the Vision capability off).
						const disableImageDesc = runtime.getSetting(
							"DISABLE_IMAGE_DESCRIPTION",
						);
						if (disableImageDesc === true || disableImageDesc === "true") {
							return processedAttachment;
						}

						runtime.logger.debug(
							{ src: "service:message", imageUrl: attachment.url },
							"Generating image description",
						);

						let imageUrl = url;
						const inlineData = attachment as MediaWithInlineData;

						if (
							typeof inlineData._data === "string" &&
							inlineData._data.trim() &&
							typeof inlineData._mimeType === "string" &&
							inlineData._mimeType.trim()
						) {
							imageUrl = `data:${inlineData._mimeType};base64,${inlineData._data}`;
						} else {
							// Inline the bytes as a data URL so the vision model never fetches
							// an attacker-controlled URL itself. Remote bytes go through the
							// SSRF-guarded fetcher (blocks private/loopback hosts); local
							// media-store URLs use the trusted runtime fetch.
							const { buffer, contentType } = await this.fetchAttachmentBytes(
								runtime,
								attachment.url,
								url,
								isRemote,
								byteBudget,
								attachment.size,
							);
							imageUrl = `data:${contentType};base64,${buffer.toString("base64")}`;
						}

						// Describe via the shared content-addressed cache: identical image
						// bytes reuse one stored description across messages and across the
						// other describe paths (read action, basic-capabilities helper)
						// instead of re-invoking the vision model every turn.
						const resolvedImagePrompt = resolveOptimizedPromptForRuntime(
							runtime,
							"media_description",
							imageDescriptionTemplate,
						);
						const described = await describeImageCached(
							runtime,
							imageUrl,
							resolvedImagePrompt,
						);
						if (described) {
							processedAttachment.description = described.description;
							processedAttachment.title = described.title || "Image";
							processedAttachment.text = described.text;
							runtime.logger.debug(
								{
									src: "service:message",
									descriptionPreview: described.description?.substring(0, 100),
								},
								"Generated image description",
							);
						} else {
							processedAttachment.notProcessed =
								"Image description unavailable (vision backend returned no result)";
							runtime.logger.warn(
								{ src: "service:message" },
								"Image description unavailable for attachment",
							);
						}
					} else if (
						attachment.contentType === ContentType.DOCUMENT &&
						!attachment.text
					) {
						const { buffer, contentType } = await this.fetchAttachmentBytes(
							runtime,
							attachment.url,
							url,
							isRemote,
							byteBudget,
							attachment.size,
						);
						// Any text/* document (plain, csv, markdown) and application/json —
						// all on the chat upload allow-list — is readable as UTF-8 text;
						// PDFs are extracted via unpdf. Previously only text/plain was
						// handled, so csv/markdown/pdf were skipped and never seen by the
						// agent (#10714).
						const isText =
							contentType.startsWith("text/") ||
							contentType.startsWith("application/json");
						const isPdf = contentType.startsWith("application/pdf");

						if (isText) {
							runtime.logger.debug(
								{ src: "service:message", documentUrl: attachment.url },
								"Processing text document",
							);

							const textContent = buffer.toString("utf8");
							processedAttachment.text = textContent;
							processedAttachment.title =
								processedAttachment.title || "Text File";

							runtime.logger.debug(
								{
									src: "service:message",
									textPreview: processedAttachment.text?.substring(0, 100),
								},
								"Extracted text content",
							);
						} else if (isPdf) {
							const { convertPdfToTextFromBuffer } = await import(
								"../../features/documents/utils.ts"
							);
							const textContent = await convertPdfToTextFromBuffer(
								buffer,
								processedAttachment.title ?? undefined,
							);
							processedAttachment.text = textContent;
							processedAttachment.title =
								processedAttachment.title || "PDF Document";

							runtime.logger.debug(
								{
									src: "service:message",
									textLength: textContent.length,
									textPreview: textContent.substring(0, 100),
								},
								"Extracted PDF text content",
							);
						} else {
							Object.assign(
								processedAttachment,
								attachmentFailure(
									"extract",
									"unsupported_type",
									false,
									`Unsupported document type (${contentType}); stored but text not extracted`,
								),
							);
							runtime.logger.warn(
								{ src: "service:message", contentType },
								"Skipping unsupported document type",
							);
						}
					} else if (
						attachment.contentType === ContentType.AUDIO &&
						!attachment.text
					) {
						runtime.logger.debug(
							{ src: "service:message", audioUrl: attachment.url },
							"Transcribing audio attachment",
						);

						try {
							// Fetch the bytes (remote → SSRF-guarded, size-capped) and pass
							// the buffer to the transcription model so it never fetches an
							// attacker-controlled URL itself.
							const { buffer } = await this.fetchAttachmentBytes(
								runtime,
								attachment.url,
								url,
								isRemote,
								byteBudget,
								attachment.size,
							);

							const transcript = await runtime.useModel(
								ModelType.TRANSCRIPTION,
								buffer,
							);

							if (typeof transcript === "string" && transcript.trim()) {
								processedAttachment.text = transcript.trim();
								processedAttachment.title =
									processedAttachment.title || "Audio";
								processedAttachment.description = `Transcript: ${transcript.trim()}`;

								runtime.logger.debug(
									{
										src: "service:message",
										transcriptPreview: processedAttachment.text?.substring(
											0,
											100,
										),
									},
									"Transcribed audio attachment",
								);
							} else {
								Object.assign(
									processedAttachment,
									attachmentFailure(
										"transcribe",
										"empty_result",
										false,
										"Audio transcription returned no text (empty or no speech detected)",
									),
								);
							}
						} catch (err) {
							// error-policy:J4 The attachment remains available with an
							// explicit failure state. Fetch-layer failures (MediaFetchError:
							// size cap, remote or local HTTP/stream error) happen before any TRANSCRIPTION
							// provider runs, so they get a transient could-not-fetch marker —
							// the "transcription unavailable" marker is reserved for genuine
							// provider failures because the read action treats it as
							// STT-is-disabled evidence.
							Object.assign(
								processedAttachment,
								err instanceof Error && err.name === "MediaFetchError"
									? attachmentFailure(
											err.message.includes("turn byte budget")
												? "budget"
												: "fetch",
											err.message.includes("turn byte budget")
												? "byte_limit"
												: "unavailable",
											true,
											"Audio attachment could not be fetched for enrichment",
										)
									: attachmentFailure(
											"transcribe",
											"unavailable",
											true,
											"Audio transcription unavailable",
										),
							);
							runtime.logger.warn(
								{
									src: "service:message",
									errorName: err instanceof Error ? err.name : "UnknownError",
								},
								"Audio transcription failed, continuing without transcript",
							);
							runtime.reportError(
								"MessageService.audioTranscription",
								sanitizedAttachmentDiagnostic(
									"ATTACHMENT_AUDIO_TRANSCRIPTION_FAILED",
									"Audio attachment enrichment failed",
									attachment,
								),
							);
						}
					} else if (
						attachment.contentType === ContentType.VIDEO &&
						!attachment.text
					) {
						runtime.logger.debug(
							{ src: "service:message", videoUrl: attachment.url },
							"Transcribing video attachment",
						);

						try {
							// Fetch the bytes (remote → SSRF-guarded, size-capped) and pass
							// the buffer to the transcription model so it never fetches an
							// attacker-controlled URL itself.
							const { buffer } = await this.fetchAttachmentBytes(
								runtime,
								attachment.url,
								url,
								isRemote,
								byteBudget,
								attachment.size,
							);

							const transcript = await runtime.useModel(
								ModelType.TRANSCRIPTION,
								buffer,
							);

							if (typeof transcript === "string" && transcript.trim()) {
								processedAttachment.text = transcript.trim();
								processedAttachment.title =
									processedAttachment.title || "Video";
								processedAttachment.description = `Transcript: ${transcript.trim()}`;

								runtime.logger.debug(
									{
										src: "service:message",
										transcriptPreview: processedAttachment.text?.substring(
											0,
											100,
										),
									},
									"Transcribed video attachment",
								);
							} else {
								Object.assign(
									processedAttachment,
									attachmentFailure(
										"transcribe",
										"empty_result",
										false,
										"Video transcription returned no text (empty or no speech detected)",
									),
								);
							}
						} catch (err) {
							// error-policy:J4 The attachment remains available with an
							// explicit failure state. Fetch-layer failures (MediaFetchError:
							// size cap, remote or local HTTP/stream error) happen before any TRANSCRIPTION
							// provider runs, so they get a transient could-not-fetch marker —
							// the "transcription unavailable" marker is reserved for genuine
							// provider failures because the read action treats it as
							// STT-is-disabled evidence.
							Object.assign(
								processedAttachment,
								err instanceof Error && err.name === "MediaFetchError"
									? attachmentFailure(
											err.message.includes("turn byte budget")
												? "budget"
												: "fetch",
											err.message.includes("turn byte budget")
												? "byte_limit"
												: "unavailable",
											true,
											"Video attachment could not be fetched for enrichment",
										)
									: attachmentFailure(
											"transcribe",
											"unavailable",
											true,
											"Video transcription unavailable",
										),
							);
							runtime.logger.warn(
								{
									src: "service:message",
									errorName: err instanceof Error ? err.name : "UnknownError",
								},
								"Video transcription failed, continuing without transcript",
							);
							runtime.reportError(
								"MessageService.videoTranscription",
								sanitizedAttachmentDiagnostic(
									"ATTACHMENT_VIDEO_TRANSCRIPTION_FAILED",
									"Video attachment enrichment failed",
									attachment,
								),
							);
						}
					}

					return processedAttachment;
				} catch (err) {
					// error-policy:J4 Preserve the original attachment with an
					// explicit retry signal while reporting enrichment failure.
					// One bad attachment must never drop the others or the message text.
					// Degrade to the un-enriched attachment (marking remote ones
					// ephemeral so the UI can offer a retry) and keep processing.
					runtime.logger.warn(
						{
							src: "service:message",
							attachmentId: attachment.id,
							errorName: err instanceof Error ? err.name : "UnknownError",
						},
						"Attachment processing failed; keeping un-enriched attachment",
					);
					runtime.reportError(
						"MessageService.attachmentEnrichment",
						sanitizedAttachmentDiagnostic(
							"ATTACHMENT_ENRICHMENT_FAILED",
							"Attachment enrichment failed",
							attachment,
						),
					);
					return {
						...attachment,
						...attachmentFailure(
							"extract",
							"unavailable",
							true,
							"Attachment enrichment unavailable",
						),
						ephemeral: isRemote ? true : attachment.ephemeral,
					};
				}
			})();
			processedAttachments.push(processed);
		}

		return processedAttachments;
	}

	/**
	 * Fetch an attachment's bytes for enrichment with a hard size cap. Remote
	 * (attacker-influenceable) URLs go through the SSRF-guarded fetcher, which
	 * blocks private/loopback/link-local hosts; trusted local media-store URLs
	 * (built from a path-validated relative URL) use the runtime fetch. This is
	 * the ONLY place a raw fetch is used during attachment enrichment. Both
	 * branches fail only with typed MediaFetchError carrying static prose
	 * (numeric HTTP status, never statusText), so the transcription catch
	 * blocks can classify every byte-fetch failure as transient could-not-fetch
	 * — the transcription-unavailable marker must never be forged by a fetch
	 * that failed before any TRANSCRIPTION provider ran. Bodies are read
	 * through the shared streaming cap, cancelling at the limit instead of
	 * materializing an oversize payload first.
	 */
	async fetchAttachmentBytes(
		runtime: IAgentRuntime,
		rawUrl: string,
		resolvedLocalUrl: string,
		isRemote: boolean,
		budget: AttachmentByteBudget,
		expectedBytes?: number,
	): Promise<{ buffer: Buffer; contentType: string }> {
		if (budget.remaining <= 0) {
			throw new MediaFetchError(
				"max_bytes",
				"Attachment turn byte budget exhausted",
			);
		}
		const maxBytes = Math.min(ATTACHMENT_FETCH_MAX_BYTES, budget.remaining);
		if (
			typeof expectedBytes === "number" &&
			Number.isFinite(expectedBytes) &&
			expectedBytes > maxBytes
		) {
			throw new MediaFetchError(
				"max_bytes",
				expectedBytes > budget.remaining
					? "Attachment exceeds turn byte budget"
					: `Attachment exceeds ${ATTACHMENT_FETCH_MAX_BYTES} bytes`,
			);
		}
		if (isRemote) {
			const { buffer, contentType } = await fetchRemoteMedia({
				url: rawUrl,
				maxBytes,
			});
			budget.remaining -= Math.max(buffer.byteLength, expectedBytes ?? 0);
			return {
				buffer,
				contentType: contentType ?? "application/octet-stream",
			};
		}
		const runtimeFetch = runtime.fetch ?? globalThis.fetch;
		try {
			const res = await runtimeFetch(resolvedLocalUrl);
			if (!res.ok) {
				// Only the numeric status: statusText is dynamic prose (a local
				// 503 could carry "TRANSCRIPTION not available") and must never
				// reach the catch blocks that key on unavailability wording.
				throw new MediaFetchError(
					"http_error",
					`Failed to fetch attachment locally (HTTP ${res.status})`,
				);
			}
			// Reject on the declared size before reading; the streamed read below
			// cancels at the cap when the header is absent or lying.
			const declaredLength = Number(res.headers.get("content-length"));
			if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
				throw new MediaFetchError(
					"max_bytes",
					declaredLength > budget.remaining
						? "Attachment exceeds turn byte budget"
						: `Attachment exceeds ${ATTACHMENT_FETCH_MAX_BYTES} bytes`,
				);
			}
			const contentType =
				res.headers.get("content-type") || "application/octet-stream";
			const buffer = await readResponseWithLimit(res, maxBytes);
			budget.remaining -= Math.max(buffer.byteLength, expectedBytes ?? 0);
			return { buffer, contentType };
		} catch (err) {
			// error-policy:J2 typed transient-class rethrow covering the whole
			// local read boundary (fetch, header reads, body read): every local
			// byte-fetch failure surfaces as MediaFetchError so the audio/video
			// catch blocks write the transient could-not-fetch marker, never the
			// transcription-unavailable one. Matched by name rather than
			// instanceof so the pass-through survives module duplication across
			// the multi-target build and test mocks.
			if (err instanceof Error && err.name === "MediaFetchError") throw err;
			throw new MediaFetchError(
				"fetch_failed",
				"Failed to fetch attachment locally",
				err,
			);
		}
	}
}
