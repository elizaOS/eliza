/**
 * Bounded install-download reader for Agent Skills packages.
 * Cancels the response stream as soon as {@link MAX_SKILL_PACKAGE_BYTES} is
 * exceeded so a lying or missing Content-Length cannot force an unbounded
 * `arrayBuffer()` / `text()` allocation.
 */

import { ElizaError } from "@elizaos/core";

/** Maximum zip / SKILL.md download size (10MB). */
export const MAX_SKILL_PACKAGE_BYTES = 10 * 1024 * 1024;

/** Default wall-clock deadline shared by every request in one install. */
export const DEFAULT_SKILL_DOWNLOAD_TIMEOUT_MS = 30_000;

/** Largest delay Node can schedule without overflowing its timer implementation. */
export const MAX_SKILL_DOWNLOAD_TIMEOUT_MS = 2_147_483_647;

/** Per-install controls for the shared download lifecycle. */
export interface SkillDownloadLifecycleOptions {
	/** Abort the download when its caller no longer needs the result. */
	signal?: AbortSignal;
	/** Override the 30-second default deadline; `null` explicitly disables it. */
	downloadTimeoutMs?: number | null;
}

const SKILL_DOWNLOAD_ERROR_CODES = new Set([
	"SKILL_DOWNLOAD_ABORTED",
	"SKILL_DOWNLOAD_INVALID_TIMEOUT",
	"SKILL_DOWNLOAD_MISSING_BODY",
	"SKILL_DOWNLOAD_TIMEOUT",
	"SKILL_PACKAGE_INVALID_UTF8",
	"SKILL_PACKAGE_TOO_LARGE",
]);

/** One signal and deadline spanning every request and body read in an install. */
export interface SkillDownloadLifecycle {
	readonly signal: AbortSignal;
	readonly timeoutMs: number | null;
	dispose(): void;
	throwIfAborted(cause?: unknown): void;
}

function cancellationError(cause?: unknown): ElizaError {
	return new ElizaError("Skill download was cancelled by its caller", {
		code: "SKILL_DOWNLOAD_ABORTED",
		context: { boundary: "skill-package-download" },
		cause,
		severity: "ephemeral",
	});
}

function timeoutError(timeoutMs: number): ElizaError {
	return new ElizaError(
		`Skill download exceeded its ${timeoutMs}ms deadline`,
		{
			code: "SKILL_DOWNLOAD_TIMEOUT",
			context: { boundary: "skill-package-download", timeoutMs },
			severity: "ephemeral",
		},
	);
}

/** Normalize an aborted signal without replacing its authoritative typed reason. */
export function skillDownloadAbortError(
	signal: AbortSignal,
	cause?: unknown,
): ElizaError {
	return signal.reason instanceof ElizaError
		? signal.reason
		: cancellationError(cause ?? signal.reason);
}

/** Identify typed failures owned by the untrusted package-download boundary. */
export function isSkillDownloadError(error: unknown): error is ElizaError {
	return (
		error instanceof ElizaError && SKILL_DOWNLOAD_ERROR_CODES.has(error.code)
	);
}

/** Best-effort teardown for a response body the install will not consume. */
export function cancelUnusedSkillDownloadBody(
	response: Response,
	reason?: unknown,
): void {
	if (!response.body) return;
	try {
		const cancellation = response.body.cancel(reason);
		void Promise.resolve(cancellation).catch(() => {
			// error-policy:J6 rejection while discarding an unused response is teardown-only.
		});
	} catch {
		// error-policy:J6 synchronous cancellation of an unused response is teardown-only.
	}
}

/**
 * Create the single abort lifecycle used by one catalog, GitHub, or URL install.
 * The caller must dispose it immediately after all network bodies are consumed.
 */
export function createSkillDownloadLifecycle(
	options: SkillDownloadLifecycleOptions = {},
): SkillDownloadLifecycle {
	const timeoutMs =
		options.downloadTimeoutMs === undefined
			? DEFAULT_SKILL_DOWNLOAD_TIMEOUT_MS
			: options.downloadTimeoutMs;
	if (
		timeoutMs !== null &&
		(!Number.isInteger(timeoutMs) ||
			timeoutMs <= 0 ||
			timeoutMs > MAX_SKILL_DOWNLOAD_TIMEOUT_MS)
	) {
		throw new ElizaError(
			"Skill download timeout must be a positive bounded integer or null",
			{
				code: "SKILL_DOWNLOAD_INVALID_TIMEOUT",
				context: { downloadTimeoutMs: timeoutMs },
			},
		);
	}

	const controller = new AbortController();
	const abortFromCaller = (): void => {
		if (!controller.signal.aborted) {
			controller.abort(cancellationError(options.signal?.reason));
		}
	};
	if (options.signal?.aborted) {
		abortFromCaller();
	} else {
		options.signal?.addEventListener("abort", abortFromCaller, { once: true });
		// Close the check/listen race if the caller aborted between both steps.
		if (options.signal?.aborted) abortFromCaller();
	}

	const timeoutSignal =
		timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs);
	const abortFromTimeout = (): void => {
		if (!controller.signal.aborted && timeoutMs !== null) {
			controller.abort(timeoutError(timeoutMs));
		}
	};
	if (timeoutSignal?.aborted) {
		abortFromTimeout();
	} else {
		timeoutSignal?.addEventListener("abort", abortFromTimeout, { once: true });
	}

	return {
		signal: controller.signal,
		timeoutMs,
		dispose() {
			timeoutSignal?.removeEventListener("abort", abortFromTimeout);
			options.signal?.removeEventListener("abort", abortFromCaller);
		},
		throwIfAborted(cause?: unknown) {
			if (controller.signal.aborted) {
				throw skillDownloadAbortError(controller.signal, cause);
			}
		},
	};
}

