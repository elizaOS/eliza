import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import type { XRFrameHeader } from "../protocol.ts";

export interface LatestFrame {
	data: Buffer;
	header: XRFrameHeader;
	receivedAt: number;
}

// A frame older than this is considered stale and won't be described
const FRAME_MAX_AGE_MS = 10_000;

export class VisionPipeline {
	private latest = new Map<string, LatestFrame>();

	storeFrame(connectionId: string, header: XRFrameHeader, data: Buffer): void {
		this.latest.set(connectionId, { data, header, receivedAt: Date.now() });
	}

	getLatestFrame(connectionId: string): LatestFrame | undefined {
		const frame = this.latest.get(connectionId);
		if (!frame) return undefined;
		if (Date.now() - frame.receivedAt > FRAME_MAX_AGE_MS) return undefined;
		return frame;
	}

	hasRecentFrame(connectionId: string): boolean {
		return this.getLatestFrame(connectionId) !== undefined;
	}

	async describeFrame(
		runtime: IAgentRuntime,
		connectionId: string,
		prompt?: string,
	): Promise<string | null> {
		const frame = this.getLatestFrame(connectionId);
		if (!frame) return null;

		const dataUrl = `data:image/${frame.header.format};base64,${frame.data.toString("base64")}`;

		try {
			const description = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
				imageUrl: dataUrl,
				prompt: prompt ?? "Describe what you see in this image concisely.",
			});
			return typeof description === "string" ? description : null;
		} catch (err) {
			// error-policy:J7 diagnostics-must-not-kill-the-loop — a single frame's
			// IMAGE_DESCRIPTION failure must not tear down the XR vision loop, but a
			// systemic model misconfiguration must not stay invisible (it was only
			// console.error before). Report it so it reaches the error surface, then
			// degrade this one frame to "no description".
			runtime.reportError("VisionPipeline.describeFrame", err, {
				connectionId,
			});
			return null;
		}
	}

	clear(connectionId: string): void {
		this.latest.delete(connectionId);
	}
}
