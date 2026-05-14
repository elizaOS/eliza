/**
 * Dynamic loader for `LocalInferenceEngine` + the eliza-1 catalog.
 *
 * The bench resolves the engine lazily so the eliza-1 modes can be skipped
 * cleanly when:
 *   - the GGUF file isn't on disk
 *   - the `node-llama-cpp` binding isn't available
 *   - `@elizaos/app-core` fails to import (e.g. in a CI shard that hasn't
 *     built it)
 *
 * Each branch logs a single-line reason that flows through the bench report's
 * `skipped[]` list. We deliberately type these imports as `unknown` to keep
 * the bench package's typecheck independent of which app-core / shared
 * subpath exports happen to be wired up at the moment.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Eliza-1 tier ids — kept in lockstep with `@elizaos/shared` catalog. We
 * re-declare locally so this module doesn't have to import the shared
 * package's subpath types (which aren't always exported from the package
 * manifest, depending on the build phase).
 */
export type Eliza1TierId =
  | "eliza-1-0_8b"
  | "eliza-1-2b"
  | "eliza-1-4b"
  | "eliza-1-9b"
  | "eliza-1-27b"
  | "eliza-1-27b-256k"
  | "eliza-1-27b-1m";

/** Subset of the `LocalInferenceEngine.generate` shape the bench needs. */
export interface EngineLike {
  generate(args: EngineGenerateArgs): Promise<string>;
  load(modelPath: string): Promise<void>;
  unload(): Promise<void>;
}

interface EngineGenerateArgs {
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  grammar?: string;
  responseSkeleton?: unknown;
  onTextChunk?: (chunk: string) => void;
  signal?: AbortSignal;
}

interface ResolvedEngine {
  engine: EngineLike;
  modelPath: string;
  tierId: Eliza1TierId;
}

export type ResolveResult =
  | { kind: "ok"; engine: ResolvedEngine }
  | { kind: "skip"; reason: string };

const DEFAULT_TIER: Eliza1TierId = "eliza-1-0_8b";

interface SharedPathsLike {
  elizaModelsDir: () => string;
}

/**
 * Inline mirror of `resolveStateDir()` + `elizaModelsDir()` from
 * `@elizaos/shared/local-inference/paths`. Used as a fallback when the
 * shared import chain is unreachable (the bench is at the edge of the
 * dep graph; some host environments don't have shared's transitive
 * `@elizaos/core` deps resolved). Same precedence as upstream:
 *   ELIZA_STATE_DIR > MILADY_STATE_DIR > ~/.${ELIZA_NAMESPACE ?? "eliza"}
 */
function benchElizaModelsDir(): string {
  const explicit = process.env.ELIZA_STATE_DIR ?? process.env.MILADY_STATE_DIR;
  const ns = process.env.ELIZA_NAMESPACE ?? "eliza";
  const stateDir = explicit ?? path.join(homedir(), `.${ns}`);
  return path.join(stateDir, "local-inference", "models");
}

interface SharedCatalogLike {
  findCatalogModel: (
    id: string,
  ) => { ggufFile: string; hfPathPrefix?: string } | undefined;
}

interface AppCoreEngineLike {
  LocalInferenceEngine: new () => EngineLike;
}

/** Helper around dynamic-import that keeps the type local rather than pulling
 * in package types that may not be exported. */
async function tryImport<T>(spec: string): Promise<T | null> {
  try {
    const mod = (await import(spec)) as T;
    return mod;
  } catch {
    return null;
  }
}

function pluginLocalInferenceUrl(): string {
	return new URL(
		"../../../../plugins/plugin-local-inference/src/index.ts",
		import.meta.url,
	).href;
}

/**
 * Resolve the eliza-1 model path under the configured local-inference root.
 * Returns null when the GGUF isn't present so the caller can short-circuit.
 */
async function resolveElizaModelPath(
  tierId: Eliza1TierId = DEFAULT_TIER,
): Promise<{ modelPath: string; tierId: Eliza1TierId } | null> {
  const paths = await tryImport<SharedPathsLike>(
    "@elizaos/shared/local-inference/paths",
  );
  const catalog = await tryImport<SharedCatalogLike>(
    "@elizaos/shared/local-inference/catalog",
  );
  if (!catalog) return null;
  const model = catalog.findCatalogModel(tierId);
  if (!model) return null;
  // Prefer the shared module's `elizaModelsDir()` when its dep chain
  // resolves; fall back to the inline mirror so the bench works in CI
  // hosts where shared's transitive `@elizaos/core` deps aren't installed.
  const root = paths?.elizaModelsDir?.() ?? benchElizaModelsDir();
  // The catalog `ggufFile` is relative to the model's bundle root; we look
  // for the file under `<root>/<tier>.bundle/<rel>` following the convention
  // used by the eliza-1 downloader (`bundleDirname()` appends `.bundle`).
  // Legacy / non-bundled layouts are probed as a fallback.
  const candidates = [
    path.join(root, `${tierId}.bundle`, model.ggufFile),
    path.join(root, tierId, model.ggufFile),
    path.join(root, model.ggufFile),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { modelPath: candidate, tierId };
  }
  return null;
}

/**
 * Try to instantiate the local-inference engine and load the resolved model.
 *
 * Returns either:
 *   - { kind: "ok", engine } — caller may run generations
 *   - { kind: "skip", reason } — print and skip eliza-1 modes
 */
export async function resolveElizaEngine(
  tierId: Eliza1TierId = DEFAULT_TIER,
): Promise<ResolveResult> {
  if (process.env.ELIZA_BENCH_SKIP_ENGINE === "1") {
    return {
      kind: "skip",
      reason: "ELIZA_BENCH_SKIP_ENGINE=1 in env (manual skip)",
    };
  }
  const resolved = await resolveElizaModelPath(tierId);
  if (!resolved) {
    return {
      kind: "skip",
      reason: `eliza-1 GGUF not found locally for tier ${tierId}`,
    };
  }
	const engineMod =
		(await tryImport<AppCoreEngineLike>(
			"@elizaos/plugin-local-inference",
		)) ??
		(await tryImport<AppCoreEngineLike>(pluginLocalInferenceUrl()));
	if (!engineMod) {
		return {
			kind: "skip",
			reason:
				"failed to import local-inference engine from @elizaos/plugin-local-inference or plugin source",
		};
	}
  let engine: EngineLike;
  try {
    engine = new engineMod.LocalInferenceEngine();
    await engine.load(resolved.modelPath);
  } catch (err) {
    return {
      kind: "skip",
      reason: `engine.load failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  return {
    kind: "ok",
    engine: {
      engine,
      modelPath: resolved.modelPath,
      tierId: resolved.tierId,
    },
  };
}
