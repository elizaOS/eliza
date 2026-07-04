/**
 * Provider role gating.
 *
 * Sensitive providers declare their own `roleGate` (core `types/components.ts`)
 * in the plugin that owns them; this module is the runtime chokepoint that
 * enforces that declaration by withholding the provider's context from callers
 * below the declared `minRole`. There is no top-down, name-keyed override table:
 * the gate travels with the provider, so renaming or moving a provider can never
 * silently drop its gate (the previous name-keyed override map was
 * fail-OPEN on exactly that drift — #12094 item 3).
 *
 * Action access is declared on each action's `roleGate` and enforced by core
 * execution paths; only provider redaction lives here.
 *
 * @module plugin-role-gating
 */
import type {
  IAgentRuntime,
  Memory,
  Plugin,
  Provider,
  ProviderResult,
  RoleGateRole,
  State,
} from "@elizaos/core";
import { logger, satisfiesRoleGate } from "@elizaos/core";

// ---------------------------------------------------------------------------
// Sensitivity classification
// ---------------------------------------------------------------------------
// A provider is "sensitive" — and therefore gated — iff it declares a
// `roleGate.minRole` that actually restricts anyone. NONE / GUEST are the
// bottom of the rank hierarchy and gate nothing, so they are treated as
// un-declared (a provider gated to GUEST is public).

/**
 * The effective gating floor for a provider, or `undefined` when the provider
 * declares no restricting gate. Single source of truth for "is this provider
 * sensitive?" — used both by the normal wrap path and by the fail-closed
 * withhold path so the two never disagree about which providers matter.
 */
