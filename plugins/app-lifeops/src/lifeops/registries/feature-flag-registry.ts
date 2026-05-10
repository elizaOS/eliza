/**
 * FeatureFlagRegistry.
 *
 * Lifts the closed `LifeOpsFeatureKey` literal union into an open registry of
 * gateable feature keys. Every primitive in LifeOps is registry-driven so the
 * agent can extend its own surface area at runtime without source-code edits
 * (see `docs/audit/rigidity-hunt-audit.md` Audit C top-1 finding).
 *
 * The closed `LifeOpsFeatureKey` literal union still encodes the canonical
 * built-ins shipped with the plugin (their compile-time `BASE_FEATURE_DEFAULTS`
 * and `CLOUD_LINKED_DEFAULT_ON` policy still apply); the registry tracks
 * every feature flag the runtime is aware of, including 3rd-party
 * contributions registered via plugin `init`.
 *
 * Mirrors the per-runtime WeakMap pattern used by `FamilyRegistry`,
 * `EventKindRegistry`, `BlockerRegistry`, and `AnchorRegistry`.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsFeatureFlagKey,
  LifeOpsFeatureKey,
} from "../feature-flags.types.js";

export interface FeatureFlagContribution {
  /** Open-string feature-flag identifier (built-in or 3rd-party). */
  readonly key: LifeOpsFeatureFlagKey;
  /** Human-readable label shown in settings UI + confirmation prompts. */
  readonly label: string;
  /** One-line user-facing description. */
  readonly description: string;
  /** Compile-time baseline. UI defaults to this when no DB row exists. */
  readonly defaultEnabled: boolean;
  /**
   * Logical grouping. `"core"` for built-ins shipped with `app-lifeops`,
   * `"experimental"` for opt-in betas, `"third_party"` for plugin-contributed
   * flags. Free-form because new namespaces can appear.
   */
  readonly namespace?: string;
  /**
   * Free-form metadata: `{ costsMoney: "true" }`, `{ provider: "duffel" }`,
   * etc. Values are strings so the contribution shape stays serializable for
   * the dev-registries view.
   */
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface FeatureFlagRegistry {
  register(contribution: FeatureFlagContribution): void;
  list(filter?: { namespace?: string }): FeatureFlagContribution[];
  get(key: LifeOpsFeatureFlagKey): FeatureFlagContribution | null;
  has(key: LifeOpsFeatureFlagKey): boolean;
  /**
   * `true` when the key is one of the closed `LifeOpsFeatureKey` built-ins
   * (`BASE_FEATURE_DEFAULTS` is the compile-time authority for them). Used
   * by callers that need to decide whether to apply Cloud-default policy.
   */
  isBuiltin(key: LifeOpsFeatureFlagKey): key is LifeOpsFeatureKey;
}

/**
 * Thrown when a caller tries to toggle / inspect a feature key that has not
 * been registered in the FeatureFlagRegistry. Carries enough context for
 * action handlers to surface a clean error to the planner / owner.
 */
export class UnknownFeatureFlagError extends Error {
  readonly code = "UNKNOWN_FEATURE_FLAG" as const;
  readonly featureKey: string;
  readonly registeredKeys: readonly string[];

  constructor(featureKey: string, registeredKeys: readonly string[]) {
    super(
      `Unknown feature flag '${featureKey}'. Registered keys: ${
        registeredKeys.length > 0 ? registeredKeys.join(", ") : "(none)"
      }.`,
    );
    this.name = "UnknownFeatureFlagError";
    this.featureKey = featureKey;
    this.registeredKeys = [...registeredKeys];
  }
}

class InMemoryFeatureFlagRegistry implements FeatureFlagRegistry {
  private readonly byKey = new Map<string, FeatureFlagContribution>();
  private readonly builtinKeys: ReadonlySet<string>;

  constructor(builtinKeys: ReadonlySet<string>) {
    this.builtinKeys = builtinKeys;
  }

  register(contribution: FeatureFlagContribution): void {
    if (!contribution.key) {
      throw new Error("FeatureFlagRegistry.register: key is required");
    }
    if (this.byKey.has(contribution.key)) {
      throw new Error(
        `FeatureFlagRegistry.register: key "${contribution.key}" already registered`,
      );
    }
    this.byKey.set(contribution.key, contribution);
  }

  list(filter?: { namespace?: string }): FeatureFlagContribution[] {
    const all = Array.from(this.byKey.values());
    if (!filter?.namespace) return all;
    return all.filter((c) => c.namespace === filter.namespace);
  }

  get(key: LifeOpsFeatureFlagKey): FeatureFlagContribution | null {
    return this.byKey.get(key) ?? null;
  }

  has(key: LifeOpsFeatureFlagKey): boolean {
    return this.byKey.has(key);
  }

  isBuiltin(key: LifeOpsFeatureFlagKey): key is LifeOpsFeatureKey {
    return this.builtinKeys.has(key);
  }
}

/**
 * Factory. Pass the set of compile-time built-in keys so `isBuiltin()` can
 * answer without re-importing `BASE_FEATURE_DEFAULTS` (avoids a cycle with
 * the consumer that owns the keys).
 */
export function createFeatureFlagRegistry(args: {
  builtinKeys: ReadonlySet<LifeOpsFeatureKey>;
}): FeatureFlagRegistry {
  return new InMemoryFeatureFlagRegistry(args.builtinKeys as ReadonlySet<string>);
}

// ---------------------------------------------------------------------------
// Per-runtime registration
// ---------------------------------------------------------------------------

const registries = new WeakMap<IAgentRuntime, FeatureFlagRegistry>();

export function registerFeatureFlagRegistry(
  runtime: IAgentRuntime,
  registry: FeatureFlagRegistry,
): void {
  registries.set(runtime, registry);
}

export function getFeatureFlagRegistry(
  runtime: IAgentRuntime,
): FeatureFlagRegistry | null {
  return registries.get(runtime) ?? null;
}

export function __resetFeatureFlagRegistryForTests(
  runtime: IAgentRuntime,
): void {
  registries.delete(runtime);
}
