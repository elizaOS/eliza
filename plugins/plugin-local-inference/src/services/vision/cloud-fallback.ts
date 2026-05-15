import type { ImageDescriptionParams, ImageDescriptionResult } from "@elizaos/core";

export type VisionFallbackReason = "local-unavailable" | "local-overloaded" | "local-error" | "local-aborted-pre-completion" | "cloud-unavailable" | "cloud-error";
export type LocalVisionOutcome = ImageDescriptionResult | { kind: "fallback"; reason: VisionFallbackReason; cause?: Error };
export type LocalImageDescriptionHandler = (params: ImageDescriptionParams | string) => Promise<LocalVisionOutcome>;
export type WrappedImageDescriptionHandler = LocalImageDescriptionHandler;
export interface VisionCloudFallbackOptions { handler?: LocalImageDescriptionHandler; log?: (message: string, detail?: Record<string, unknown>) => void; }

export function classifyLocalVisionError(err: unknown): { fallback: boolean; reason: VisionFallbackReason } {
	if (err instanceof Error) {
		const name = err.name; const msg = err.message.toLowerCase();
		if (name === "AbortError") return { fallback: false, reason: "local-aborted-pre-completion" };
		if (msg.includes("not installed") || msg.includes("not available") || msg.includes("missing") || msg.includes("no local") || msg.includes("mtmd") || msg.includes("mmproj") || msg.includes("dlopen")) return { fallback: true, reason: "local-unavailable" };
		if (msg.includes("busy") || msg.includes("thermal") || msg.includes("low-power")) return { fallback: true, reason: "local-overloaded" };
		if (msg.includes("llama") || msg.includes("ggml") || msg.includes("decode")) return { fallback: true, reason: "local-error" };
	}
	return { fallback: false, reason: "local-error" };
}
function asError(err: unknown): Error { return err instanceof Error ? err : new Error(String(err)); }
export function wrapImageDescriptionHandlerWithCloudFallback(local: LocalImageDescriptionHandler, options: VisionCloudFallbackOptions = {}): WrappedImageDescriptionHandler {
	const log = options.log ?? (() => undefined);
	return async (params) => {
		let localOutcome: LocalVisionOutcome;
		try { localOutcome = await local(params); } catch (err) { const classified = classifyLocalVisionError(err); if (!classified.fallback) throw err; localOutcome = { kind: "fallback", reason: classified.reason, cause: asError(err) }; }
		if (typeof localOutcome === "object" && localOutcome !== null && "kind" in localOutcome && localOutcome.kind === "fallback") {
			if (!options.handler) return localOutcome;
			log("[vision/cloud-fallback] forwarding IMAGE_DESCRIPTION", { reason: localOutcome.reason });
			try { return await options.handler(params); } catch (err) { return { kind: "fallback", reason: "cloud-error", cause: asError(err) }; }
		}
		return localOutcome;
	};
}
