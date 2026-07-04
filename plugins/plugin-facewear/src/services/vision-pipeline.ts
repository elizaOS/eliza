/**
 * XR vision pipeline stores recent headset camera frames and sends fresh images
 * to the runtime vision model for scene descriptions.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import type { XRFrameHeader } from "../protocol/xr.ts";

export interface LatestFrame {
	data: Buffer;
	header: XRFrameHeader;
	receivedAt: number;
}

// Avoid describing a view that is no longer representative of the wearer.
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

		// A model failure must surface as an action error via the planner loop, not
		// be swallowed into `null` — which the caller renders as "no recent frame"
		// and hides the real failure. A `null` return means only "no fresh frame".
		const description = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
			imageUrl: dataUrl,
			prompt: prompt ?? "Describe what you see in this image concisely.",
		});
		return typeof description === "string" ? description : null;
	}

	clear(connectionId: string): void {
		this.latest.delete(connectionId);
	}
}
