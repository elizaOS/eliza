import { type IAgentRuntime, logger, type Service } from "@elizaos/core";
import {
  ALL_FEATURE_KEYS,
  type FeatureFlagChangeListener,
  type FeatureFlagService,
  type FeatureFlagSource,
  type FeatureFlagState,
  isLifeOpsFeatureKey,
  type LifeOpsFeatureKey,
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

function rowToState(
  row: Record<string, unknown>,
  fallback: LifeOpsFeatureKey,
  cloudLinked: boolean,
): FeatureFlagState {
  const featureKeyText = toText(row.feature_key);
  if (!isLifeOpsFeatureKey(featureKeyText)) {
    throw new Error(
      `[FeatureFlags] unknown feature_key from db: ${featureKeyText}`,
    );
  }
  const featureKey = featureKeyText;
  const defaults = resolveFeatureDefaults({ cloudLinked });
  const def = defaults[featureKey];
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
    label: def.label,
    description: def.description,
    costsMoney: def.costsMoney,
    metadata: parseJsonRecord(row.metadata),
  };
}

function defaultState(
  key: LifeOpsFeatureKey,
  cloudLinked: boolean,
): FeatureFlagState {
  const defaults = resolveFeatureDefaults({ cloudLinked });
  const def = defaults[key];
  return {
    featureKey: key,
    enabled: def.enabled,
    source: "default",
    enabledAt: null,
    enabledBy: null,
    label: def.label,
    description: def.description,
    costsMoney: def.costsMoney,
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

  async isEnabled(key: LifeOpsFeatureKey): Promise<boolean> {
    const state = await this.get(key);
    return state.enabled;
  }

  async get(key: LifeOpsFeatureKey): Promise<FeatureFlagState> {
    const cloudLinked = this.snapshotCloudLinked();
    try {
      const sql = `SELECT ${SELECT_COLUMNS} FROM app_lifeops.lifeops_features
        WHERE feature_key = ${sqlText(key)}
        LIMIT 1`;
      const rows = await executeRawSql(this.runtime, sql);
      if (rows.length === 0) {
        return defaultState(key, cloudLinked);
      }
      return rowToState(rows[0], key, cloudLinked);
    } finally {
      this.clearCloudSnapshot();
    }
  }

  async list(): Promise<ReadonlyArray<FeatureFlagState>> {
    const cloudLinked = this.snapshotCloudLinked();
    try {
      const sql = `SELECT ${SELECT_COLUMNS} FROM app_lifeops.lifeops_features`;
      const rows = await executeRawSql(this.runtime, sql);
      const byKey = new Map<LifeOpsFeatureKey, FeatureFlagState>();
      for (const row of rows) {
        const text = toText(row.feature_key);
        if (!isLifeOpsFeatureKey(text)) {
          throw new Error(
            `[FeatureFlags] unknown feature_key from db: ${text}`,
          );
        }
        byKey.set(text, rowToState(row, text, cloudLinked));
      }
      return ALL_FEATURE_KEYS.map(
        (key) => byKey.get(key) ?? defaultState(key, cloudLinked),
      );
    } finally {
      this.clearCloudSnapshot();
    }
  }

  enable(
    key: LifeOpsFeatureKey,
    source: FeatureFlagSource,
    enabledBy: string | null,
    metadata?: Readonly<Record<string, unknown>>,
  ): Promise<FeatureFlagState> {
    return this.upsert(key, true, source, enabledBy, metadata);
  }

  disable(
    key: LifeOpsFeatureKey,
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
    key: LifeOpsFeatureKey,
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
      const state = rowToState(rows[0], key, cloudLinked);
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
 */
export async function requireFeatureEnabled(
  runtime: IAgentRuntime,
  key: LifeOpsFeatureKey,
): Promise<void> {
  const service = createFeatureFlagService(runtime);
  if (await service.isEnabled(key)) return;
  const { FeatureNotEnabledError } = await import("./feature-flags.types.js");
  throw new FeatureNotEnabledError(key, {
    cloudLinked: readCloudLinked(runtime),
  });
}

/**
 * Re-export of the baseline. Most callers should use
 * `resolveFeatureDefaults({cloudLinked})` instead — this constant exists
 * for descriptions/labels that do not vary with Cloud-link state.
 */
export { BASE_FEATURE_DEFAULTS } from "./feature-flags.types.js";
