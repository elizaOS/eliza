import os from "node:os";
import { detectGpu } from "../services/gpu-detect.js";

export type EmbeddingTier = "fallback" | "standard" | "performance";
export type EmbeddingAcceleratorBackend = "cuda" | "metal" | "vulkan";

export interface EmbeddingHardwareProfile {
	totalRamGB: number;
	gpuBackend?: EmbeddingAcceleratorBackend | null;
}

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
		description: "gte-small local embeddings for CPU-only and low-RAM machines",
		model: GTE_SMALL_EMBEDDING.model,
		modelRepo: GTE_SMALL_EMBEDDING.modelRepo,
		dimensions: GTE_SMALL_EMBEDDING.dimensions,
		gpuLayers: 0,
		contextSize: GTE_SMALL_EMBEDDING.contextSize,
		downloadSizeMB: GTE_SMALL_EMBEDDING.downloadSizeMB,
	},
	standard: {
		tier: "standard",
		label: "Efficient (GPU)",
		description: "gte-small local embeddings with GPU acceleration",
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
const LOW_RAM_FALLBACK_GB = 8;
const PERFORMANCE_RAM_GB = 128;

export function detectEmbeddingTierForHardware(
	hardware: EmbeddingHardwareProfile,
): EmbeddingTier {
	if (hardware.totalRamGB <= LOW_RAM_FALLBACK_GB) return "fallback";
	if (!hardware.gpuBackend) return "fallback";
	if (hardware.totalRamGB >= PERFORMANCE_RAM_GB) return "performance";
	return "standard";
}

export function detectEmbeddingPresetForHardware(
	hardware: EmbeddingHardwareProfile,
): EmbeddingPreset {
	return EMBEDDING_PRESETS[detectEmbeddingTierForHardware(hardware)];
}

function detectLocalEmbeddingGpuBackend(): EmbeddingAcceleratorBackend | null {
	if (process.platform === "darwin") return "metal";
	const gpu = detectGpu();
	return gpu.nvidiaPresent && gpu.gpu ? "cuda" : null;
}

export function detectEmbeddingTier(): EmbeddingTier {
	const totalRamGB = Math.round(os.totalmem() / BYTES_PER_GB);
	return detectEmbeddingTierForHardware({
		totalRamGB,
		gpuBackend: detectLocalEmbeddingGpuBackend(),
	});
}

export function detectEmbeddingPreset(): EmbeddingPreset {
	return EMBEDDING_PRESETS[detectEmbeddingTier()];
}
