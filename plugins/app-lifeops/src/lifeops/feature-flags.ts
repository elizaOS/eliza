import { type IAgentRuntime, logger, type Service } from "@elizaos/core";
import {
  getFeatureFlagRegistry,
  UnknownFeatureFlagError,
} from "./registries/feature-flag-registry.js";
import {
  ALL_FEATURE_KEYS,
  type FeatureFlagChangeListener,
  type FeatureFlagService,
  type FeatureFlagSource,
  type FeatureFlagState,
  isLifeOpsFeatureKey,
  type LifeOpsFeatureFlagKey,
  resolveFeatureDefaults,
} from "./feature-flags.types.js";
import {
  executeRawSql,
  parseJsonRecord,
  sqlBoolean,
  sqlJson,
  sqlText,
  toBoolean,
  toText,
} from "./sql.js";

/**
 * SQL-backed FeatureFlagService.
 *
 * Reads & writes the `app_lifeops.lifeops_features` table owned by `app-lifeops` and
 * migrated via the plugin's `schema` export.
 * Compile-time defaults (`FEATURE_DEFAULTS`) are the authority when no row
 * exists. The runtime never writes a row with `source = 'default'` —
 * absence is the canonical representation of an unmodified default
 * (Commandment 7).
 */

const SELECT_COLUMNS =
  "feature_key, enabled, source, enabled_at, enabled_by, metadata, created_at, updated_at";

const ALLOWED_SOURCES: ReadonlySet<FeatureFlagSource> = new Set([
  "local",
  "cloud",
]);

interface CloudAuthService extends Service {
  isAuthenticated(): boolean;
}

function isCloudAuthService(
  service: Service | null,
): service is Service & CloudAuthService {
  return (
    service !== null &&
    typeof (service as Partial<CloudAuthService>).isAuthenticated === "function"
  );
}

function readCloudLinked(runtime: IAgentRuntime): boolean {
  const getService = (
    runtime as IAgentRuntime & {
      getService?: (serviceType: string) => Service | null;
    }
  ).getService;
  const service =
    typeof getService === "function"
      ? getService.call(runtime, "CLOUD_AUTH")
      : null;
  if (!isCloudAuthService(service)) {
    return false;
  }
  return service.isAuthenticated() === true;
}

interface FeatureFlagDescriptor {
  readonly enabled: boolean;
  readonly label: string;
  readonly description: string;
  readonly costsMoney: boolean;
}

/**
 * Resolve label/description/baseline-enabled/costsMoney for a feature key.
 *
 * Built-in keys (`isLifeOpsFeatureKey`) read from the Cloud-aware
 * `resolveFeatureDefaults`. Registered 3rd-party keys read from the
 * `FeatureFlagRegistry` contribution. Unknown keys throw
 * `UnknownFeatureFlagError`.
 */
function resolveDescriptor(
  runtime: IAgentRuntime,
  key: LifeOpsFeatureFlagKey,
  cloudLinked: boolean,
): FeatureFlagDescriptor {
  if (isLifeOpsFeatureKey(key)) {
    const def = resolveFeatureDefaults({ cloudLinked })[key];
    return {
      enabled: def.enabled,
      label: def.label,
      description: def.description,
      costsMoney: def.costsMoney,
    };
  }
  const registry = getFeatureFlagRegistry(runtime);
  const contribution = registry?.get(key) ?? null;
  if (!contribution) {
    const known = registry?.list().map((c) => c.key) ?? [];
    throw new UnknownFeatureFlagError(key, known);
  }
  const costsMoney = contribution.metadata?.costsMoney === "true";
  return {
    enabled: contribution.defaultEnabled,
    label: contribution.label,
    description: contribution.description,
    costsMoney,
  };
}

function rowToState(
  runtime: IAgentRuntime,
  row: Record<string, unknown>,
  fallback: LifeOpsFeatureFlagKey,
  cloudLinked: boolean,
): FeatureFlagState {
  const featureKey = toText(row.feature_key);
  const descriptor = resolveDescriptor(runtime, featureKey, cloudLinked);
  const sourceText = toText(row.source);
  if (!ALLOWED_SOURCES.has(sourceText as FeatureFlagSource)) {
    throw new Error(`[FeatureFlags] unknown source from db: ${sourceText}`);
  }
  const enabledAtRaw = row.enabled_at;
  let enabledAt: Date | null = null;
  if (enabledAtRaw instanceof Date) {
    enabledAt = enabledAtRaw;
  } else if (typeof enabledAtRaw === "string" && enabledAtRaw.length > 0) {
    const parsed = new Date(enabledAtRaw);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(
        `[FeatureFlags] invalid enabled_at for ${fallback}: ${enabledAtRaw}`,
      );
    }
    enabledAt = parsed;
  }
  const enabledByText = toText(row.enabled_by);
  return {
    featureKey,
    enabled: toBoolean(row.enabled),
    source: sourceText as FeatureFlagSource,
    enabledAt,
    enabledBy: enabledByText.length > 0 ? enabledByText : null,
    label: descriptor.label,
    description: descriptor.description,
    costsMoney: descriptor.costsMoney,
    metadata: parseJsonRecord(row.metadata),
  };
}

