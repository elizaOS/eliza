/**
 * Resolves the isolated model bundle consumed by fused desktop embeddings.
 * The staged entry follows replacement downloads so the native loader cannot
 * remain pinned to an obsolete GGUF inode after an artifact refresh.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import path from "node:path";

export interface FusedEmbeddingBundleConfig {
	modelsDir: string;
	model: string;
	override?: string;
	expectedSizeBytes?: number;
	sha256?: string;
}

/** Fail closed unless an embedding GGUF is the exact reviewed artifact. */
export function assertEmbeddingArtifactIdentity(
	modelPath: string,
	expectedSizeBytes: number,
	expectedSha256: string,
): void {
	const size = statSync(modelPath).size;
	if (size !== expectedSizeBytes) {
		throw new Error(
			`Embedding GGUF size mismatch for ${modelPath}: got ${size}, expected ${expectedSizeBytes}`,
		);
	}
	const digest = createHash("sha256")
		.update(readFileSync(modelPath))
		.digest("hex");
	if (digest !== expectedSha256.toLowerCase()) {
		throw new Error(
			`Embedding GGUF sha256 mismatch for ${modelPath}: got ${digest}, expected ${expectedSha256}`,
		);
	}
}

/**
 * Accept an operator-provided fused root only when its text region contains
 * exactly the canonical GGUF requested by the semantic-embedding handler.
 * Merely finding a `text/` directory is not an identity attestation: the native
 * loader would otherwise accept an arbitrary same-width model while the runtime
 * registration declared the canonical BGE fingerprint.
 */
export function assertCanonicalFusedEmbeddingOverride(
	override: string,
	model: string,
	expectedSizeBytes?: number,
	sha256?: string,
): void {
	const textDir = path.join(override, "text");
	if (!existsSync(textDir)) {
		throw new Error(`Embedding bundle override must contain text/${model}`);
	}
	const artifacts = readdirSync(textDir, { withFileTypes: true })
		.filter(
			(entry) =>
				(entry.isFile() || entry.isSymbolicLink()) &&
				entry.name.toLowerCase().endsWith(".gguf"),
		)
		.map((entry) => entry.name);
	if (artifacts.length !== 1 || artifacts[0] !== model) {
		throw new Error(
			`Embedding bundle override must contain exactly text/${model}; found ${artifacts.length === 0 ? "no GGUF" : artifacts.join(", ")}`,
		);
	}
	if (expectedSizeBytes !== undefined && sha256 !== undefined) {
		assertEmbeddingArtifactIdentity(
			path.join(textDir, model),
			expectedSizeBytes,
			sha256,
		);
	}
}

function referencesCurrentModel(source: string, staged: string): boolean {
	if (!existsSync(staged)) return false;
	const sourceStat = statSync(source);
	const stagedStat = statSync(staged);
	return sourceStat.dev === stagedStat.dev && sourceStat.ino === stagedStat.ino;
}

function stageCurrentModel(source: string, staged: string): void {
	if (referencesCurrentModel(source, staged)) return;

	if (process.platform === "win32") {
		// Windows file symlinks require privileges on many supported hosts. The
		// resolver refreshes this hardlink when a new process observes a replaced
		// source inode; a process that already opened its fused handle remains pinned
		// until restart. Removing first also means this path is briefly absent while
		// the startup-only repair runs.
		rmSync(staged, { force: true });
		linkSync(source, staged);
		return;
	}

	// POSIX rename replaces the previous staged entry atomically. A symlink is
	// deliberate: artifact managers replace downloads by pathname, and the
	// native bundle must follow that pathname rather than retain the old inode.
	const pending = `${staged}.${process.pid}.pending`;
	rmSync(pending, { force: true });
	symlinkSync(source, pending);
	renameSync(pending, staged);
}

/**
 * Returns a fused embedding bundle root, staging the dedicated GGUF when the
 * configured model is not already inside a native bundle layout.
 */
export function resolveFusedEmbeddingBundleRoot({
	modelsDir,
	model,
	override,
	expectedSizeBytes,
	sha256,
}: FusedEmbeddingBundleConfig): string | null {
	if (override) {
		assertCanonicalFusedEmbeddingOverride(
			override,
			model,
			expectedSizeBytes,
			sha256,
		);
		return override;
	}

	const modelPath = path.resolve(modelsDir, model);
	if (
		existsSync(modelPath) &&
		expectedSizeBytes !== undefined &&
		sha256 !== undefined
	) {
		assertEmbeddingArtifactIdentity(modelPath, expectedSizeBytes, sha256);
	}
	const parent = path.dirname(modelPath);
	if (path.basename(parent) === "text" && existsSync(modelPath)) {
		return path.dirname(parent);
	}
	const bundledModelPath = path.join(modelsDir, "text", model);
	if (existsSync(bundledModelPath)) {
		if (expectedSizeBytes !== undefined && sha256 !== undefined) {
			assertEmbeddingArtifactIdentity(
				bundledModelPath,
				expectedSizeBytes,
				sha256,
			);
		}
		return modelsDir;
	}
	if (!existsSync(modelPath)) return null;

	const root = path.join(modelsDir, ".eliza-embed-bundle");
	const textDir = path.join(root, "text");
	const staged = path.join(textDir, path.basename(model));
	mkdirSync(textDir, { recursive: true });
	stageCurrentModel(modelPath, staged);
	return root;
}
