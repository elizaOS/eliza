/**
 * Persists authenticated first-run configuration and activates a selected local
 * provider through the host's existing runtime-operation authority. Admission
 * precedes mutations; clients receive an operation receipt and poll its outcome.
 * Deferred fresh installs retain their single-flight boot trigger, while cloud
 * and remote targets remain runtime-less. Launcher-owned Cloud credentials stay
 * ephemeral and are excluded from durable topology synchronization.
 */
import { createHash, randomUUID } from "node:crypto";
import type http from "node:http";
import {
  applyCanonicalFirstRunConfig,
  loadEffectiveElizaConfig,
  loadElizaConfig,
  saveElizaConfig,
} from "@elizaos/agent";
import type { FirstRunDirectAccountAdoption } from "@elizaos/agent/api/first-run-direct-account";
import { ElizaError, logger } from "@elizaos/core";
import { readRequestBody } from "@elizaos/shared/api/http-helpers";
import type { DeploymentTargetRuntime } from "@elizaos/shared/contracts/deployment-types";
import {
  getDirectAccountProviderForFirstRunProvider,
  migrateLegacyRuntimeConfig,
  normalizeFirstRunCredentialInputs,
  normalizeFirstRunProviderId,
} from "@elizaos/shared/contracts/first-run-options";
import {
  normalizeDeploymentTargetConfig,
  normalizeLinkedAccountFlagsConfig,
  normalizeServiceRoutingConfig,
} from "@elizaos/shared/contracts/service-routing";
import { getCloudSecret } from "@elizaos/shared/elizacloud/cloud-secrets";
import {
  resolveDevCloudAuthorityEnvValue,
  resolveDevCloudEnvAuthority,
} from "@elizaos/shared/elizacloud/dev-cloud-env-authority";
import { prepareFirstRunConnectors } from "@elizaos/shared/first-run-config";
import { ensureRouteAuthorized } from "./auth.ts";
import {
  type CompatRuntimeState,
  hasCompatPersistedFirstRunState,
} from "./compat-route-shared";
import {
  isRuntimeBootDeferred,
  triggerDeferredRuntimeBoot,
} from "./deferred-runtime-boot";
import { FirstRunConfigRollback } from "./first-run-rollback";
import { sendJson as sendJsonResponse } from "./response";
import {
  deriveFirstRunReplayBody,
  extractAndPersistFirstRunApiKey,
  hasDeprecatedFirstRunRequestFields,
  persistFirstRunDefaults,
} from "./server-first-run-helpers";

const FIRST_RUN_ACTIVATION_REASON = "First-run local provider activation";

type FirstRunCommitResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

class FirstRunCommitError extends ElizaError {
  constructor(readonly result: Extract<FirstRunCommitResult, { ok: false }>) {
    super(result.error, {
      code: "FIRST_RUN_COMMIT_FAILED",
      context: { status: result.status },
    });
  }
}

export const MAX_FIRST_RUN_BODY_BYTES = 1_048_576;

async function syncFirstRunConfigState(
  req: http.IncomingMessage,
  config: Record<string, unknown>,
  includeCloudTopology = true,
): Promise<void> {
  const loopbackPort = req.socket.localPort;
  if (!loopbackPort) {
    return;
  }

  const syncPatch: Record<string, unknown> = {};
  const syncKeys = [
    "meta",
    "agents",
    "ui",
    "messages",
    "features",
    "connectors",
    "serviceRouting",
    ...(includeCloudTopology
      ? ["deploymentTarget", "linkedAccounts", "cloud"]
      : []),
  ];
  for (const key of syncKeys) {
    if (Object.hasOwn(config, key)) {
      syncPatch[key] = config[key];
    }
  }

  if (Object.keys(syncPatch).length === 0) {
    return;
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.trim()) {
    headers.authorization = authorization;
  }

  const response = await fetch(`http://127.0.0.1:${loopbackPort}/api/config`, {
    method: "PUT",
    headers,
    body: JSON.stringify(syncPatch),
  });
  if (!response.ok) {
    throw new Error(
      `Loopback config sync failed (${response.status}): ${await response.text()}`,
    );
  }
}