function gatedMinRole(provider: Provider): RoleGateRole | undefined {
  const minRole = (provider as { roleGate?: { minRole?: RoleGateRole } })
    .roleGate?.minRole;
  if (minRole && minRole !== "NONE" && minRole !== "GUEST") {
    return minRole;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Sender-role lookup dedup
// ---------------------------------------------------------------------------
// `checkSenderRole` does two DB queries (resolveWorldForMessage +
// resolveEntityRole). When state composition runs, every gated provider's
// wrapped `get()` calls it in parallel via `Promise.all`. With even a
// modest set of gated providers (ACTIVE_WORKSPACE_CONTEXT,
// CODING_AGENT_EXAMPLES, SECRETS_STATUS, wallet, etc. — 10+ providers gated to
// admin or owner), that's 20+ DB queries per turn before the planner is
// prompted. On a busy host the per-validator stats compound and the provider
// provider-loop hits its overall timeout cap, dropping providers from the
// prompt's context.
//
// This intentionally dedups only live in-flight checks. Provider redaction is
// security-sensitive, and `checkSenderRole` also depends on live connector
// metadata stamped onto the current message, so resolved role decisions are not
// cached across turns.
type RoleCheckValue = {
  role: RoleGateRole;
} | null;

const roleCheckInflightByRuntime = new WeakMap<
  IAgentRuntime,
  Map<string, Promise<RoleCheckValue>>
>();
let roleCheckLoader:
  | Promise<typeof import("./roles.ts").checkSenderRole>
  | undefined;

function loadCheckSenderRole() {
  if (!roleCheckLoader) {
    // Clear the cached promise if the dynamic import rejects so the next
    // call can retry. Without this, a single transient module-registry
    // failure (e.g. evaluation error during startup) would permanently
    // wedge every gated provider for the runtime's lifetime by handing
    // back the same rejected promise on every call.
    roleCheckLoader = import("./roles.ts").then((mod) => mod.checkSenderRole);
    roleCheckLoader.catch(() => {
      roleCheckLoader = undefined;
    });
  }
  return roleCheckLoader;
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function liveRoleMetadataKey(message: Memory): string {
  const source =
    typeof message.content.source === "string" ? message.content.source : "";
  const metadata = (message as Memory & { metadata?: unknown }).metadata;
  return stableStringify({ metadata, source });
}

async function fetchSenderRole(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<RoleCheckValue> {
  const checkSenderRole = await loadCheckSenderRole();
  const fresh = await checkSenderRole(runtime, message);
  return fresh ? { role: fresh.role } : null;
}

async function getCachedSenderRole(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<RoleCheckValue> {
  const entityId = message.entityId;
  const roomId = message.roomId;
  if (!entityId || !roomId) {
    const checkSenderRole = await loadCheckSenderRole();
    const fresh = await checkSenderRole(runtime, message);
    return fresh ? { role: fresh.role } : null;
  }

  const key = `${runtime.agentId}|${entityId}|${roomId}|${liveRoleMetadataKey(message)}`;
  let roleCheckInflight = roleCheckInflightByRuntime.get(runtime);
  if (!roleCheckInflight) {
    roleCheckInflight = new Map();
    roleCheckInflightByRuntime.set(runtime, roleCheckInflight);
  }
  const inflight = roleCheckInflight.get(key);
  if (inflight) return inflight;

  const promise = fetchSenderRole(runtime, message).finally(() => {
    roleCheckInflight.delete(key);
  });
  roleCheckInflight.set(key, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Gating implementation
// ---------------------------------------------------------------------------

/**
 * Wrap a provider's get function so it returns empty content for callers below
 * `minRole`. Providers don't block; they just withhold context. `marker` records
 * the applied gate on the provider so re-application is idempotent (the
 * registration-time chokepoint re-runs over already-gated boot plugins).
 */
function wrapProviderWithMinRole(
  provider: Provider,
  minRole: RoleGateRole,
  marker: string,
): void {
  if ((provider as { __roleGate?: string }).__roleGate === marker) {
    return;
  }

  const originalGet = provider.get;

  provider.get = async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
  ): Promise<ProviderResult> => {
    const check = await getCachedSenderRole(runtime, message);
    if (!check || !satisfiesRoleGate([check.role], { minRole })) {
      return { text: "" };
    }

    return originalGet.call(provider, runtime, message, state);
  };
  (provider as { __roleGate?: string }).__roleGate = marker;
}

/**
 * Hard-withhold a provider's output. Used as the fail-closed fallback when a
 * sensitive provider cannot be gated normally: rather than leaving its original
 * `get` exposed (fail-open), replace it with one that returns no content for
 * every caller so owner/admin-tier context can never leak.
 */
function withholdProvider(provider: Provider): void {
  const redact = async (): Promise<ProviderResult> => ({ text: "" });
  try {
    provider.get = redact;
  } catch {
    // `get` may be a read-only data property; force-replace it when the
    // property is configurable so withholding still wins over exposure.
    Object.defineProperty(provider, "get", {
      value: redact,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  // Mark as gated at the strictest tier so a subsequent pass treats it as done.
  try {
    (provider as { __roleGate?: string }).__roleGate = "OWNER";
  } catch {
    // Best-effort marker only; the withholding above already applied.
  }
}

function withholdSensitiveProviders(plugin: Plugin): number {
  let withheld = 0;
  for (const provider of plugin.providers ?? []) {
    if (!gatedMinRole(provider)) continue;
    withholdProvider(provider);
    withheld++;
  }
  return withheld;
}

/**
 * Apply role gating to the given plugins. Safe to call repeatedly and per
 * plugin: `wrapProviderWithMinRole` is idempotent (already-gated providers are
 * skipped), so this doubles as the register-time chokepoint hook.
 *
 * Providers that declare a restricting `roleGate.minRole` get wrapped so their
 * `get()` short-circuits to empty for callers below that role. Actions are
 * intentionally not wrapped here; use action.roleGate.
 *
 * Fail-closed: if wrapping a sensitive provider throws, its content is withheld
 * entirely and the failure is logged at ERROR — redaction is never silently
 * disabled.
 */
export function applyPluginRoleGating(plugins: Plugin[]): void {
  let gatedProviders = 0;
  let withheldProviders = 0;

  for (const plugin of plugins) {
    if (!plugin.providers?.length) continue;
    for (const provider of plugin.providers) {
      const minRole = gatedMinRole(provider);
      if (!minRole) continue;
      try {
        wrapProviderWithMinRole(provider, minRole, minRole);
        gatedProviders++;
      } catch (err) {
        // Fail closed: a sensitive provider we could not wrap must not be
        // exposed. Withhold its content and report loudly — never silently
        // leave redaction disabled.
        withholdProvider(provider);
        withheldProviders++;
        const providerName = (provider as { name?: string }).name ?? "";
        logger.error(
          `[role-gating] Failed to gate sensitive provider "${providerName}" (minRole=${minRole}); withholding its content to fail closed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  if (gatedProviders > 0) {
    logger.info(`[role-gating] Total: ${gatedProviders} provider(s) gated`);
  }
  if (withheldProviders > 0) {
    logger.error(
      `[role-gating] ${withheldProviders} sensitive provider(s) withheld after a gating failure (fail-closed)`,
    );
  }
}

type ProviderRoleGatingRuntime = Pick<IAgentRuntime, "registerPlugin"> & {
  __elizaProviderRoleGatingInstalled?: boolean;
};

/**
 * Install the durable provider-gating chokepoint on runtime.registerPlugin so
 * boot-time plugins and post-boot hot-installs are gated identically.
 */
export function installProviderRoleGatingChokepoint(
  runtime: ProviderRoleGatingRuntime,
): void {
  if (runtime.__elizaProviderRoleGatingInstalled) return;

  const originalRegisterPlugin = runtime.registerPlugin.bind(runtime);
  runtime.registerPlugin = async (plugin: Plugin): Promise<void> => {
    try {
      applyPluginRoleGating([plugin]);
    } catch (err) {
      let withheld = 0;
      try {
        withheld = withholdSensitiveProviders(plugin);
      } catch (withholdErr) {
        logger.error(
          `[role-gating] Provider role-gating failed for plugin "${plugin?.name}" and sensitive provider withholding also failed; blocking registration to fail closed: ${
            withholdErr instanceof Error
              ? withholdErr.message
              : String(withholdErr)
          }`,
        );
        throw err;
      }
      logger.error(
        `[role-gating] Provider role-gating failed for plugin "${plugin?.name}"; withheld ${withheld} sensitive provider(s) to fail closed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return originalRegisterPlugin(plugin);
  };

  runtime.__elizaProviderRoleGatingInstalled = true;
}
