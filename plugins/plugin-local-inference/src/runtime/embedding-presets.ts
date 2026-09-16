/**
 * Hardware-tiered presets for the local `TEXT_EMBEDDING` model.
 *
 * Hardware tiers share the pinned BGE-small model, CLS pooling, L2 normalization,
 * and 384 dimensions used by Cloudflare. Tiers differ only in GPU offload.
 * The runtime verifies the artifact and activates its named vector space before
 * writes; matching dimensions alone do not make older embeddings compatible.
 */

import os from "node:os";
import type { HardwareProbe } from "../services/types.js";

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

type EmbeddingHardwareProbe = Pick<
	HardwareProbe,
	"appleSilicon" | "gpu" | "totalRamGb"
>;

const BGE_SMALL_EMBEDDING = {
	model: "bge-small-en-v1.5-f16.gguf",
	modelRepo: "CompendiumLabs/bge-small-en-v1.5-gguf",
	dimensions: 384,
	contextSize: 512,
	downloadSizeMB: 64,
} as const;

export const EMBEDDING_PRESETS: Record<EmbeddingTier, EmbeddingPreset> = {
	fallback: {
		tier: "fallback",
		label: "Efficient (CPU)",
		description:
			"bge-small-en-v1.5 local embeddings for Intel Macs and low-RAM machines",
		model: BGE_SMALL_EMBEDDING.model,
		modelRepo: BGE_SMALL_EMBEDDING.modelRepo,
		dimensions: BGE_SMALL_EMBEDDING.dimensions,
		gpuLayers: 0,
		contextSize: BGE_SMALL_EMBEDDING.contextSize,
		downloadSizeMB: BGE_SMALL_EMBEDDING.downloadSizeMB,
	},
	standard: {
		tier: "standard",
		label: "Efficient (accelerated)",
		description:
			"bge-small-en-v1.5 local embeddings with local accelerator offload",
		model: BGE_SMALL_EMBEDDING.model,
		modelRepo: BGE_SMALL_EMBEDDING.modelRepo,
		dimensions: BGE_SMALL_EMBEDDING.dimensions,
		gpuLayers: "auto",
		contextSize: BGE_SMALL_EMBEDDING.contextSize,
		downloadSizeMB: BGE_SMALL_EMBEDDING.downloadSizeMB,
	},
	performance: {
		tier: "performance",
		label: "Efficient (compact text embedding)",
		description:
			"384-dim bge-small-en-v1.5 text embedding model. Powers memory / knowledge vectors only; not chat. " +
			"The framework keeps the default SQL-safe and fast instead of auto-selecting a multi-GB embedding GGUF.",
		model: BGE_SMALL_EMBEDDING.model,
		modelRepo: BGE_SMALL_EMBEDDING.modelRepo,
		dimensions: BGE_SMALL_EMBEDDING.dimensions,
		gpuLayers: "auto",
		contextSize: BGE_SMALL_EMBEDDING.contextSize,
		downloadSizeMB: BGE_SMALL_EMBEDDING.downloadSizeMB,
	},
};

const BYTES_PER_GB = 1024 ** 3;

function hasAcceleratedEmbeddingBackend(
	hardware: EmbeddingHardwareProbe,
): boolean {
	const backend = hardware.gpu?.backend;
	return (
		backend === "cuda" ||
		backend === "metal" ||
		backend === "vulkan" ||
		hardware.appleSilicon
	);
}

export function selectEmbeddingTierFromHardware(
	hardware: EmbeddingHardwareProbe,
): EmbeddingTier {
	if (hardware.totalRamGb <= 8) return "fallback";
	if (!hasAcceleratedEmbeddingBackend(hardware)) return "fallback";
	if (hardware.totalRamGb >= 128) return "performance";
	return "standard";
}

export function selectEmbeddingPresetFromHardware(
	hardware: EmbeddingHardwareProbe,
): EmbeddingPreset {
	return EMBEDDING_PRESETS[selectEmbeddingTierFromHardware(hardware)];
}

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