/**
 * Defensive resave delay (ms). Long enough that the in-flight loopback PUT
 * /api/config triggered by `syncFirstRunConfigState` plus any
 * concurrent renderer-driven PUT settles before we re-check disk. Tracked as
 * a workaround pending the upstream race fix (see WHY block on
 * `scheduleCloudApiKeyResave` below).
 */
const CLOUD_API_KEY_RESAVE_DELAY_MS = 3000;

/**
 * Defensive: re-write `cloud.apiKey` to disk after a delay if some concurrent
 * config write between now and `CLOUD_API_KEY_RESAVE_DELAY_MS` clobbered it.
 *
 * **WHY this exists:** the synchronous path (resolve apiKey → local
 * `saveElizaConfig` → loopback PUT /api/config) should be sufficient on its
 * own — the upstream PUT handler safeMerges `cloud.apiKey` from the request
 * body into `state.config` before saving. Empirically a clobber still
 * happens in some sequences (likely a concurrent renderer-driven PUT that
 * round-trips through GET (redacted) → PUT and strips apiKey before the
 * `[REDACTED]` filter catches it). Removing the resave requires reproducing
 * the race in an integration test, which is out of scope for the current
 * cleanup batch.
 *
 * Failure here is best-effort (the synchronous path already wrote apiKey
 * once), but log at warn level so a recurring failure is visible — the
 * silent `catch {}` previously here masked real bugs.
 */
