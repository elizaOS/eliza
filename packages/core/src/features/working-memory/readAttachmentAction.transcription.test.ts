/**
 * On-demand transcription coverage for ATTACHMENT action=read on audio/video
 * records with no stored transcript. Deterministic harness — a hand-rolled
 * runtime stub scripts the TRANSCRIPTION call, and core's SSRF-guarded media
 * fetch (the network boundary) is module-mocked; no live model, no network.
 *
 * Regression under test (observed live, trajectories tj-cd2aadf98b0cc7 /
 * tj-cd524c1a710c6a): a video posted while cloud STT was gated off stored no
 * transcript, and every later "can you see that video?" / "can you get one?"
 * dead-ended on the canned "I don't have a transcript for that attachment
 * yet." Contract points (3–6 hardened per #18413):
 *   1. the read path retries transcription live — fetching bytes through the
 *      guarded, size-capped, 30s-bounded fetch and handing the provider a
 *      Buffer (the ingest call shape);
 *   2. provider-unavailable failures report "speech-to-text isn't enabled"
 *      honestly, without leaking internal error prose;
 *   3. TRANSIENT failures (network blip, provider 5xx, fetch-layer errors —
 *      whose messages can echo a hostile remote body) keep the retryable
 *      open-ended "yet" reply — they must NOT claim STT is disabled, live or
 *      via a stored ingest marker: the CURRENT attempt is authoritative, so
 *      ANY stored notProcessed note (the anchored unavailable marker
 *      included, because older rows may have anchored transient 5xxs) is
 *      cleared durably and only a typed-unavailable failure from THIS attempt
 *      re-marks the record;
 *   4. ONLY the canonical media-store shape (`/api/media/<sha256>.<ext>`)
 *      reaches the trusted local runtime fetch — bounded by an abort signal —
 *      and any other non-http(s) url (userinfo tricks like `@host/...`,
 *      protocol-relative `//host/...`) is rejected without fetching anything;
 *   5. every current outcome is merged durably into the owning memory under
 *      the room writer lease: success stores a transcript, transient/empty
 *      retries clear historical markers, and persistence rejection fails the
 *      action instead of claiming success; redacted variants never persist;
 *   6. (#18429) the local branch rejects an oversize attachment on the
 *      declared content-length BEFORE allocating the body, streams the body
 *      under the byte cap when the header is absent or lying (cancelling at
 *      the cap instead of materializing the payload), and its errors — fetch,
 *      header, or body read — are always transient-class (never
 *      STT-unavailability evidence, whatever the statusText or body-read
 *      prose says); a re-attempt supersedes any stale failure note — latest
 *      outcome wins.
 */
import { v4 as uuidv4 } from "uuid";
import { describe, expect, it, vi } from "vitest";
import { RoomHandlerQueue } from "../../runtime/room-handler-queue.ts";
import type {
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Media,
	Memory,
	UUID,
} from "../../types/index.ts";
import { ContentType, ModelType } from "../../types/index.ts";

// Only the network-touching remote fetcher is mocked; the module's other
// exports (MediaFetchError, the shared streaming cap reader) stay real so the
// local-branch read path under test runs its actual code.
const fetchRemoteMediaMock = vi.fn();
vi.mock("../../media/fetch.ts", async (importActual) => ({
	...(await importActual<typeof import("../../media/fetch.ts")>()),
	fetchRemoteMedia: (...args: unknown[]) => fetchRemoteMediaMock(...args),
}));

const { readAttachmentAction } = await import("./readAttachmentAction.ts");

const VIDEO_URL =
	"https://cdn.discordapp.com/attachments/123/456/snaptik_video.mp4";
/** 64-hex sha256 matching the strict media-store filename shape. */
const STORED_SHA = "0a1b2c3d".repeat(8);
const VIDEO_BYTES = Buffer.from("fake-video-bytes");
const TRANSCRIPT = "hello from the tiktok video about home servers";
const ANSWER = "It's a short clip about home servers.";

function makeVideoAttachment(overrides: Partial<Media> = {}): Media {
	return {
		id: "video-attachment-1",
		url: VIDEO_URL,
		title: "snaptik_video.mp4",
		source: "discord",
		contentType: ContentType.VIDEO,
		...overrides,
	};
}

type UseModelCall = { modelType: unknown; options: unknown };
type ReportedError = { scope: string; error: unknown };
type MemoryUpdate = Partial<Memory> & { id: UUID };

function makeRuntime(params: {
	agentId: UUID;
	calls: UseModelCall[];
	transcription: (input: unknown) => Promise<string>;
	roomHandlerQueue?: RoomHandlerQueue;
	localFetch?: (input: unknown, init?: RequestInit) => Promise<Response>;
	getMemoryById?: (id: UUID) => Promise<Memory | null>;
	updateMemory?: (patch: MemoryUpdate) => Promise<boolean>;
	reportedErrors?: ReportedError[];
}): IAgentRuntime {
	const runtime = {
		agentId: params.agentId,
		roomHandlerQueue:
			params.roomHandlerQueue ??
			new RoomHandlerQueue({ asyncContext: "explicit" }),
		fetch: params.localFetch,
		getConversationLength: () => 8,
		getMemories: async () => [],
		getMemoryById: params.getMemoryById ?? (async () => null),
		updateMemory: params.updateMemory ?? (async () => true),
		getRoom: async () => null,
		getWorld: async () => null,
		getService: () => null,
		getSetting: () => undefined,
		reportError: (scope: string, error: unknown) => {
			params.reportedErrors?.push({ scope, error });
		},
		useModel: async (modelType: unknown, options: unknown) => {
			params.calls.push({ modelType, options });
			if (modelType === ModelType.TRANSCRIPTION) {
				return params.transcription(options);
			}
			return ANSWER;
		},
	};
	return runtime as unknown as IAgentRuntime;
}

