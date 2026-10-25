/** Selects a semantically verified BGE context without changing process-wide text-model policy. */

import { ElizaError } from "@elizaos/core";
import type { ElizaInferenceFfi } from "../services/voice/ffi-bindings";
import {
	BGE_SEMANTIC_PROBE_INPUTS,
	embedBgeInput,
	resolveEmbeddingGpuLayers,
	verifyBgeSemanticVectors,
} from "./embedding-vector-space";

export interface EmbeddingBackendPolicy {
	gpuLayers: number;
	automatic: boolean;
}

/** Only an absent operator setting permits a verified CPU fallback. */
export function resolveEmbeddingBackendPolicy(
	configured: string | undefined,
	detectedGpuLayers: number,
): EmbeddingBackendPolicy {
	return {
		gpuLayers: resolveEmbeddingGpuLayers(configured, detectedGpuLayers),
		automatic: !configured?.trim(),
	};
}

type EmbeddingFfi = Pick<
	ElizaInferenceFfi,
	"create" | "destroy" | "embed" | "tokenize"
>;

/**
 * Returns one owned, verified context. Rejected candidates are destroyed here;
 * the caller destroys the successful context before closing its shared binding.
 * Artifact/configuration checks belong before this function and tokenizer
 * failures never authorize a backend change.
 */
export function createVerifiedBgeContext(
	ffi: EmbeddingFfi,
	bundleRoot: string,
	policy: EmbeddingBackendPolicy,
	pooling: number,
	contextLimit: number,
) {
	const tokenize = ffi.tokenize;
	const embed = ffi.embed;
	if (!tokenize || !embed) {
		throw new ElizaError(
			"Canonical BGE requires native embedding and tokenizer support",
			{
				code: "EMBEDDING_TOKENIZER_UNAVAILABLE",
			},
		);
	}
	const candidates =
		policy.automatic && policy.gpuLayers > 0
			? [policy.gpuLayers, 0]
			: [policy.gpuLayers];
	for (const gpuLayers of candidates) {
		const ctx = ffi.create(bundleRoot, { gpuLayers });
		try {
			const vectors = BGE_SEMANTIC_PROBE_INPUTS.map((text) =>
				embedBgeInput(
					text,
					(input) =>
						tokenize({
							ctx,
							text: input,
							addSpecial: true,
							parseSpecial: true,
						}),
					(input) => embed({ ctx, text: input, pooling, parseSpecial: true }),
					contextLimit,
				),
			);
			const separation = verifyBgeSemanticVectors(vectors);
			return { ctx, gpuLayers, ...separation };
		} catch (error) {
			// error-policy:J4 only a rejected automatic vector backend may degrade to a separately verified CPU context.
			ffi.destroy(ctx);
			const rejectedVector =
				error instanceof ElizaError &&
				(error.code === "EMBEDDING_BACKEND_INVALID" ||
					error.code === "EMBEDDING_VECTOR_INVALID");
			if (!policy.automatic || gpuLayers === 0 || !rejectedVector) throw error;
		}
	}
	throw new ElizaError("No verified embedding backend is available", {
		code: "EMBEDDING_BACKEND_INVALID",
	});
}