function defaultState(
  runtime: IAgentRuntime,
  key: LifeOpsFeatureFlagKey,
  cloudLinked: boolean,
): FeatureFlagState {
  const descriptor = resolveDescriptor(runtime, key, cloudLinked);
  return {
    featureKey: key,
    enabled: descriptor.enabled,
    source: "default",
    enabledAt: null,
    enabledBy: null,
    label: descriptor.label,
    description: descriptor.description,
    costsMoney: descriptor.costsMoney,
    metadata: {},
  };
}

class PgFeatureFlagService implements FeatureFlagService {
  private readonly runtime: IAgentRuntime;
  private readonly listeners = new Set<FeatureFlagChangeListener>();
  /**
   * Per-request cache of the Cloud-link state. Service instances live for
   * the runtime's lifetime; we re-resolve on every entrypoint call so that
   * sign-in/sign-out flips are picked up without restarting the runtime.
   * The cache exists only to dedupe within a single high-level call (e.g.
   * `list()` resolves once even though it composes many rows).
   */
  private cloudLinkedSnapshot: boolean | null = null;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  private snapshotCloudLinked(): boolean {
    if (this.cloudLinkedSnapshot !== null) {
      return this.cloudLinkedSnapshot;
    }
    const linked = readCloudLinked(this.runtime);
    this.cloudLinkedSnapshot = linked;
    return linked;
  }

  private clearCloudSnapshot(): void {
    this.cloudLinkedSnapshot = null;
  }

  async isEnabled(key: LifeOpsFeatureFlagKey): Promise<boolean> {
    const state = await this.get(key);
    return state.enabled;
  }

  async get(key: LifeOpsFeatureFlagKey): Promise<FeatureFlagState> {
    const cloudLinked = this.snapshotCloudLinked();
    try {
      const sql = `SELECT ${SELECT_COLUMNS} FROM app_lifeops.lifeops_features
        WHERE feature_key = ${sqlText(key)}
        LIMIT 1`;
      const rows = await executeRawSql(this.runtime, sql);
      if (rows.length === 0) {
        return defaultState(this.runtime, key, cloudLinked);
      }
      return rowToState(this.runtime, rows[0], key, cloudLinked);
    } finally {
      this.clearCloudSnapshot();
    }
  }

  async list(): Promise<ReadonlyArray<FeatureFlagState>> {
    const cloudLinked = this.snapshotCloudLinked();
    try {
      const sql = `SELECT ${SELECT_COLUMNS} FROM app_lifeops.lifeops_features`;
      const rows = await executeRawSql(this.runtime, sql);
      const byKey = new Map<LifeOpsFeatureFlagKey, FeatureFlagState>();
      for (const row of rows) {
        const text = toText(row.feature_key);
        byKey.set(text, rowToState(this.runtime, row, text, cloudLinked));
      }
      // The registry is the source of truth for "which flags exist". Built-in
      // keys are always included (for back-compat with `ALL_FEATURE_KEYS`
      // callers); 3rd-party registered keys are surfaced too. DB-only rows
      // for keys the registry doesn't know about are dropped (caller likely
      // un-registered them).
      const registry = getFeatureFlagRegistry(this.runtime);
      const known = new Set<LifeOpsFeatureFlagKey>(ALL_FEATURE_KEYS);
      if (registry) {
        for (const contribution of registry.list()) {
          known.add(contribution.key);
        }
      }
      return Array.from(known).map(
        (key) => byKey.get(key) ?? defaultState(this.runtime, key, cloudLinked),
      );
    } finally {
      this.clearCloudSnapshot();
    }
  }

  enable(
    key: LifeOpsFeatureFlagKey,
    source: FeatureFlagSource,
    enabledBy: string | null,
    metadata?: Readonly<Record<string, unknown>>,
  ): Promise<FeatureFlagState> {
    return this.upsert(key, true, source, enabledBy, metadata);
  }

