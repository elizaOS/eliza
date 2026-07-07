/**
 * Fresh-install boot deferral for the server-only startup path: the gate that
 * decides "this process is a genuinely-fresh install awaiting onboarding" and
 * the single-flight registry that boots the agent runtime once onboarding
 * commits.
 *
 * On a fresh install the GUI shows onboarding first, and the default runtime
 * a server-only boot would build (PGlite open, migrations, plugin-sql, default
 * character, services) is discarded the moment onboarding persists a real
 * configuration. `startEliza` (runtime/eliza.ts) therefore consults
 * `shouldDeferRuntimeBootUntilOnboarding()` right before its post-bind runtime
 * boot and, when it defers, registers the boot closure here instead. The boot
 * then fires from exactly one of: the first-run commit handler
 * (`POST /api/first-run`, first-run-routes.ts) or an explicit
 * `POST /api/agent/start` / `POST /api/agent/restart` (both funnel through the
 * server's `onRestart`). All triggers share one in-flight promise so
 * concurrent requests can never double-open the PGlite data dir.
 *
 * The gate must be exactly "the GUI will show onboarding": it reuses
 * `hasCompatPersistedFirstRunState` — the predicate `GET /api/first-run/status`
 * answers `complete` with — plus the cloud-provisioned and provider-env
 * short-circuits, so env-configured contexts (CI with `ANTHROPIC_API_KEY`,
 * `OLLAMA_BASE_URL` dev loops, provisioned containers) keep booting the
 * runtime immediately, exactly as before.
 */
import { PROVIDER_PLUGIN_MAP } from "@elizaos/agent";
import { loadElizaConfig } from "@elizaos/agent/config/config";
import { logger } from "@elizaos/core";
import { hasCompatPersistedFirstRunState } from "./compat-route-shared";
import { isCloudProvisioned } from "./server-first-run-helpers";

/**
 * Boots the runtime and wires it into the running API server (updateRuntime +
 * updateStartup). Must throw on failure after flipping the reported state to
 * "error" so the client sees the designed error state, never a fake-ready.
 */
type DeferredRuntimeBoot = () => Promise<void>;

let pendingBoot: DeferredRuntimeBoot | null = null;
let bootInFlight: Promise<void> | null = null;

/**
 * True when a provider auto-enable env key is set — the same keys the plugin
 * resolver uses to force-include model-provider plugins at boot. An install
 * configured this way gets a *working* agent from the very first boot, so
 * deferral would be a regression, not an optimization.
 */
function hasConfiguredProviderEnv(): boolean {
  return Object.keys(PROVIDER_PLUGIN_MAP).some((envKey) =>
    Boolean(process.env[envKey]?.trim()),
  );
}

/**
 * The fresh-install gate: defer the runtime boot iff this server would tell
 * the GUI to run onboarding AND nothing else (cloud provisioning, provider env
 * keys) can give the pre-onboarding runtime a working model provider.
 */
export function shouldDeferRuntimeBootUntilOnboarding(): boolean {
  if (isCloudProvisioned()) {
    return false;
  }
  if (hasConfiguredProviderEnv()) {
    return false;
  }
  return !hasCompatPersistedFirstRunState(loadElizaConfig());
}

/**
 * Register the boot closure for a deferred fresh-install boot. Called once by
 * `startEliza` before the API server binds, so any trigger that can only
 * arrive over HTTP is guaranteed to find the closure registered.
 */
export function registerDeferredRuntimeBoot(boot: DeferredRuntimeBoot): void {
  pendingBoot = boot;
  bootInFlight = null;
}

/** True while the runtime boot is deferred (registered and not yet succeeded). */
export function isRuntimeBootDeferred(): boolean {
  return pendingBoot !== null;
}

/**
 * Fire the deferred boot. Single-flight: concurrent triggers share one boot
 * promise. On success the registration is cleared (later triggers no-op); on
 * failure it is kept so an explicit retry (`POST /api/agent/start` /
 * `/api/agent/restart`) can attempt the boot again — the failure itself is
 * surfaced to clients by the boot closure (reported agent state "error").
 */
export function triggerDeferredRuntimeBoot(reason: string): Promise<void> {
  const boot = pendingBoot;
  if (!boot) {
    return Promise.resolve();
  }
  if (!bootInFlight) {
    logger.info(`[eliza] Booting the deferred agent runtime (${reason})`);
    bootInFlight = (async () => {
      try {
        await boot();
        pendingBoot = null;
      } finally {
        bootInFlight = null;
      }
    })();
  }
  return bootInFlight;
}

/** Test-only: reset the module-scoped registry between cases. */
export function resetDeferredRuntimeBootForTests(): void {
  pendingBoot = null;
  bootInFlight = null;
}