/**
 * Read a skill install body under {@link MAX_SKILL_PACKAGE_BYTES}.
 * Throws `Package too large (max 10MB)` once the running total exceeds the cap.
 */
export async function readCappedSkillPackage(
	response: Response,
	options: { signal?: AbortSignal } = {},
): Promise<Uint8Array> {
	const tooLarge = (receivedBytes: number): ElizaError =>
		new ElizaError(
			`Package too large (max ${MAX_SKILL_PACKAGE_BYTES / 1024 / 1024}MB)`,
			{
				code: "SKILL_PACKAGE_TOO_LARGE",
				context: {
					boundary: "skill-package-download",
					maxBytes: MAX_SKILL_PACKAGE_BYTES,
					receivedBytes,
				},
			},
		);
	if (options.signal?.aborted) {
		cancelUnusedSkillDownloadBody(response, options.signal.reason);
		throw skillDownloadAbortError(options.signal);
	}
	const body = response.body;
	if (!body) {
		throw new ElizaError("Skill download response did not include a body", {
			code: "SKILL_DOWNLOAD_MISSING_BODY",
			context: { boundary: "skill-package-download" },
		});
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let removeAbortListener: (() => void) | undefined;
	const abortPromise = options.signal
		? new Promise<never>((_resolve, reject) => {
				const onAbort = (): void => {
					reject(skillDownloadAbortError(options.signal as AbortSignal));
				};
				options.signal?.addEventListener("abort", onAbort, { once: true });
				removeAbortListener = () =>
					options.signal?.removeEventListener("abort", onAbort);
				// Close the check/listen race before the first potentially stalled read.
				if (options.signal?.aborted) onAbort();
			})
		: undefined;
	try {
		for (;;) {
			const read = reader.read();
			const { done, value } = abortPromise
				? await Promise.race([read, abortPromise])
				: await read;
			// A stream can close and abort its owner in the same pull. Cancellation
			// remains authoritative until the consumer has observed completion.
			if (options.signal?.aborted) {
				throw skillDownloadAbortError(options.signal);
			}
			if (done) break;
			if (!value?.byteLength) continue;
			total += value.byteLength;
			if (total > MAX_SKILL_PACKAGE_BYTES) {
				try {
					await reader.cancel();
				} catch {
					// error-policy:J6 cancel is best-effort after the byte-cap failure.
				}
				throw tooLarge(total);
			}
			chunks.push(value);
		}
	} catch (cause) {
		// error-policy:J1 translate cancellation at the response-body boundary.
		if (options.signal?.aborted) {
			try {
				const cancellation = reader.cancel(options.signal.reason);
				void Promise.resolve(cancellation).catch(() => {
					// error-policy:J6 cancellation is best-effort after abort wins.
				});
			} catch {
				// error-policy:J6 synchronous stream cancellation is teardown-only.
			}
			throw skillDownloadAbortError(options.signal, cause);
		}
		throw cause;
	} finally {
		removeAbortListener?.();
		try {
			reader.releaseLock();
		} catch {
			// error-policy:J6 stream lock release is teardown-only.
		}
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/** Decode a capped install download as UTF-8 text (SKILL.md / README.md). */
export async function readCappedSkillText(
	response: Response,
	options: { signal?: AbortSignal } = {},
): Promise<string> {
	const bytes = await readCappedSkillPackage(response, options);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (cause) {
		// error-policy:J2 malformed authored instructions are rejected without
		// silently replacing invalid bytes and changing the package contents.
		throw new ElizaError("Skill package text is not valid UTF-8", {
			code: "SKILL_PACKAGE_INVALID_UTF8",
			context: {
				boundary: "skill-package-download",
				byteLength: bytes.byteLength,
			},
			cause,
		});
	}
}