  disable(
    key: LifeOpsFeatureFlagKey,
    source: FeatureFlagSource,
    enabledBy: string | null,
  ): Promise<FeatureFlagState> {
    return this.upsert(key, false, source, enabledBy, undefined);
  }

  subscribeChanges(handler: FeatureFlagChangeListener): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  private async upsert(
    key: LifeOpsFeatureFlagKey,
    enabled: boolean,
    source: FeatureFlagSource,
    enabledBy: string | null,
    metadata: Readonly<Record<string, unknown>> | undefined,
  ): Promise<FeatureFlagState> {
    if (source === "default") {
      throw new Error(
        "[FeatureFlags] refusing to write a row with source='default'",
      );
    }
    const cloudLinked = this.snapshotCloudLinked();
    try {
      const enabledAtSql = enabled
        ? `(${sqlText(new Date().toISOString())}::timestamptz)`
        : "NULL";
      const enabledBySql = enabledBy ? sqlText(enabledBy) : "NULL";
      const metadataSql = sqlJson(metadata ?? {});
      const sql = `INSERT INTO app_lifeops.lifeops_features (
          feature_key, enabled, source, enabled_at, enabled_by, metadata, created_at, updated_at
        ) VALUES (
          ${sqlText(key)},
          ${sqlBoolean(enabled)},
          ${sqlText(source)},
          ${enabledAtSql},
          ${enabledBySql},
          ${metadataSql},
          now(),
          now()
        )
        ON CONFLICT (feature_key) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          source = EXCLUDED.source,
          enabled_at = EXCLUDED.enabled_at,
          enabled_by = EXCLUDED.enabled_by,
          metadata = EXCLUDED.metadata,
          updated_at = now()
        RETURNING ${SELECT_COLUMNS}`;
      const rows = await executeRawSql(this.runtime, sql);
      if (rows.length === 0) {
        throw new Error(`[FeatureFlags] upsert returned no rows for ${key}`);
      }
      const state = rowToState(this.runtime, rows[0], key, cloudLinked);
      logger.info(
        `[FeatureFlags] ${key} ${enabled ? "enabled" : "disabled"} via ${source}` +
          (enabledBy ? ` by ${enabledBy}` : ""),
      );
      for (const listener of this.listeners) {
        listener(state);
      }
      return state;
    } finally {
      this.clearCloudSnapshot();
    }
  }
}

const RUNTIME_CACHE = new WeakMap<IAgentRuntime, FeatureFlagService>();

/**
 * Cached factory — returns the same service instance per runtime so
 * `subscribeChanges` listeners stay attached across action invocations.
 */
export function createFeatureFlagService(
  runtime: IAgentRuntime,
): FeatureFlagService {
  const existing = RUNTIME_CACHE.get(runtime);
  if (existing) return existing;
  const service = new PgFeatureFlagService(runtime);
  RUNTIME_CACHE.set(runtime, service);
  return service;
}

/**
 * Convenience guard for action handlers. Throws `FeatureNotEnabledError`
 * when the feature is off, with Cloud-aware messaging so the planner can
 * suggest signing in to Eliza Cloud as the easiest path.
 *
 * Accepts both built-in `LifeOpsFeatureKey` values (compile-time safety
 * preserved for first-party callers like `requireFeatureEnabled(runtime,
 * "travel.book_flight")`) and any registered 3rd-party `LifeOpsFeatureFlagKey`.
 */
export async function requireFeatureEnabled(
  runtime: IAgentRuntime,
  key: LifeOpsFeatureFlagKey,
): Promise<void> {
  const service = createFeatureFlagService(runtime);
  if (await service.isEnabled(key)) return;
  const { FeatureNotEnabledError } = await import("./feature-flags.types.js");
  // Carry costsMoney from the registry contribution so 3rd-party flags get
  // the same Cloud opt-in suggestion treatment as built-ins.
  const registry = getFeatureFlagRegistry(runtime);
  const contribution = registry?.get(key) ?? null;
  const costsMoney = contribution?.metadata?.costsMoney === "true";
  throw new FeatureNotEnabledError(key, {
    cloudLinked: readCloudLinked(runtime),
    costsMoney,
  });
}

/**
 * Re-export of the baseline. Most callers should use
 * `resolveFeatureDefaults({cloudLinked})` instead — this constant exists
 * for descriptions/labels that do not vary with Cloud-link state.
 */
export { BASE_FEATURE_DEFAULTS } from "./feature-flags.types.js";
