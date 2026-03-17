import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { elizaLogger } from "../logger";
import { type IAgentRuntime, Service, ServiceType } from "../types";

export class VoiceCacheService extends Service {
	static serviceType = ServiceType.VOICE_CACHE;
	capabilityDescription =
		"Caches voice synthesis results to reduce latency and cost";
	private cacheDir: string;

	constructor() {
		super();
		this.cacheDir = path.join(process.cwd(), "cache", "voice");
	}

	async initialize(_runtime: IAgentRuntime): Promise<void> {
		if (!fs.existsSync(this.cacheDir)) {
			fs.mkdirSync(this.cacheDir, { recursive: true });
		}
	}

	async stop(): Promise<void> {
		// No cleanup needed for now
	}

	getCached(key: string): Buffer | null {
		const filePath = path.join(this.cacheDir, `${key}.wav`); // Assuming wav for now
		if (fs.existsSync(filePath)) {
			try {
				return fs.readFileSync(filePath);
			} catch (error) {
				elizaLogger.error(
					{ error, filePath },
					"Error reading from voice cache",
				);
				return null;
			}
		}
		return null;
	}

	setCached(key: string, audio: Buffer): void {
		const filePath = path.join(this.cacheDir, `${key}.wav`);
		try {
			fs.writeFileSync(filePath, audio);
		} catch (error) {
			elizaLogger.error({ error, filePath }, "Error writing to voice cache");
		}
	}

	generateKey(content: string, voiceId: string, model: string): string {
		const hash = crypto.createHash("sha256");
		hash.update(content);
		hash.update(voiceId);
		hash.update(model);
		return hash.digest("hex");
	}

	shouldCache(content: string): boolean {
		// Cache if content is short (<= 20 words)
		return content.split(/\s+/).length <= 20;
	}
}