function scheduleCloudApiKeyResave(apiKey: string): void {
  // Dev launchers own an immutable process-lifetime Cloud tuple. Persisting a
  // key from any first-run fallback would turn temporary staging credentials
  // (or a later-mutated ambient env value) into durable account state.
  if (resolveDevCloudEnvAuthority()) return;

  setTimeout(() => {
    try {
      const freshConfig = loadElizaConfig();
      if (freshConfig.cloud?.apiKey) {
        return;
      }
      if (!freshConfig.cloud) {
        (freshConfig as Record<string, unknown>).cloud = {};
      }
      (freshConfig.cloud as Record<string, unknown>).apiKey = apiKey;
      migrateLegacyRuntimeConfig(freshConfig as Record<string, unknown>);
      saveElizaConfig(freshConfig);
      logger.info(
        "[api] Re-saved cloud.apiKey after upstream handler clobbered it",
      );
    } catch (err) {
      logger.warn(
        `[api] Defensive cloud.apiKey resave failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, CLOUD_API_KEY_RESAVE_DELAY_MS);
}

/**
 * Resolve the cloud apiKey from the accepted sources. Under a launcher-owned
 * development authority, only the frozen launch value is visible and the
 * durable config is never mutated. Outside authority mode, retain the legacy
 * config → sealed secret → environment priority and persist fallback hits.
 */
function resolveCloudApiKeyForFirstRun(
  config: Record<string, unknown>,
  devCloudAuthority = resolveDevCloudEnvAuthority(),
): string | undefined {
  if (devCloudAuthority) {
    const launchValue = resolveDevCloudAuthorityEnvValue(
      "ELIZAOS_CLOUD_API_KEY",
    )?.trim();
    return launchValue || undefined;
  }

  if (!config.cloud || typeof config.cloud !== "object") {
    config.cloud = {};
  }
  const cloudSlot = config.cloud as Record<string, unknown>;

  const fromConfig = cloudSlot.apiKey;
  if (fromConfig) return String(fromConfig);

  const fromSealedSecret = getCloudSecret("ELIZAOS_CLOUD_API_KEY") ?? undefined;
  if (fromSealedSecret) {
    cloudSlot.apiKey = fromSealedSecret;
    return fromSealedSecret;
  }

  const fromEnv = process.env.ELIZAOS_CLOUD_API_KEY;
  if (fromEnv) {
    cloudSlot.apiKey = fromEnv;
    return fromEnv;
  }

  return undefined;
}

/** Keep direct-provider setup writable while launcher authority owns Cloud. */
function withoutAuthorityOwnedCloudCredential(
  body: Record<string, unknown>,
  devCloudAuthority: ReturnType<typeof resolveDevCloudEnvAuthority>,
): Record<string, unknown> {
  if (!devCloudAuthority) return body;
  const credentialInputs = body.credentialInputs;
  if (
    !credentialInputs ||
    typeof credentialInputs !== "object" ||
    Array.isArray(credentialInputs) ||
    !Object.hasOwn(credentialInputs, "cloudApiKey")
  ) {
    return body;
  }
  const sanitizedCredentialInputs = {
    ...(credentialInputs as Record<string, unknown>),
  };
  delete sanitizedCredentialInputs.cloudApiKey;
  return {
    ...body,
    credentialInputs: sanitizedCredentialInputs,
  };
}

export async function handleFirstRunRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  const activationMatch =
    method === "GET"
      ? /^\/api\/first-run\/activation\/([0-9a-f-]{36})$/i.exec(url.pathname)
      : null;
  if (
    !activationMatch &&
    (method !== "POST" || url.pathname !== "/api/first-run")
  ) {
    return false;
  }

  if (!(await ensureRouteAuthorized(req, res, state))) {
    return true;
  }

  if (activationMatch) {
    const operation = await state.runtimeOperations?.get(activationMatch[1]);
    if (
      operation?.intent.kind !== "restart" ||
      operation.intent.reason !== FIRST_RUN_ACTIVATION_REASON
    ) {
      sendJsonResponse(res, 404, { error: "First-run activation not found" });
      return true;
    }
    sendJsonResponse(res, 200, {
      operationId: operation.id,
      status: operation.status,
      error:
        operation.status === "failed" || operation.status === "rolled-back"
          ? "The selected provider could not activate. Retry setup or inspect runtime diagnostics."
          : null,
    });
    return true;
  }

  let rawBody: string;
  try {
    const body = await readRequestBody(req, {
      maxBytes: MAX_FIRST_RUN_BODY_BYTES,
      returnNullOnTooLarge: true,
    });
    if (body === null) {
      sendJsonResponse(res, 413, { error: "Request body too large" });
      return true;
    }
    rawBody = body.trim();
  } catch (err) {
    // error-policy:J1 first-run POST is the transport boundary; a broken
    // stream becomes a structured 400, never a fabricated onboarding success.
    sendJsonResponse(res, 400, {
      error: `failed to read onboarding request body: ${err instanceof Error ? err.message : String(err)}`,
    });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = rawBody === "" ? undefined : JSON.parse(rawBody);
  } catch {
    // error-policy:J3 untrusted-input sanitizing — malformed first-run JSON is
    // an explicit 400, never a fabricated onboarding success.
    sendJsonResponse(res, 400, { error: "Invalid JSON body" });
    return true;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    sendJsonResponse(res, 400, { error: "Invalid JSON body" });
    return true;
  }
  const body = parsed as Record<string, unknown>;
  // Freeze and retain the launcher tuple before any credential helper can
  // mutate process.env from the request body.
  const devCloudAuthority = resolveDevCloudEnvAuthority();

  let capturedCloudApiKey: string | undefined;
  let committedRuntimeTarget: DeploymentTargetRuntime | undefined;

  const configRollback = new FirstRunConfigRollback();
  const persist = async (
    commitBody: Record<string, unknown>,
  ): Promise<FirstRunCommitResult> => {
    try {
      if (hasDeprecatedFirstRunRequestFields(commitBody)) {
        return {
          ok: false,
          status: 400,
          error:
            "deprecated first-run payloads are no longer supported; send deploymentTarget, linkedAccounts, serviceRouting, and credentialInputs",
        };
      }
      const connectorPreparation = prepareFirstRunConnectors(
        loadElizaConfig(),
        commitBody,
      );
      if (!connectorPreparation.ok) {
        return { ok: false, status: 400, error: connectorPreparation.error };
      }
      await extractAndPersistFirstRunApiKey(
        withoutAuthorityOwnedCloudCredential(commitBody, devCloudAuthority),
        configRollback.record,
        configRollback.observeEnvironmentMutation,
      );
      persistFirstRunDefaults(commitBody, configRollback.record);
      if (typeof commitBody.name === "string" && commitBody.name.trim()) {
        state.pendingAgentName = commitBody.name.trim();
      }

      const { replayBody: replayBodyRecord } =
        deriveFirstRunReplayBody(commitBody);
      const replayDeploymentTarget = normalizeDeploymentTargetConfig(
        replayBodyRecord.deploymentTarget,
      );
      committedRuntimeTarget = replayDeploymentTarget?.runtime;
      const replayLinkedAccounts = normalizeLinkedAccountFlagsConfig(
        replayBodyRecord.linkedAccounts,
      );
      const replayServiceRouting = normalizeServiceRoutingConfig(
        replayBodyRecord.serviceRouting,
      );
      const cloudInferenceSelected = Boolean(
        replayServiceRouting?.llmText?.transport === "cloud-proxy" &&
          normalizeFirstRunProviderId(replayServiceRouting.llmText.backend) ===
            "elizacloud",
      );
      const shouldResolveCloudApiKey =
        replayDeploymentTarget?.runtime === "cloud" ||
        cloudInferenceSelected ||
        replayLinkedAccounts?.elizacloud?.status === "linked";

      // Resolve the cloud API key so the upstream handler can write it
      // into state.config before saving. Without this, the upstream uses
      // its stale in-memory config (loaded at startup, before OAuth) and
      // clobbers the apiKey that persistCloudLoginStatus wrote to disk.
      let resolvedCloudApiKey: string | undefined;

      try {
        const config = loadElizaConfig();
        const before = structuredClone(config);
        if (!config.meta) {
          (config as Record<string, unknown>).meta = {};
        }
        (config.meta as Record<string, unknown>).firstRunComplete = true;
        applyCanonicalFirstRunConfig(config as never, {
          deploymentTarget: replayDeploymentTarget,
          linkedAccounts: replayLinkedAccounts,
          serviceRouting: replayServiceRouting,
        });

        if (shouldResolveCloudApiKey) {
          resolvedCloudApiKey = resolveCloudApiKeyForFirstRun(
            config as Record<string, unknown>,
            devCloudAuthority,
          );

          if (!resolvedCloudApiKey) {
            logger.warn(
              devCloudAuthority
                ? "[api] Cloud-linked first-run has no launcher-authoritative API key; durable, sealed, request, and ambient credentials were ignored."
                : "[api] Cloud-linked first-run but no API key found on disk, in sealed secrets, or in env. " +
                    "The upstream handler will save config WITHOUT cloud.apiKey.",
            );
          } else {
            logger.info(
              "[api] Cloud-linked first-run: resolved API key, injecting into replay body",
            );
          }

          capturedCloudApiKey = resolvedCloudApiKey;
        }
        const currentConnectorPreparation = prepareFirstRunConnectors(
          config,
          commitBody,
        );
        if (!currentConnectorPreparation.ok) {
          return {
            ok: false,
            status: 400,
            error: currentConnectorPreparation.error,
          };
        }
        config.connectors = currentConnectorPreparation.connectors;
        if (Object.keys(currentConnectorPreparation.env).length > 0) {
          config.env ??= {};
          Object.assign(config.env, currentConnectorPreparation.env);
        }
        saveElizaConfig(config);
        configRollback.record(before, config);
        configRollback.observeEnvironmentMutation(() => {
          Object.assign(process.env, currentConnectorPreparation.env);
        });
        // Durable first-run mutations preserve unrelated account state, while
        // the live process receives only the launcher-authoritative Cloud view.
        const operationalConfig = devCloudAuthority
          ? loadEffectiveElizaConfig()
          : config;
        // The authority view removes Cloud-owned keys from per-agent settings.
        // `agents.list` is an array, so the generic config route replaces it
        // wholesale rather than deep-merging its entries. Use the just-saved
        // durable agent graph for this loopback-only state refresh; otherwise a
        // harmless first-run sync would delete unrelated durable credentials.
        const syncConfig = devCloudAuthority
          ? {
              ...(operationalConfig as Record<string, unknown>),
              ...(Object.hasOwn(config, "agents")
                ? { agents: (config as Record<string, unknown>).agents }
                : {}),
            }
          : (operationalConfig as Record<string, unknown>);
        await syncFirstRunConfigState(req, syncConfig, !devCloudAuthority);
      } catch (err) {
        // error-policy:J1 a failed config commit is a server failure, never a
        // successful onboarding acknowledgement.
        logger.error(
          `[api] Failed to persist first-run state: ${err instanceof Error ? err.message : String(err)}`,
        );
        return {
          ok: false,
          status: 500,
          error: "Failed to persist first-run state",
        };
      }
    } catch (err) {
      // error-policy:J1 valid JSON does not imply a successful commit; translate
      // helper failures at the HTTP boundary without exposing internal details.
      logger.error(
        `[api] First-run helper failed after valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        ok: false,
        status: 500,
        error: "Failed to complete first-run setup",
      };
    }

    return { ok: true };
  };

  const target = normalizeDeploymentTargetConfig(body.deploymentTarget);
  const routing = normalizeServiceRoutingConfig(body.serviceRouting);
  const commit = async (): Promise<FirstRunCommitResult> => {
    let adoption: FirstRunDirectAccountAdoption | null = null;
    let persistenceBody = body;
    const previousPendingAgentName = state.pendingAgentName;
    const provider = getDirectAccountProviderForFirstRunProvider(
      routing?.llmText?.backend,
    );
    const key = normalizeFirstRunCredentialInputs(
      body.credentialInputs,
    )?.llmApiKey;
    const rollback = async (): Promise<void> => {
      const owned = adoption;
      if (!owned) return;
      // Restore only values still equal to our writes; concurrent settings own
      // their newer values. Keep the account until durable/live state agrees.
      if (configRollback.hasWrites) {
        const restoredConfig = configRollback.restore(loadElizaConfig());
        saveElizaConfig(restoredConfig);
        if (!state.reloadConfigFromDisk) {
          throw new ElizaError(
            "First-run rollback cannot refresh host configuration",
            {
              code: "FIRST_RUN_ROLLBACK_UNAVAILABLE",
            },
          );
        }
        state.reloadConfigFromDisk();
      }
      if (
        typeof persistenceBody.name === "string" &&
        state.pendingAgentName === persistenceBody.name.trim()
      ) {
        state.pendingAgentName = previousPendingAgentName;
      }
      configRollback.restoreEnvironment();
      const currentConfig = loadElizaConfig();
      const routes = normalizeServiceRoutingConfig(
        currentConfig.serviceRouting,
      );
      const concurrentlyReferenced = Object.values(routes ?? {}).some(
        (route) =>
          route?.accountId === owned.account.id ||
          route?.accountIds?.includes(owned.account.id),
      );
      if (concurrentlyReferenced) {
        logger.info(
          "[api] Retained first-run account selected by a concurrent settings change",
        );
      } else await owned.rollback();
      adoption = null;
      const { syncDirectProviderCredentials } = await import(
        "@elizaos/agent/api/accounts-routes"
      );
      await syncDirectProviderCredentials(
        { state: { config: loadElizaConfig(), runtime: state.current } },
        owned.account.providerId,
      );
    };
    try {
      if (
        routing?.llmText?.transport === "direct" &&
        key &&
        (provider === "openrouter-api" || provider === "xai-api")
      ) {
        if (routing.llmText.accountId || routing.llmText.accountIds?.length) {
          return {
            ok: false,
            status: 400,
            error:
              "Choose an existing account or enter a new provider key, not both.",
          };
        }
        const { adoptFirstRunDirectAccount } = await import(
          "@elizaos/agent/api/first-run-direct-account"
        );
        adoption = await adoptFirstRunDirectAccount({
          providerId: provider,
          apiKey: key,
        });
        // A newly entered key owns this text route; ordinary pool priority or
        // session affinity must not silently reactivate an earlier account.
        persistenceBody = {
          ...body,
          serviceRouting: {
            ...routing,
            llmText: {
              ...routing.llmText,
              accountIds: [adoption.account.id],
            },
          },
        };
      }
      const result = await persist(persistenceBody);
      if (!result.ok) throw new FirstRunCommitError(result);
      if (adoption) {
        const { syncDirectProviderCredentials } = await import(
          "@elizaos/agent/api/accounts-routes"
        );
        await syncDirectProviderCredentials(
          { state: { config: loadElizaConfig(), runtime: state.current } },
          adoption.account.providerId,
        );
      }
      if (capturedCloudApiKey && !devCloudAuthority) {
        scheduleCloudApiKeyResave(capturedCloudApiKey);
      }
      return result;
    } catch (err) {
      // error-policy:J1 provider adoption and export must succeed before setup is accepted.
      try {
        await rollback();
      } catch (rollbackError) {
        // error-policy:J1 incomplete rollback is explicitly reported; retained
        // credentials must not be described as successfully removed.
        logger.error({ err, rollbackError }, "[api] First-run rollback failed");
        return {
          ok: false,
          status: 500,
          error:
            "First-run setup and rollback failed. Inspect runtime diagnostics before retrying.",
        };
      }
      if (err instanceof FirstRunCommitError) return err.result;
      logger.error(
        { err },
        "[api] First-run provider account activation failed",
      );
      return {
        ok: false,
        status:
          err instanceof ElizaError &&
          err.code === "FIRST_RUN_DIRECT_CREDENTIAL_INVALID"
            ? 400
            : 500,
        error:
          err instanceof ElizaError &&
          err.code === "FIRST_RUN_DIRECT_CREDENTIAL_INVALID"
            ? "Provider credential could not be verified. Check the key and retry setup."
            : "First-run provider account activation failed",
      };
    }
  };
  const requiresActivation =
    state.current !== null &&
    !isRuntimeBootDeferred() &&
    target?.runtime === "local" &&
    routing?.llmText !== undefined;
  if (requiresActivation) {
    const operations = state.runtimeOperations;
    if (!operations) {
      sendJsonResponse(res, 503, {
        error:
          "Runtime activation is not available. Retry after the local host is ready.",
      });
      return true;
    }
    const requestKey = req.headers["idempotency-key"];
    if (
      requestKey !== undefined &&
      (typeof requestKey !== "string" || !/^[0-9a-f-]{36}$/i.test(requestKey))
    ) {
      sendJsonResponse(res, 400, {
        error: "First-run Idempotency-Key must be a UUID",
      });
      return true;
    }
    try {
      const outcome = await operations.start({
        intent: { kind: "restart", reason: FIRST_RUN_ACTIVATION_REASON },
        idempotencyKey: `first-run:${requestKey ?? randomUUID()}:${createHash("sha256").update(rawBody).digest("hex")}`,
        prepare: async () => {
          const result = await commit();
          if (!result.ok) throw new FirstRunCommitError(result);
          return undefined;
        },
      });
      if (outcome.kind === "rejected-busy") {
        sendJsonResponse(res, 409, {
          error:
            "A runtime operation is already in progress. Retry setup when it finishes.",
          activeOperationId: outcome.activeOperationId,
        });
        return true;
      }
      sendJsonResponse(res, 202, {
        ok: true,
        activation: {
          operationId: outcome.operation.id,
          status: outcome.operation.status,
          error:
            outcome.operation.status === "failed" ||
            outcome.operation.status === "rolled-back"
              ? "The selected provider could not activate. Retry setup or inspect runtime diagnostics."
              : null,
        },
      });
      return true;
    } catch (err) {
      // error-policy:J1 admission or persistence failure remains an explicit HTTP failure.
      if (err instanceof FirstRunCommitError) {
        sendJsonResponse(res, err.result.status, { error: err.result.error });
      } else {
        logger.error(
          { err },
          "[api] First-run runtime activation could not be scheduled",
        );
        sendJsonResponse(res, 500, {
          error: "First-run runtime activation could not be scheduled",
        });
      }
      return true;
    }
  }
  const result = await commit();
  if (!result.ok) {
    sendJsonResponse(res, result.status, { error: result.error });
    return true;
  }

  sendJsonResponse(res, 200, { ok: true });

  // Fresh-install deferred boot (see deferred-runtime-boot.ts): a committed
  // LOCAL-target onboarding is THE signal to boot the agent runtime this
  // process skipped at startup. Cloud/remote targets stay runtime-less on
  // purpose — the client binds the cloud/remote agent and this process never
  // needed a local runtime (#13377). Gated on the same on-disk predicate the
  // status route serves, so a failed persist never boots the discarded
  // pre-onboarding default runtime. Fire-and-forget: the client's finish flow
  // does not wait on this response for readiness (it polls /api/status, and
  // early chat turns hold on the runtime-ready gate); a boot failure is
  // observable there as state "error".
  if (
    isRuntimeBootDeferred() &&
    committedRuntimeTarget !== "cloud" &&
    committedRuntimeTarget !== "remote" &&
    hasCompatPersistedFirstRunState(loadElizaConfig())
  ) {
    triggerDeferredRuntimeBoot("first-run onboarding committed").catch(
      (err) => {
        // error-policy:J5 — the failure is observed by clients via
        // /api/status (the boot closure flips state to "error" before
        // rethrowing); this log is the server-side record of the same event.
        logger.error(
          `[api] Deferred runtime boot after first-run commit failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
      },
    );
  }

  return true;
}
