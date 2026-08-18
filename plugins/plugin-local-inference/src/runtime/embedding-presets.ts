/**
 * Hardware-tiered presets for the local `TEXT_EMBEDDING` model.
 *
 * Maps a device's probe (Apple Silicon / GPU / RAM) to one of three tiers —
 * all currently BGE-small-en-v1.5 (384-dim, ~24MB Q4_K_M GGUF), differing only in GPU
 * offload. The dimension is fixed at 384 to match plugin-sql's `dim384` column
 * exactly, so no per-device model juggling or truncation is needed. Consumed by
 * `ensureLocalInferenceHandler` and the embedding warm-up path.
 */

import os from "node:os";
import {
	CANONICAL_EMBEDDING_DIMENSION,
	CANONICAL_EMBEDDING_GGUF_FILENAME,
	CANONICAL_EMBEDDING_GGUF_REPO,
	CANONICAL_EMBEDDING_GGUF_SHA256,
	CANONICAL_EMBEDDING_GGUF_SIZE_BYTES,
} from "@elizaos/core";
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
	expectedSizeBytes: number;
	sha256: string;
}

type EmbeddingHardwareProbe = Pick<
	HardwareProbe,
	"appleSilicon" | "gpu" | "totalRamGb"
>;

const BGE_SMALL_EMBEDDING = {
	// BGE-small-en-v1.5: the canonical 384-dim semantic embedding space.
	// The local GGUF is the compact Q4_K_M conversion of the same BAAI model
	// served by Workers AI. Both paths use CLS pooling plus L2 normalization.
	// Chosen for broad device support (mobile included) and an exact match to
	// plugin-sql's dim384 column — no truncation, no per-device model juggling.
	model: CANONICAL_EMBEDDING_GGUF_FILENAME,
	modelRepo: CANONICAL_EMBEDDING_GGUF_REPO,
	dimensions: CANONICAL_EMBEDDING_DIMENSION,
	contextSize: 512,
	downloadSizeMB: 24,
	expectedSizeBytes: CANONICAL_EMBEDDING_GGUF_SIZE_BYTES,
	sha256: CANONICAL_EMBEDDING_GGUF_SHA256,
} as const;

export const EMBEDDING_PRESETS: Record<EmbeddingTier, EmbeddingPreset> = {
	fallback: {
		tier: "fallback",
		label: "Efficient (CPU)",
		description:
			"BGE-small-en-v1.5 local embeddings for Intel Macs and low-RAM machines",
		model: BGE_SMALL_EMBEDDING.model,
		modelRepo: BGE_SMALL_EMBEDDING.modelRepo,
		dimensions: BGE_SMALL_EMBEDDING.dimensions,
		gpuLayers: 0,
		contextSize: BGE_SMALL_EMBEDDING.contextSize,
		downloadSizeMB: BGE_SMALL_EMBEDDING.downloadSizeMB,
		expectedSizeBytes: BGE_SMALL_EMBEDDING.expectedSizeBytes,
		sha256: BGE_SMALL_EMBEDDING.sha256,
	},
	standard: {
		tier: "standard",
		label: "Efficient (accelerated)",
		description:
			"BGE-small-en-v1.5 local embeddings with local accelerator offload",
		model: BGE_SMALL_EMBEDDING.model,
		modelRepo: BGE_SMALL_EMBEDDING.modelRepo,
		dimensions: BGE_SMALL_EMBEDDING.dimensions,
		gpuLayers: "auto",
		contextSize: BGE_SMALL_EMBEDDING.contextSize,
		downloadSizeMB: BGE_SMALL_EMBEDDING.downloadSizeMB,
		expectedSizeBytes: BGE_SMALL_EMBEDDING.expectedSizeBytes,
		sha256: BGE_SMALL_EMBEDDING.sha256,
	},
	performance: {
		tier: "performance",
		label: "Efficient (compact text embedding)",
		description:
			"384-dim BGE-small-en-v1.5 text embedding model. Powers memory / knowledge vectors only; not chat. " +
			"The framework keeps the default SQL-safe and fast instead of auto-selecting a multi-GB embedding GGUF.",
		model: BGE_SMALL_EMBEDDING.model,
		modelRepo: BGE_SMALL_EMBEDDING.modelRepo,
		dimensions: BGE_SMALL_EMBEDDING.dimensions,
		gpuLayers: "auto",
		contextSize: BGE_SMALL_EMBEDDING.contextSize,
		downloadSizeMB: BGE_SMALL_EMBEDDING.downloadSizeMB,
		expectedSizeBytes: BGE_SMALL_EMBEDDING.expectedSizeBytes,
		sha256: BGE_SMALL_EMBEDDING.sha256,
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