async function runRead(params: {
	attachment: Media;
	transcription: (input: unknown) => Promise<string>;
	fetchImpl?: () => Promise<{ buffer: Buffer }>;
	localFetch?: (input: unknown, init?: RequestInit) => Promise<Response>;
	getMemoryById?: (id: UUID, owner: Memory) => Promise<Memory | null>;
	updateMemory?: (patch: MemoryUpdate) => Promise<boolean>;
	reportedErrors?: ReportedError[];
	roomHandlerQueue?: RoomHandlerQueue;
	handlerOptions?: Partial<HandlerOptions>;
	text?: string;
}) {
	fetchRemoteMediaMock.mockReset();
	fetchRemoteMediaMock.mockImplementation(
		params.fetchImpl ?? (async () => ({ buffer: VIDEO_BYTES })),
	);
	const agentId = uuidv4() as UUID;
	const message: Memory = {
		id: uuidv4() as UUID,
		agentId,
		entityId: uuidv4() as UUID,
		roomId: uuidv4() as UUID,
		createdAt: Date.now(),
		content: {
			text: params.text ?? "can you see that video?",
			source: "discord",
			attachments: [params.attachment],
		},
	};
	let storedMemory = structuredClone(message);
	const calls: UseModelCall[] = [];
	const getMemoryById = params.getMemoryById;
	const runtime = makeRuntime({
		agentId,
		calls,
		transcription: params.transcription,
		roomHandlerQueue: params.roomHandlerQueue,
		localFetch: params.localFetch,
		getMemoryById: getMemoryById
			? (id) => getMemoryById(id, structuredClone(storedMemory))
			: async (id) =>
					id === storedMemory.id ? structuredClone(storedMemory) : null,
		updateMemory:
			params.updateMemory ??
			(async (patch) => {
				storedMemory = {
					...storedMemory,
					...patch,
					content: patch.content
						? structuredClone(patch.content)
						: storedMemory.content,
				};
				return true;
			}),
		reportedErrors: params.reportedErrors,
	});
	const callbackTexts: string[] = [];
	const callback: HandlerCallback = async (content) => {
		if (typeof content?.text === "string") callbackTexts.push(content.text);
		return [];
	};
	const result = await readAttachmentAction.handler?.(
		runtime,
		message,
		undefined,
		{
			...params.handlerOptions,
			parameters: { action: "read", attachmentId: params.attachment.id },
		},
		callback,
	);
	return { result, callbackTexts, calls, message, storedMemory };
}

