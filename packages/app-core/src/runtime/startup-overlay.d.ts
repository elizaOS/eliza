/**
 * In-process embedding warmup progress for merging into GET /api/status.
 * The UI can poll status during startup to show download progress (GGUF).
 */
export type EmbeddingWarmupPhase = "checking" | "downloading" | "loading" | "ready";
/** Extract a 0–100 percentage from progress strings like "45% of 95 MB". */
export declare function parseEmbeddingProgressPercent(detail: string | undefined): number | undefined;
export declare function updateStartupEmbeddingProgress(phase: EmbeddingWarmupPhase, detail?: string): void;
export declare function clearStartupEmbeddingProgress(): void;
/**
 * Fields merged into the JSON `startup` object on GET /api/status (Compat layer).
 */
export declare function getStartupEmbeddingAugmentation(): Record<string, unknown> | null;
//# sourceMappingURL=startup-overlay.d.ts.map