/**
 * Composes progress-sensitive and absolute deadlines for multi-gigabyte model
 * downloads shared by the Android bootstrap and iOS foreground fallback.
 */

export const MODEL_DOWNLOAD_IDLE_TIMEOUT_MS = 300_000;
export const MODEL_DOWNLOAD_TOTAL_TIMEOUT_MS = 86_400_000;

interface ModelDownloadDeadlineOptions {
	label: string;
	idleTimeoutMs?: number;
	totalTimeoutMs?: number;
}

export interface ModelDownloadDeadline {
	signal: AbortSignal;
	noteProgress(): void;
	failure(error: unknown): unknown;
	dispose(): void;
}

function assertPositiveTimeout(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive safe integer`);
	}
}

export function createModelDownloadDeadline({
	label,
	idleTimeoutMs = MODEL_DOWNLOAD_IDLE_TIMEOUT_MS,
	totalTimeoutMs = MODEL_DOWNLOAD_TOTAL_TIMEOUT_MS,
}: ModelDownloadDeadlineOptions): ModelDownloadDeadline {
	assertPositiveTimeout(idleTimeoutMs, "idleTimeoutMs");
	assertPositiveTimeout(totalTimeoutMs, "totalTimeoutMs");
	const idleController = new AbortController();
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	const noteProgress = (): void => {
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			idleController.abort(
				new Error(`${label} made no progress for ${idleTimeoutMs}ms`),
			);
		}, idleTimeoutMs);
		idleTimer.unref?.();
	};
	noteProgress();
	const signal = AbortSignal.any([
		idleController.signal,
		AbortSignal.timeout(totalTimeoutMs),
	]);
	return {
		signal,
		noteProgress,
		failure: (error) =>
			signal.aborted && signal.reason instanceof Error ? signal.reason : error,
		dispose: () => {
			if (idleTimer !== undefined) clearTimeout(idleTimer);
		},
	};
}
