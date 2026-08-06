/**
 * Resolves the isolated model bundle consumed by fused desktop embeddings.
 * The staged entry follows replacement downloads so the native loader cannot
 * remain pinned to an obsolete GGUF inode after an artifact refresh.
 */

import {
	existsSync,
	linkSync,
	mkdirSync,
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
		// Windows file symlinks require privileges on many supported hosts. A
		// refreshed source inode is detected above, so replacing the hardlink here
		// retains the same follow-the-current-artifact invariant.
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
}: FusedEmbeddingBundleConfig): string | null {
	if (override && existsSync(path.join(override, "text"))) return override;

	const modelPath = path.resolve(modelsDir, model);
	const parent = path.dirname(modelPath);
	if (path.basename(parent) === "text" && existsSync(modelPath)) {
		return path.dirname(parent);
	}
	if (existsSync(path.join(modelsDir, "text", model))) return modelsDir;
	if (!existsSync(modelPath)) return null;

	const root = path.join(modelsDir, ".eliza-embed-bundle");
	const textDir = path.join(root, "text");
	const staged = path.join(textDir, path.basename(model));
	mkdirSync(textDir, { recursive: true });
	stageCurrentModel(modelPath, staged);
	return root;
}
