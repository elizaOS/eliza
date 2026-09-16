/** Keeps the native BGE representation compatible with the Cloudflare CLS endpoint. */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { BGE_SMALL_VECTOR_SPACE, ElizaError } from "@elizaos/core";
import {
	ELIZA_POOLING_CLS,
	ELIZA_POOLING_LAST,
	ELIZA_POOLING_MEAN,
} from "../services/voice/ffi-bindings";
import { BGE_EMBEDDING_MODEL } from "./bge-embedding-model";

export function resolveEmbeddingPooling(
	model: string,
	configured?: string,
): number {
	const requested = configured?.trim().toLowerCase();
	const bge = path.basename(model) === BGE_EMBEDDING_MODEL.filename;
	if (bge && requested && requested !== "cls") {
		throw new ElizaError(
			"BGE-small requires CLS pooling to match Cloudflare embeddings",
			{
				code: "EMBEDDING_POOLING_MISMATCH",
				context: { model, requested },
			},
		);
	}
	if (requested && !["cls", "mean", "last"].includes(requested)) {
		throw new ElizaError(
			"Unsupported embedding pooling; use cls, mean, or last",
			{
				code: "EMBEDDING_POOLING_INVALID",
				context: { model, requested },
			},
		);
	}
	return requested === "cls" || bge
		? ELIZA_POOLING_CLS
		: requested === "last"
			? ELIZA_POOLING_LAST
			: ELIZA_POOLING_MEAN;
}

export function normalizeEmbeddingVector(vector: ArrayLike<number>): number[] {
	const values = Array.from(vector);
	const scale = values.reduce(
		(max, value) => Math.max(max, Math.abs(value)),
		0,
	);
	if (!Number.isFinite(scale) || scale === 0) {
		throw new ElizaError(
			"Embedding backend returned a zero or non-finite vector",
			{ code: "EMBEDDING_VECTOR_INVALID" },
		);
	}
	const scaled = values.map((value) => value / scale);
	const norm = Math.sqrt(scaled.reduce((sum, value) => sum + value * value, 0));
	return scaled.map((value) => value / norm);
}

/** Checks the complete tokenizer result before the native encoder can truncate it. */
export function embedCompleteInput(
	text: string,
	tokenize: (text: string) => Int32Array,
	embed: (text: string) => Float32Array,
	contextLimit: number,
): Float32Array {
	const tokenCount = tokenize(text).length;
	if (tokenCount > contextLimit) {
		throw new ElizaError(
			`Embedding input has ${tokenCount} tokens; this encoder supports ${contextLimit}. Split the source into explicit, lossless chunks before embedding.`,
			{
				code: "EMBEDDING_INPUT_TOO_LARGE",
				context: { tokenCount, contextLimit },
			},
		);
	}
	return embed(text);
}

/** Resolves the native context setting against BGE-small's 512-token boundary. */
export function resolveBgeContextLimit(configured?: string): number {
	if (configured === undefined || configured === "") return 512;
	if (!/^[1-9][0-9]*$/.test(configured)) {
		throw new ElizaError(
			"ELIZA_EMBED_N_CTX must be a positive decimal integer",
			{
				code: "EMBEDDING_CONTEXT_INVALID",
			},
		);
	}
	const value = Number(configured);
	if (!Number.isSafeInteger(value) || value > 2147483647) {
		throw new ElizaError("ELIZA_EMBED_N_CTX exceeds the native integer range", {
			code: "EMBEDDING_CONTEXT_INVALID",
		});
	}
	return Math.min(value, 512);
}

/** Verify the actual isolated GGUF before assigning the canonical BGE representation. Runs once per native handle. */
export function verifyBgeEmbeddingBundle(
	bundleRoot: string,
	configuredModel: string,
): string | undefined {
	if (path.basename(configuredModel) !== BGE_EMBEDDING_MODEL.filename)
		return undefined;
	const textDir = path.join(bundleRoot, "text");
	const models = readdirSync(textDir).filter((name) =>
		name.toLowerCase().endsWith(".gguf"),
	);
	if (models.length !== 1) {
		throw new ElizaError(
			"BGE embedding bundle must contain exactly one GGUF so the native loader cannot select another model",
			{
				code: "EMBEDDING_ARTIFACT_INVALID",
				context: { bundleRoot, models },
			},
		);
	}
	return verifyBgeEmbeddingFile(path.join(textDir, models[0]));
}

/** Checks exact file bytes before a native loader can identify vectors as canonical BGE. */
export function verifyBgeEmbeddingFile(modelPath: string): string {
	const actualHash = createHash("sha256")
		.update(readFileSync(modelPath))
		.digest("hex");
	const expectedHash = BGE_EMBEDDING_MODEL.sha256;
	if (actualHash !== expectedHash) {
		throw new ElizaError(
			"BGE embedding file does not contain the pinned model; rerun the artifact installer",
			{
				code: "EMBEDDING_ARTIFACT_INVALID",
				context: { actualHash, expectedHash },
			},
		);
	}
	return BGE_SMALL_VECTOR_SPACE;
}
