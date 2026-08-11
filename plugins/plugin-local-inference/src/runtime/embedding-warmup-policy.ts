/**
 * Whether to prefetch the local GGUF embedding model before runtime boot.
 *
 * Chat/inference provider (what you pick in first-run) is separate from
 * **embeddings** (vector memory / RAG). By default the framework keeps
 * `@elizaos/plugin-local-inference` loaded because API-based model plugins do
 * not implement TEXT_EMBEDDING — so a local model was historically always
 * warmed up. When Eliza Cloud is connected with **cloud embeddings** enabled,
 * the cloud plugin handles embeddings instead; skipping warmup avoids a large
 * download unrelated to “local inference” for chat.
 */

function isTruthyEnv(...names: string[]): boolean {
	for (const name of names) {
		const v = process.env[name]?.trim().toLowerCase();
		if (v === "1" || v === "true" || v === "yes") return true;
	}
	return false;
}

export function isLocalEmbeddingDisabledByEnv(): boolean {
	return isTruthyEnv("ELIZA_DISABLE_LOCAL_EMBEDDINGS");
}

function trimmedEnv(name: string): string {
	return process.env[name]?.trim() ?? "";
}

/** Whether this process should own embeddings through the on-device provider. */
export function shouldUseLocalEmbeddingModel(): boolean {
	if (isLocalEmbeddingDisabledByEnv()) {
		return false;
	}

	// Explicit operator routing wins over every heuristic below.
	// EMBEDDING_PROVIDER is only written by the runtime AFTER this gate approves
	// local ownership, so any value present here is the operator's own choice.
	// EMBEDDING_BASE_URL is the bring-your-own-endpoint contract that
	// auto-enables plugin-embeddings. Without this check the local force
	// overrides the operator's configured endpoint, and when the local plugin is
	// also unavailable (e.g. skipped) the dimension probe can never succeed —
	// embedding generation stays permanently disabled and memory writes persist
	// without vectors.
	const configuredProvider = trimmedEnv("EMBEDDING_PROVIDER").toLowerCase();
	if (configuredProvider === "local") {
		return true;
	}
	if (configuredProvider !== "" || trimmedEnv("EMBEDDING_BASE_URL") !== "") {
		return false;
	}

	const cloudEmbeddingsRoutedLocally = isTruthyEnv(
		"ELIZA_CLOUD_EMBEDDINGS_DISABLED",
	);

	if (cloudEmbeddingsRoutedLocally) {
		// User turned off cloud for embeddings — local plugin must serve TEXT_EMBEDDING.
		return true;
	}

	if (isTruthyEnv("ELIZAOS_CLOUD_USE_EMBEDDINGS")) {
		return false;
	}

	return true;
}

export function shouldWarmupLocalEmbeddingModel(): boolean {
	if (!shouldUseLocalEmbeddingModel()) {
		return false;
	}

	// Prefetch timing is independent from provider ownership. Packaged desktop
	// startup skips the download to reach first paint quickly, but must still
	// configure and register the local 384-dimensional provider for first use.
	return !isTruthyEnv("ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP");
}
