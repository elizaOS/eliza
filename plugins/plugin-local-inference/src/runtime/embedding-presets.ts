import os from "node:os";

export type EmbeddingTier = "fallback" | "standard" | "performance";

export interface EmbeddingPreset {
	tier: EmbeddingTier;
	label: string;
	description: string;
	model: string;
	modelRepo: string;
	dimensions: number;
	gpuLayers: "auto" | 0;
	contextSize: number;
	downloadSizeMB: number;
}

const GTE_SMALL_EMBEDDING = {
	// gte-small: 384-dim general-purpose text embedding, ~64MB fp16 GGUF.
	// Chosen for broad device support (mobile included) and an exact match to
	// plugin-sql's dim384 column — no truncation, no per-device model juggling.
	model: "gte-small_fp16.gguf",
	modelRepo: "ChristianAzinn/gte-small-gguf",
	dimensions: 384,
	contextSize: 512,
	downloadSizeMB: 64,
} as const;

export const EMBEDDING_PRESETS: Record<EmbeddingTier, EmbeddingPreset> = {
	fallback: {
		tier: "fallback",
		label: "Efficient (CPU)",
		description:
			"gte-small local embeddings for Intel Macs and low-RAM machines",
		model: GTE_SMALL_EMBEDDING.model,
		modelRepo: GTE_SMALL_EMBEDDING.modelRepo,
		dimensions: GTE_SMALL_EMBEDDING.dimensions,
		gpuLayers: 0,
		contextSize: GTE_SMALL_EMBEDDING.contextSize,
		downloadSizeMB: GTE_SMALL_EMBEDDING.downloadSizeMB,
	},
	standard: {
		tier: "standard",
		label: "Efficient (Metal GPU)",
		description: "gte-small local embeddings with Metal acceleration",
		model: GTE_SMALL_EMBEDDING.model,
		modelRepo: GTE_SMALL_EMBEDDING.modelRepo,
		dimensions: GTE_SMALL_EMBEDDING.dimensions,
		gpuLayers: "auto",
		contextSize: GTE_SMALL_EMBEDDING.contextSize,
		downloadSizeMB: GTE_SMALL_EMBEDDING.downloadSizeMB,
	},
	performance: {
		tier: "performance",
		label: "Efficient (compact text embedding)",
		description:
			"384-dim gte-small text embedding model. Powers memory / knowledge vectors only; not chat. " +
			"The framework keeps the default SQL-safe and fast instead of auto-selecting a multi-GB embedding GGUF.",
		model: GTE_SMALL_EMBEDDING.model,
		modelRepo: GTE_SMALL_EMBEDDING.modelRepo,
		dimensions: GTE_SMALL_EMBEDDING.dimensions,
		gpuLayers: "auto",
		contextSize: GTE_SMALL_EMBEDDING.contextSize,
		downloadSizeMB: GTE_SMALL_EMBEDDING.downloadSizeMB,
	},
};

const BYTES_PER_GB = 1024 ** 3;

export function detectEmbeddingTier(): EmbeddingTier {
	const totalRamGB = Math.round(os.totalmem() / BYTES_PER_GB);
	const isMac = process.platform === "darwin";
	const isAppleSilicon = isMac && process.arch === "arm64";

	if (!isAppleSilicon || totalRamGB <= 8) return "fallback";
	if (totalRamGB >= 128) return "performance";
	return "standard";
}

export function detectEmbeddingPreset(): EmbeddingPreset {
	return EMBEDDING_PRESETS[detectEmbeddingTier()];
}