describe("ATTACHMENT read on-demand transcription", () => {
	it("fetches bytes through the guarded capped fetch and answers from the transcript", async () => {
		let providerInput: unknown;
		const { result, callbackTexts, calls } = await runRead({
			attachment: makeVideoAttachment(),
			transcription: async (input) => {
				providerInput = input;
				return TRANSCRIPT;
			},
		});

		expect(result?.success).toBe(true);
		expect(callbackTexts).toEqual([ANSWER]);
		// The bytes came through the SSRF-guarded, size-capped media fetch,
		// bounded at the pre-rework 30s so a stalled host cannot hang the turn.
		expect(fetchRemoteMediaMock).toHaveBeenCalledTimes(1);
		const fetchArgs = fetchRemoteMediaMock.mock.calls[0]?.[0] as {
			url?: string;
			maxBytes?: number;
			timeoutMs?: number;
		};
		expect(fetchArgs?.url).toBe(VIDEO_URL);
		expect(fetchArgs?.maxBytes).toBe(50 * 1024 * 1024);
		expect(fetchArgs?.timeoutMs).toBe(30_000);
		// The provider received the buffer (ingest call shape), not a URL.
		expect(Buffer.isBuffer(providerInput)).toBe(true);
		// The answering TEXT_SMALL prompt saw the fresh transcript.
		const answerCall = calls.find((c) => c.modelType === ModelType.TEXT_SMALL);
		expect((answerCall?.options as { prompt?: string })?.prompt).toContain(
			TRANSCRIPT,
		);
	});

	it("reports honest unavailability when no TRANSCRIPTION provider can serve", async () => {
		const unavailable = new Error(
			"Eliza Cloud STT is not available — falling through to next TRANSCRIPTION handler",
		);
		unavailable.name = "CloudSttUnavailableError";
		const { result, callbackTexts } = await runRead({
			attachment: makeVideoAttachment(),
			transcription: async () => {
				throw unavailable;
			},
		});

		expect(result?.success).toBe(true);
		expect(callbackTexts).toHaveLength(1);
		expect(callbackTexts[0]).toContain("speech-to-text isn't enabled");
		// Never leak the internal provider prose.
		expect(callbackTexts[0]).not.toContain("falling through");
		expect(callbackTexts[0]).not.toContain("Eliza Cloud");
	});

	it("keeps the retryable 'yet' reply on a TRANSIENT provider failure", async () => {
		const { callbackTexts } = await runRead({
			attachment: makeVideoAttachment(),
			transcription: async () => {
				throw new Error("provider returned 502");
			},
		});

		expect(callbackTexts).toHaveLength(1);
		expect(callbackTexts[0]).toBe(
			"I don't have a transcript for that attachment yet.",
		);
		expect(callbackTexts[0]).not.toContain("isn't enabled");
	});

	it("keeps the retryable 'yet' reply when the media fetch itself fails", async () => {
		const { callbackTexts, calls } = await runRead({
			attachment: makeVideoAttachment(),
			transcription: async () => TRANSCRIPT,
			fetchImpl: async () => {
				throw new Error("fetch failed: connect timeout");
			},
		});

		expect(callbackTexts).toHaveLength(1);
		expect(callbackTexts[0]).toBe(
			"I don't have a transcript for that attachment yet.",
		);
		// The provider was never reached.
		expect(
			calls.filter((c) => c.modelType === ModelType.TRANSCRIPTION),
		).toHaveLength(0);
	});

	it("routes a canonical media-store URL through the trusted local fetch, bounded at 30s", async () => {
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
		const localUrls: string[] = [];
		const localSignals: (AbortSignal | null | undefined)[] = [];
		let providerInput: unknown;
		try {
			const { result, callbackTexts } = await runRead({
				attachment: makeVideoAttachment({
					url: `/api/media/${STORED_SHA}.mp4`,
					title: "stored_clip.mp4",
				}),
				transcription: async (input) => {
					providerInput = input;
					return TRANSCRIPT;
				},
				localFetch: async (input, init) => {
					localUrls.push(String(input));
					localSignals.push(init?.signal);
					return new Response(VIDEO_BYTES);
				},
			});

			expect(result?.success).toBe(true);
			expect(callbackTexts).toEqual([ANSWER]);
			// The canonical relative content-store shape must never reach the
			// remote-only URL parser (it cannot parse, which dead-ended every
			// local attachment on the transient-"yet" reply pre-#18413).
			expect(fetchRemoteMediaMock).not.toHaveBeenCalled();
			expect(localUrls).toHaveLength(1);
			expect(localUrls[0]).toMatch(
				new RegExp(`^http://localhost:\\d+/api/media/${STORED_SHA}\\.mp4$`),
			);
			// The local branch is time-bounded like the remote branch: a 30s
			// timeout signal rides the fetch so a stalled local server cannot
			// hang the turn (asserted via the wiring, not by sleeping 30s).
			expect(timeoutSpy).toHaveBeenCalledWith(30_000);
			expect(localSignals[0]).toBeInstanceOf(AbortSignal);
			expect(localSignals[0]).toBe(timeoutSpy.mock.results[0]?.value);
			// The provider received the locally fetched bytes as a Buffer.
			expect(Buffer.isBuffer(providerInput)).toBe(true);
			expect((providerInput as Buffer).equals(VIDEO_BYTES)).toBe(true);
		} finally {
			timeoutSpy.mockRestore();
		}
	});

	// getLocalServerUrl is a bare `http://localhost:PORT${url}` concat, so
	// before #18429's shape validation a crafted non-http(s) url reached an
	// attacker host through the TRUSTED local fetch: `@attacker.example/x`
	// becomes `http://localhost:PORT@attacker.example/x` (userinfo trick).
	it.each([
		["userinfo trick", "@attacker.example/clip.mp4"],
		["protocol-relative", "//evil.example/clip.mp4"],
		["traversal off the media route", "/api/media/../../etc/passwd"],
	])(
		"refuses to fetch a non-media-store local url (%s) and keeps the 'yet' reply",
		async (_kind, url) => {
			const localCalls: string[] = [];
			const { result, callbackTexts, calls } = await runRead({
				attachment: makeVideoAttachment({ url }),
				transcription: async () => TRANSCRIPT,
				localFetch: async (input) => {
					localCalls.push(String(input));
					return {
						ok: true,
						status: 200,
						headers: new Headers(),
						arrayBuffer: async () => Uint8Array.from(VIDEO_BYTES).buffer,
					} as unknown as Response;
				},
			});

			expect(result?.success).toBe(true);
			// NOTHING was fetched: not the local/trusted path, not the remote one.
			expect(localCalls).toEqual([]);
			expect(fetchRemoteMediaMock).not.toHaveBeenCalled();
			expect(
				calls.filter((c) => c.modelType === ModelType.TRANSCRIPTION),
			).toHaveLength(0);
			// The rejection is transient-class: the reply stays the honest "yet".
			expect(callbackTexts).toEqual([
				"I don't have a transcript for that attachment yet.",
			]);
		},
	);

	it("rejects an oversize local attachment on content-length before reading the body", async () => {
		const arrayBufferSpy = vi.fn(
			async () => Uint8Array.from(VIDEO_BYTES).buffer,
		);
		const { callbackTexts, calls } = await runRead({
			attachment: makeVideoAttachment({
				url: `/api/media/${STORED_SHA}.mp4`,
				title: "stored_clip.mp4",
			}),
			transcription: async () => TRANSCRIPT,
			localFetch: async () =>
				({
					ok: true,
					status: 200,
					headers: new Headers({
						"content-length": String(50 * 1024 * 1024 + 1),
					}),
					arrayBuffer: arrayBufferSpy,
				}) as unknown as Response,
		});

		// The declared size alone rejects the fetch — the body is NEVER
		// allocated (remote-branch parity: fetchRemoteMedia also refuses on the
		// content-length header before reading).
		expect(arrayBufferSpy).not.toHaveBeenCalled();
		expect(
			calls.filter((c) => c.modelType === ModelType.TRANSCRIPTION),
		).toHaveLength(0);
		// The rejection is transient-class: the reply stays the honest "yet".
		expect(callbackTexts).toEqual([
			"I don't have a transcript for that attachment yet.",
		]);
	});

	it("still rejects an oversize local body when content-length is absent", async () => {
		const chunk = new Uint8Array(8 * 1024 * 1024);
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(chunk);
			},
		});
		const { callbackTexts, calls } = await runRead({
			attachment: makeVideoAttachment({
				url: `/api/media/${STORED_SHA}.mp4`,
				title: "stored_clip.mp4",
			}),
			transcription: async () => TRANSCRIPT,
			localFetch: async () => new Response(body),
		});

		expect(
			calls.filter((c) => c.modelType === ModelType.TRANSCRIPTION),
		).toHaveLength(0);
		expect(callbackTexts).toEqual([
			"I don't have a transcript for that attachment yet.",
		]);
	});

	it("cancels an oversize chunked local body at the cap without materializing it", async () => {
		// No content-length and a chunked body: the shared streaming reader must
		// count bytes and CANCEL at the cap — never buffer the whole payload
		// first. The 8 MiB chunk is reused, so the test itself allocates far
		// below the 50 MiB cap while the stream offers an unbounded body.
		const chunk = new Uint8Array(8 * 1024 * 1024);
		let pulls = 0;
		const cancelSpy = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				controller.enqueue(chunk);
			},
			cancel: cancelSpy,
		});
		const arrayBufferSpy = vi.fn(async () => new ArrayBuffer(0));
		const { callbackTexts, calls } = await runRead({
			attachment: makeVideoAttachment({
				url: `/api/media/${STORED_SHA}.mp4`,
				title: "stored_clip.mp4",
			}),
			transcription: async () => TRANSCRIPT,
			localFetch: async () =>
				({
					ok: true,
					status: 200,
					headers: new Headers(),
					body,
					arrayBuffer: arrayBufferSpy,
				}) as unknown as Response,
		});

		// Reading stopped as soon as the byte counter crossed 50 MiB — the 7th
		// 8 MiB chunk (56 MiB) trips the cap — and the stream was cancelled.
		expect(cancelSpy).toHaveBeenCalled();
		expect(pulls).toBeLessThanOrEqual(8);
		expect(arrayBufferSpy).not.toHaveBeenCalled();
		expect(
			calls.filter((c) => c.modelType === ModelType.TRANSCRIPTION),
		).toHaveLength(0);
		expect(callbackTexts).toEqual([
			"I don't have a transcript for that attachment yet.",
		]);
	});

	it("keeps the retryable 'yet' reply when the local body read rejects with unavailability-looking prose", async () => {
		// The whole local response read boundary (fetch + headers + body) is
		// wrapped in the typed transient error: even a body read that rejects
		// with unavailability-looking text must not reach the classifier and
		// forge the "isn't enabled" reply.
		const { callbackTexts, calls } = await runRead({
			attachment: makeVideoAttachment({
				url: `/api/media/${STORED_SHA}.mp4`,
				title: "stored_clip.mp4",
			}),
			transcription: async () => TRANSCRIPT,
			localFetch: async () =>
				({
					ok: true,
					status: 200,
					headers: new Headers(),
					body: new ReadableStream<Uint8Array>({
						pull() {
							throw new Error(
								"TRANSCRIPTION not available — falling through to next TRANSCRIPTION handler",
							);
						},
					}),
				}) as unknown as Response,
		});

		expect(
			calls.filter((c) => c.modelType === ModelType.TRANSCRIPTION),
		).toHaveLength(0);
		expect(callbackTexts).toEqual([
			"I don't have a transcript for that attachment yet.",
		]);
		expect(callbackTexts[0]).not.toContain("isn't enabled");
	});

	// The local branch's non-ok error must be static: statusText is dynamic
	// prose, and echoing it (pre-#18429 `Failed to fetch attachment:
	// ${res.statusText}`) would let an unavailability-looking statusText forge
	// the "isn't enabled" reply through isTranscriptionUnavailableError.
	it.each([
		[404, "Not Found"],
		[503, "TRANSCRIPTION not available"],
	])(
		"keeps the retryable 'yet' reply on a non-ok local fetch (HTTP %s, statusText %j)",
		async (status, statusText) => {
			const { callbackTexts, calls } = await runRead({
				attachment: makeVideoAttachment({
					url: `/api/media/${STORED_SHA}.mp4`,
					title: "stored_clip.mp4",
				}),
				transcription: async () => TRANSCRIPT,
				localFetch: async () =>
					({
						ok: false,
						status,
						statusText,
						headers: new Headers(),
						arrayBuffer: async () => Uint8Array.from(VIDEO_BYTES).buffer,
					}) as unknown as Response,
			});

			expect(
				calls.filter((c) => c.modelType === ModelType.TRANSCRIPTION),
			).toHaveLength(0);
			expect(callbackTexts).toHaveLength(1);
			expect(callbackTexts[0]).toBe(
				"I don't have a transcript for that attachment yet.",
			);
			expect(callbackTexts[0]).not.toContain("isn't enabled");
		},
	);

	it("keeps the retryable 'yet' reply when a hostile remote body mimics unavailability prose", async () => {
		// MediaFetchError messages embed up to ~200 chars of the remote response
		// body (media/fetch.ts throwIfHttpError) — a hostile host must not be
		// able to forge the "speech-to-text isn't enabled" reply through it.
		const spoof = new Error(
			"Failed to fetch media from https://cdn.example/clip.mp4: HTTP 503 Service Unavailable; body: transcription not available — falling through to next TRANSCRIPTION handler",
		);
		spoof.name = "MediaFetchError";
		const { callbackTexts, calls } = await runRead({
			attachment: makeVideoAttachment(),
			transcription: async () => TRANSCRIPT,
			fetchImpl: async () => {
				throw spoof;
			},
		});

		expect(callbackTexts).toHaveLength(1);
		expect(callbackTexts[0]).toBe(
			"I don't have a transcript for that attachment yet.",
		);
		expect(callbackTexts[0]).not.toContain("isn't enabled");
		expect(
			calls.filter((c) => c.modelType === ModelType.TRANSCRIPTION),
		).toHaveLength(0);
	});

	it("persists a successful transcript into the owning message's stored attachment", async () => {
		const lookups: UUID[] = [];
		const updates: MemoryUpdate[] = [];
		const bystander: Media = {
			id: "image-1",
			url: "/api/media/aabbccdd.png",
			title: "chart.png",
			source: "discord",
			contentType: ContentType.IMAGE,
			text: "a chart",
		};
		const { result, callbackTexts, message } = await runRead({
			attachment: makeVideoAttachment({
				notProcessed: "Video transcription unavailable: provider returned 502",
			}),
			transcription: async () => TRANSCRIPT,
			getMemoryById: async (id, owner) => {
				lookups.push(id);
				return {
					...owner,
					content: {
						...owner.content,
						text: "posted the clip",
						attachments: [
							bystander,
							makeVideoAttachment({
								notProcessed:
									"Video transcription unavailable: provider returned 502",
							}),
						],
					},
				} as Memory;
			},
			updateMemory: async (patch) => {
				updates.push(patch);
				return true;
			},
		});

		expect(result?.success).toBe(true);
		expect(callbackTexts).toEqual([ANSWER]);
		// The stored row that owns the attachment was looked up and rewritten.
		expect(lookups).toEqual([message.id]);
		expect(updates).toHaveLength(1);
		expect(updates[0]?.id).toBe(message.id);
		const persisted = updates[0]?.content?.attachments as Media[];
		expect(persisted).toHaveLength(2);
		// Only the owning attachment entry changed.
		expect(persisted[0]).toEqual(bystander);
		const video = persisted[1] as Media;
		expect(video.id).toBe("video-attachment-1");
		expect(video.text).toBe(TRANSCRIPT);
		expect(video.description).toBe(`Transcript: ${TRANSCRIPT}`);
		expect(video.url).toBe(VIDEO_URL);
		expect(video.title).toBe("snaptik_video.mp4");
		// The stale failure marker is gone, not merely blanked.
		expect("notProcessed" in video).toBe(false);
		// Gathering-layer transport fields never reach storage.
		expect("_messageId" in video).toBe(false);
		expect("_createdAt" in video).toBe(false);
	});

	it("fails closed when transcript persistence throws", async () => {
		const reportedErrors: ReportedError[] = [];
		const { result, callbackTexts } = await runRead({
			attachment: makeVideoAttachment(),
			transcription: async () => TRANSCRIPT,
			getMemoryById: async (_id, owner) =>
				({
					...owner,
					content: { attachments: [makeVideoAttachment()] },
				}) as Memory,
			updateMemory: async () => {
				throw new Error("database offline");
			},
			reportedErrors,
		});

		expect(result?.success).toBe(false);
		expect(callbackTexts).toEqual([
			"I couldn't read that attachment right now.",
		]);
		expect(reportedErrors).toHaveLength(1);
		expect(reportedErrors[0]?.scope).toBe("ReadAttachmentAction.handler");
		expect(result?.error).toBe(
			"Failed to persist attachment transcription state",
		);
	});

	it("fails closed when the adapter declines the update", async () => {
		const reportedErrors: ReportedError[] = [];
		const { result, callbackTexts } = await runRead({
			attachment: makeVideoAttachment({
				notProcessed: "Video transcription unavailable: historical failure",
			}),
			transcription: async () => "",
			updateMemory: async () => false,
			reportedErrors,
		});

		expect(result?.success).toBe(false);
		expect(result?.error).toBe("Attachment transcription update was declined");
		expect(callbackTexts).toEqual([
			"I couldn't read that attachment right now.",
		]);
		expect(reportedErrors).toHaveLength(1);
		expect(reportedErrors[0]?.scope).toBe("ReadAttachmentAction.handler");
	});

	it.each(["owner memory", "attachment"] as const)(
		"fails closed when the %s disappears before persistence",
		async (missing) => {
			const reportedErrors: ReportedError[] = [];
			const { result, callbackTexts } = await runRead({
				attachment: makeVideoAttachment(),
				transcription: async () => TRANSCRIPT,
				getMemoryById: async (_id, owner) =>
					missing === "owner memory"
						? null
						: {
								...owner,
								content: { ...owner.content, attachments: [] },
							},
				reportedErrors,
			});

			expect(result?.success).toBe(false);
			expect(callbackTexts).toEqual([
				"I couldn't read that attachment right now.",
			]);
			expect(reportedErrors).toHaveLength(1);
			expect(reportedErrors[0]?.scope).toBe("ReadAttachmentAction.handler");
			expect(result?.error).toMatch(/disappeared|no longer has attachments/i);
		},
	);

	it("fails closed when the stored attachment URL changes before persistence", async () => {
		const reportedErrors: ReportedError[] = [];
		const updates: MemoryUpdate[] = [];
		const { result, callbackTexts } = await runRead({
			attachment: makeVideoAttachment(),
			transcription: async () => TRANSCRIPT,
			getMemoryById: async (_id, owner) =>
				({
					...owner,
					content: {
						...owner.content,
						attachments: [
							makeVideoAttachment({
								url: "https://cdn.example/replacement.mp4",
							}),
						],
					},
				}) as Memory,
			updateMemory: async (patch) => {
				updates.push(patch);
				return true;
			},
			reportedErrors,
		});

		expect(result?.success).toBe(false);
		expect(result?.error).toMatch(/disappeared/i);
		expect(callbackTexts).toEqual([
			"I couldn't read that attachment right now.",
		]);
		expect(updates).toEqual([]);
		expect(reportedErrors).toHaveLength(1);
	});

	it("never persists a redacted variant's transcript over the stored original", async () => {
		// selectAttachmentForRequester hands a redacted-disclosure viewer a
		// variant keeping the shared id/_messageId but with `url` swapped to the
		// redacted bytes and text/description stripped — so its on-demand
		// transcript is derived from the REDACTED media and must never be
		// written over the original entry's stored transcript.
		const lookups: UUID[] = [];
		const updates: MemoryUpdate[] = [];
		const redactedVariant = {
			...makeVideoAttachment({
				url: "https://cdn.discordapp.com/attachments/123/456/redacted_clip.mp4",
			}),
			redacted: true as const,
		};
		const { result, callbackTexts } = await runRead({
			attachment: redactedVariant,
			transcription: async () => TRANSCRIPT,
			getMemoryById: async (id) => {
				lookups.push(id);
				return {
					id,
					entityId: id,
					roomId: id,
					content: {
						attachments: [
							makeVideoAttachment({ text: "the original's real transcript" }),
						],
					},
				} as Memory;
			},
			updateMemory: async (patch) => {
				updates.push(patch);
				return true;
			},
		});

		// The in-memory transcript still serves this reply; only the write is
		// skipped.
		expect(result?.success).toBe(true);
		expect(callbackTexts).toEqual([ANSWER]);
		expect(lookups).toEqual([]);
		expect(updates).toEqual([]);
	});

	it("never overwrites a stored entry that already has a transcript (fill-only)", async () => {
		// A concurrent read (or a variant whose gathered copy lost the text)
		// must not clobber a transcript that already reached storage.
		const updates: MemoryUpdate[] = [];
		const { result, callbackTexts } = await runRead({
			attachment: makeVideoAttachment(),
			transcription: async () => TRANSCRIPT,
			getMemoryById: async (_id, owner) =>
				({
					...owner,
					content: {
						...owner.content,
						attachments: [
							makeVideoAttachment({ text: "an earlier stored transcript" }),
						],
					},
				}) as Memory,
			updateMemory: async (patch) => {
				updates.push(patch);
				return true;
			},
		});

		expect(result?.success).toBe(true);
		expect(callbackTexts).toEqual([ANSWER]);
		expect(updates).toEqual([]);
	});

	it("serializes sibling transcript merges with unrelated owning-memory updates", async () => {
		fetchRemoteMediaMock.mockReset();
		fetchRemoteMediaMock.mockImplementation(
			async (options: { url: string }) => ({
				buffer: Buffer.from(options.url, "utf8"),
			}),
		);
		const queue = new RoomHandlerQueue({ asyncContext: "explicit" });
		const agentId = uuidv4() as UUID;
		const roomId = uuidv4() as UUID;
		const ownerId = uuidv4() as UUID;
		const entityId = uuidv4() as UUID;
		const attachmentA = makeVideoAttachment({
			id: "video-a",
			url: "https://cdn.example/a.mp4",
			title: "a.mp4",
		});
		const attachmentB = makeVideoAttachment({
			id: "video-b",
			url: "https://cdn.example/b.mp4",
			title: "b.mp4",
		});
		const owner: Memory = {
			id: ownerId,
			agentId,
			entityId,
			roomId,
			createdAt: Date.now(),
			content: {
				text: "original owning-memory text",
				source: "discord",
				attachments: [attachmentA, attachmentB],
			},
		};
		let storedMemory = structuredClone(owner);
		let activeReads = 0;
		let maxActiveReads = 0;
		const calls: UseModelCall[] = [];
		const runtime = makeRuntime({
			agentId,
			calls,
			roomHandlerQueue: queue,
			transcription: async (input) => {
				const source = (input as Buffer).toString("utf8");
				return source.endsWith("/a.mp4") ? "transcript-a" : "transcript-b";
			},
			getMemoryById: async (id) => {
				if (id !== ownerId) return null;
				activeReads += 1;
				maxActiveReads = Math.max(maxActiveReads, activeReads);
				const snapshot = structuredClone(storedMemory);
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				activeReads -= 1;
				return snapshot;
			},
			updateMemory: async (patch) => {
				await Promise.resolve();
				storedMemory = {
					...storedMemory,
					...patch,
					content: patch.content
						? structuredClone(patch.content)
						: storedMemory.content,
				};
				return true;
			},
		});
		const handler = readAttachmentAction.handler;
		expect(handler).toBeDefined();
		if (!handler) throw new Error("ATTACHMENT handler is missing");
		const invoke = (
			attachment: Media,
			lease: HandlerOptions["roomHandlerLease"],
		) =>
			handler(
				runtime,
				{
					...owner,
					content: {
						...owner.content,
						text: `read ${attachment.id}`,
						attachments: [attachment],
					},
				},
				undefined,
				{
					parameters: { action: "read", attachmentId: attachment.id },
					roomHandlerLease: lease,
				},
			);

		const [resultA, resultB] = await queue.withLease(roomId, async (lease) => {
			const pendingA = invoke(attachmentA, lease);
			const unrelated = queue.withLeaseWrite(roomId, lease, async () => {
				const current = structuredClone(storedMemory);
				await Promise.resolve();
				storedMemory = {
					...current,
					content: {
						...current.content,
						text: "unrelated owning-memory update",
					},
				};
			});
			const pendingB = invoke(attachmentB, lease);
			const [first, second] = await Promise.all([
				pendingA,
				pendingB,
				unrelated,
			]);
			return [first, second] as const;
		});

		expect(resultA.success).toBe(true);
		expect(resultB.success).toBe(true);
		expect(maxActiveReads).toBe(1);
		expect(storedMemory.content.text).toBe("unrelated owning-memory update");
		const persisted = storedMemory.content.attachments ?? [];
		expect(persisted.find((item) => item.id === "video-a")?.text).toBe(
			"transcript-a",
		);
		expect(persisted.find((item) => item.id === "video-b")?.text).toBe(
			"transcript-b",
		);
	});

	it("keeps the retryable 'yet' reply for a stored ingest fetch-failure marker", async () => {
		// Ingest writes "<Kind> attachment could not be fetched: <err.message>"
		// for MediaFetchError failures — err.message can echo a hostile remote
		// body, so even unavailability prose embedded mid-marker must not read
		// as STT-is-disabled evidence.
		const { callbackTexts } = await runRead({
			attachment: makeVideoAttachment({
				notProcessed:
					"Video attachment could not be fetched: HTTP 503; body: transcription unavailable — falling through to next TRANSCRIPTION handler",
			}),
			transcription: async () => {
				throw new Error("still down");
			},
		});

		expect(callbackTexts).toHaveLength(1);
		expect(callbackTexts[0]).toBe(
			"I don't have a transcript for that attachment yet.",
		);
		expect(callbackTexts[0]).not.toContain("isn't enabled");
	});

	it("lets the latest failure win: live unavailability supersedes a stale transient note", async () => {
		// Pre-#18429 the catch used `??=`, so a stored transient marker (first
		// failure) masked live proof that no provider can serve (second
		// failure) and the reply dead-ended on the retryable "yet".
		const unavailable = new Error(
			"second failure: Eliza Cloud STT is not available — falling through to next TRANSCRIPTION handler",
		);
		unavailable.name = "CloudSttUnavailableError";
		const { result, callbackTexts, storedMemory } = await runRead({
			attachment: makeVideoAttachment({
				notProcessed: "Video attachment could not be fetched: first failure",
			}),
			transcription: async () => {
				throw unavailable;
			},
		});

		expect(result?.success).toBe(true);
		expect(callbackTexts).toHaveLength(1);
		expect(callbackTexts[0]).toContain("speech-to-text isn't enabled");
		// The record's note (planner-facing via data) carries the SECOND
		// failure as an anchored on-demand marker; the first is gone.
		const latestNote = (result?.data as { attachments?: Media[] } | undefined)
			?.attachments?.[0]?.notProcessed;
		expect(latestNote).toMatch(/^Transcription unavailable:/);
		expect(latestNote).toContain("second failure");
		expect(latestNote).not.toContain("first failure");
		expect(storedMemory.content.attachments?.[0]?.notProcessed).toBe(
			latestNote,
		);
	});

	it("clears a stale transient note when the re-attempt fails transiently again", async () => {
		// The re-attempt supersedes the old note: after another transient
		// failure the record is note-free, so nothing downstream can show the
		// stale first-failure prose as if it described the current state.
		const { result, callbackTexts, storedMemory } = await runRead({
			attachment: makeVideoAttachment({
				notProcessed: "Video attachment could not be fetched: first failure",
			}),
			transcription: async () => {
				throw new Error("provider returned 502");
			},
		});

		expect(result?.success).toBe(true);
		expect(callbackTexts).toEqual([
			"I don't have a transcript for that attachment yet.",
		]);
		const attachments = (result?.data as { attachments?: Media[] } | undefined)
			?.attachments;
		expect(attachments?.[0]?.notProcessed).toBeUndefined();
		expect(storedMemory.content.attachments?.[0]?.notProcessed).toBeUndefined();
	});

	it("keeps the retryable 'yet' reply when a stored ingest unavailable marker meets a transient re-attempt", async () => {
		// Historical ingest code anchored ordinary provider failures too, so a
		// stored marker is history, not proof. The CURRENT attempt is
		// authoritative: when it fails transiently, the stale marker must not
		// resurface as "speech-to-text isn't enabled".
		const { result, callbackTexts, storedMemory } = await runRead({
			attachment: makeVideoAttachment({
				notProcessed:
					"Video transcription unavailable: Eliza Cloud STT is not available — falling through to next TRANSCRIPTION handler",
			}),
			transcription: async () => {
				throw new Error("still down");
			},
		});

		expect(callbackTexts).toHaveLength(1);
		expect(callbackTexts[0]).toBe(
			"I don't have a transcript for that attachment yet.",
		);
		expect(callbackTexts[0]).not.toContain("isn't enabled");
		const attachments = (result?.data as { attachments?: Media[] } | undefined)
			?.attachments;
		expect(attachments?.[0]?.notProcessed).toBeUndefined();
		expect(storedMemory.content.attachments?.[0]?.notProcessed).toBeUndefined();
	});

	it("does not resurrect a historical provider-5xx unavailable marker on a transient retry", async () => {
		// The ingest catch wrote "Video transcription unavailable: provider
		// returned 503" for a transient provider 503; the current attempt's 502
		// is equally transient, so the reply must stay the retryable "yet".
		const { result, callbackTexts, storedMemory } = await runRead({
			attachment: makeVideoAttachment({
				notProcessed: "Video transcription unavailable: provider returned 503",
			}),
			transcription: async () => {
				throw new Error("provider returned 502");
			},
		});

		expect(callbackTexts).toEqual([
			"I don't have a transcript for that attachment yet.",
		]);
		const attachments = (result?.data as { attachments?: Media[] } | undefined)
			?.attachments;
		expect(attachments?.[0]?.notProcessed).toBeUndefined();
		expect(storedMemory.content.attachments?.[0]?.notProcessed).toBeUndefined();
	});

	it("clears a stored unavailable marker when the re-attempt returns no speech", async () => {
		// An empty transcript is a successful current attempt with nothing to
		// say — the record ends note-free and the reply stays the open "yet",
		// never the stale marker's "isn't enabled".
		const { result, callbackTexts, storedMemory } = await runRead({
			attachment: makeVideoAttachment({
				notProcessed: "Video transcription unavailable: provider returned 503",
			}),
			transcription: async () => "",
		});

		expect(callbackTexts).toEqual([
			"I don't have a transcript for that attachment yet.",
		]);
		const attachments = (result?.data as { attachments?: Media[] } | undefined)
			?.attachments;
		expect(attachments?.[0]?.notProcessed).toBeUndefined();
		expect(storedMemory.content.attachments?.[0]?.notProcessed).toBeUndefined();
	});

	it("re-marks unavailability when the re-attempt of a marked record is typed-unavailable", async () => {
		// Genuine unavailability is not relabelled: a stored marker plus a
		// CURRENT typed-unavailable failure still reports "isn't enabled",
		// carrying the fresh attempt's note.
		const unavailable = new Error(
			"Eliza Cloud STT is not available — falling through to next TRANSCRIPTION handler",
		);
		unavailable.name = "CloudSttUnavailableError";
		const { result, callbackTexts } = await runRead({
			attachment: makeVideoAttachment({
				notProcessed: "Video transcription unavailable: provider returned 503",
			}),
			transcription: async () => {
				throw unavailable;
			},
		});

		expect(callbackTexts).toHaveLength(1);
		expect(callbackTexts[0]).toContain("speech-to-text isn't enabled");
		const latestNote = (result?.data as { attachments?: Media[] } | undefined)
			?.attachments?.[0]?.notProcessed;
		expect(latestNote).toMatch(/^Transcription unavailable:/);
		expect(latestNote).not.toContain("provider returned 503");
	});

	it("keeps the open-ended reply when transcription returns no speech", async () => {
		const { callbackTexts } = await runRead({
			attachment: makeVideoAttachment(),
			transcription: async () => "",
		});

		expect(callbackTexts).toHaveLength(1);
		expect(callbackTexts[0]).toBe(
			"I don't have a transcript for that attachment yet.",
		);
	});
});
