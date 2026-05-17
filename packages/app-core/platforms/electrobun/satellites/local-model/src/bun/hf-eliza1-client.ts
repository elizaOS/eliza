import { ELIZA_1_HF_REPO } from "./protocol.ts";
import {
	getEliza1BundleTiers,
	getEliza1Catalog,
	getEliza1VoiceComponents,
} from "./eliza1-catalog.ts";

export type HuggingFaceTreeEntry = {
	type?: string;
	path?: string;
	size?: number;
	oid?: string;
	lfs?: unknown;
};

export type Eliza1HfMetadata = {
	repo: string;
	networkDisabled: boolean;
	source: "huggingface" | "snapshot";
	modelInfo?: unknown;
	bundles: string[];
	voicePaths: string[];
	readme?: string;
	uploadManifest?: unknown;
	error?: string;
	snapshot: {
		catalogCount: number;
		bundleTiers: string[];
		voiceComponents: string[];
	};
};

type CachedMetadata = {
	at: number;
	value: Eliza1HfMetadata;
};

export class HuggingFaceEliza1Client {
	private cached: CachedMetadata | null = null;
	private readonly repo: string;
	private readonly token: string | null;

	constructor(options: { repo?: string; token?: string | null } = {}) {
		this.repo = options.repo ?? process.env.ELIZA_MODEL_HF_REPO ?? ELIZA_1_HF_REPO;
		this.token = options.token ?? process.env.HF_TOKEN ?? null;
	}

	async metadata(params: { force?: boolean } = {}): Promise<Eliza1HfMetadata> {
		if (!params.force && this.cached && Date.now() - this.cached.at < 300_000) {
			return this.cached.value;
		}

		if (networkDisabled()) {
			const value = snapshotMetadata(this.repo, true);
			this.cached = { at: Date.now(), value };
			return value;
		}

		try {
			const [modelInfo, bundles, voice, readme, uploadManifest] =
				await Promise.all([
					this.fetchJson(`https://huggingface.co/api/models/${this.repo}`),
					this.fetchJson(
						`https://huggingface.co/api/models/${this.repo}/tree/main/bundles?recursive=false`,
					),
					this.fetchJson(
						`https://huggingface.co/api/models/${this.repo}/tree/main/voice?recursive=false`,
					),
					this.fetchText(
						`https://huggingface.co/${this.repo}/raw/main/README.md`,
					).catch((error) => `README unavailable: ${errorMessage(error)}`),
					this.fetchJson(
						`https://huggingface.co/${this.repo}/raw/main/upload-manifest.json`,
					).catch((error) => ({
						error: `upload-manifest unavailable: ${errorMessage(error)}`,
					})),
				]);
			const value: Eliza1HfMetadata = {
				repo: this.repo,
				networkDisabled: false,
				source: "huggingface",
				modelInfo,
				bundles: extractTreePaths(bundles),
				voicePaths: extractTreePaths(voice),
				readme,
				uploadManifest,
				snapshot: snapshotSummary(),
			};
			this.cached = { at: Date.now(), value };
			return value;
		} catch (error) {
			const value = {
				...snapshotMetadata(this.repo, false),
				error: errorMessage(error),
			};
			this.cached = { at: Date.now(), value };
			return value;
		}
	}

	private async fetchJson(url: string): Promise<unknown> {
		const text = await this.fetchText(url);
		return JSON.parse(text);
	}

	private async fetchText(url: string): Promise<string> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 6_000);
		try {
			const response = await fetch(url, {
				headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new Error(`HTTP ${response.status} ${response.statusText}`);
			}
			return await response.text();
		} finally {
			clearTimeout(timeout);
		}
	}
}

function networkDisabled(): boolean {
	return process.env.ELIZA_MODEL_HF_DISABLE_NETWORK === "1";
}

function snapshotSummary(): Eliza1HfMetadata["snapshot"] {
	return {
		catalogCount: getEliza1Catalog().length,
		bundleTiers: getEliza1BundleTiers().map((tier) => tier.tier),
		voiceComponents: getEliza1VoiceComponents().map((component) => component.id),
	};
}

function snapshotMetadata(repo: string, disabled: boolean): Eliza1HfMetadata {
	const snapshot = snapshotSummary();
	return {
		repo,
		networkDisabled: disabled,
		source: "snapshot",
		bundles: snapshot.bundleTiers.map((tier) => `bundles/${tier}`),
		voicePaths: snapshot.voiceComponents.map((id) => `voice/${id}`),
		snapshot,
	};
}

function extractTreePaths(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const paths: string[] = [];
	for (const entry of value) {
		if (
			typeof entry === "object" &&
			entry !== null &&
			typeof (entry as HuggingFaceTreeEntry).path === "string"
		) {
			paths.push((entry as HuggingFaceTreeEntry).path ?? "");
		}
	}
	return paths.filter((path) => path.length > 0);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
