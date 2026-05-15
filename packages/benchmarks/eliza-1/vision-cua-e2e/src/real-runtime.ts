/**
 * Real-mode runtime adapter for the vision-CUA E2E harness.
 *
 * The harness is intentionally not a full elizaOS host — booting the entire
 * `AgentRuntime` (with database adapters, providers, services, plugin
 * autoload, etc.) just to call `useModel(IMAGE_DESCRIPTION, …)` would couple
 * the harness to the dev-server lifecycle. Instead this module builds a
 * minimal `IAgentRuntime`-shaped object that supports only what the
 * IMAGE_DESCRIPTION dispatch needs:
 *
 *   - `useModel(modelType, params)` — dispatches to a registered handler.
 *   - `getSetting(key)` — reads from `process.env`.
 *   - `getService(...)` — returns null (used by some handlers as a soft probe).
 *
 * Provider discovery (in priority order):
 *
 *   1. `ANTHROPIC_API_KEY` set → register the Anthropic IMAGE_DESCRIPTION
 *      handler from `@elizaos/plugin-anthropic` (calls Claude with the image
 *      as `data:` URL).
 *   2. (Future) `OPENAI_API_KEY` set → register the OpenAI handler.
 *   3. eliza-1 local bundle present → register the local-inference handler.
 *
 * If nothing is available the adapter throws a structured error that the
 * pipeline records as a stage failure. The harness does NOT fabricate a
 * description in that case — see the contract at the top of `pipeline.ts`.
 */

import type {
  IAgentRuntime,
  ImageDescriptionParams,
  ImageDescriptionResult,
  ModelTypeName,
} from "@elizaos/core";

export interface VisionProviderInfo {
  readonly providerName: string;
  /** Human-readable description of why this provider was selected. */
  readonly reason: string;
}

export interface RealRuntimeAdapter {
  readonly providerInfo: VisionProviderInfo;
  describeImage(
    params: ImageDescriptionParams,
  ): Promise<ImageDescriptionResult>;
}

export interface DiscoverRuntimeOptions {
  /** Override env reader — exported for tests. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Discovery error thrown when no IMAGE_DESCRIPTION provider is available.
 * Carries a structured `missing` field that lists the env vars / artifacts
 * the operator would need to enable real mode.
 */
export class NoVisionProviderError extends Error {
  readonly code = "NO_VISION_PROVIDER" as const;
  readonly missing: ReadonlyArray<string>;
  constructor(missing: ReadonlyArray<string>) {
    super(
      `[vision-cua-e2e] no IMAGE_DESCRIPTION provider available. Missing one of:\n  - ${missing.join(
        "\n  - ",
      )}`,
    );
    this.name = "NoVisionProviderError";
    this.missing = missing;
  }
}

/**
 * Discover and construct a real-mode runtime adapter. Returns the adapter
 * plus the provider info (recorded in the trace JSON for reproducibility).
 *
 * The adapter does NOT throw on construction — it only throws on
 * `describeImage()` if the upstream call fails. Discovery throws
 * `NoVisionProviderError` synchronously when no provider can be wired.
 */
export async function discoverRuntimeAdapter(
  opts: DiscoverRuntimeOptions = {},
): Promise<RealRuntimeAdapter> {
  const env = opts.env ?? (process.env as Readonly<Record<string, string | undefined>>);
  const missing: string[] = [];

  if ((env.ANTHROPIC_API_KEY ?? "").length > 0) {
    const adapter = await tryBuildAnthropicAdapter(env);
    if (adapter) return adapter;
    missing.push(
      "@elizaos/plugin-anthropic could not be loaded even though ANTHROPIC_API_KEY is set",
    );
  } else {
    missing.push("ANTHROPIC_API_KEY (for cloud Anthropic IMAGE_DESCRIPTION)");
  }

  // Future: OpenAI / Google / OpenRouter handlers go here.
  missing.push("OPENAI_API_KEY (for cloud OpenAI IMAGE_DESCRIPTION — not yet wired)");
  missing.push(
    "eliza-1 local bundle under ~/.milady/local-inference/ with IMAGE_DESCRIPTION-capable mmproj",
  );

  throw new NoVisionProviderError(missing);
}

async function tryBuildAnthropicAdapter(
  env: Readonly<Record<string, string | undefined>>,
): Promise<RealRuntimeAdapter | null> {
  let handleImageDescription: typeof import("@elizaos/plugin-anthropic/models/image").handleImageDescription;
  try {
    // The bundled @elizaos/plugin-anthropic only ships `dist/index.js`. The
    // image-description handler lives at `models/image.ts` and is reachable
    // through the workspace symlink at source level. We import it directly
    // because the public bundle doesn't re-export it.
    const mod: { handleImageDescription: typeof handleImageDescription } =
      await import(
        "../../../../plugins/plugin-anthropic/models/image.ts" as string
      );
    handleImageDescription = mod.handleImageDescription;
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[vision-cua-e2e] failed to load @elizaos/plugin-anthropic image handler: ${cause}`,
    );
  }

  const minimalRuntime = createMinimalRuntime(env);
  const modelName =
    env.ANTHROPIC_SMALL_MODEL ?? "claude-haiku-4-5-20251001";

  return {
    providerInfo: {
      providerName: "anthropic",
      reason: `ANTHROPIC_API_KEY present → Anthropic IMAGE_DESCRIPTION (${modelName})`,
    },
    async describeImage(params) {
      return handleImageDescription(minimalRuntime, params);
    },
  };
}

/**
 * Build the smallest IAgentRuntime-shaped object that the IMAGE_DESCRIPTION
 * handlers we care about will accept. Most handlers only need
 * `getSetting()`; some also call `emitModelUsageEvent()` which depends on
 * `emitEvent()` / `getService()` returning soft defaults.
 *
 * The cast to IAgentRuntime is the boundary — we deliberately do NOT
 * implement the full interface, and any handler that pokes at unmocked
 * surface area will throw rather than silently misbehave.
 */
function createMinimalRuntime(
  env: Readonly<Record<string, string | undefined>>,
): IAgentRuntime {
  const settings = (key: string): string | null => env[key] ?? null;
  const handlersByModel = new Map<
    string,
    Array<(runtime: IAgentRuntime, params: unknown) => Promise<unknown>>
  >();

  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000000" as const,
    character: {
      name: "vision-cua-e2e",
      bio: "harness-only minimal runtime",
    },
    getSetting: (key: string) => settings(key),
    getService: () => null,
    getServicesByType: () => [],
    emitEvent: async () => {},
    registerEvent: () => {},
    useModel: async <T extends ModelTypeName>(
      modelType: T,
      params: unknown,
    ): Promise<unknown> => {
      const arr = handlersByModel.get(String(modelType));
      const handler = arr?.[0];
      if (!handler) {
        throw new Error(
          `[minimal-runtime] no handler registered for ${String(modelType)}`,
        );
      }
      return handler(runtime as unknown as IAgentRuntime, params);
    },
    registerModel: (
      modelType: string,
      handler: (runtime: IAgentRuntime, params: unknown) => Promise<unknown>,
    ) => {
      const key = String(modelType);
      const list = handlersByModel.get(key) ?? [];
      list.push(handler);
      handlersByModel.set(key, list);
    },
  };
  return runtime as unknown as IAgentRuntime;
}
