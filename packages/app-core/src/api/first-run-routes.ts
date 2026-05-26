import type http from "node:http";
import {
  applyCanonicalFirstRunConfig,
  loadElizaConfig,
  saveElizaConfig,
} from "@elizaos/agent";
import { logger } from "@elizaos/core";
import {
  getCloudSecret,
  migrateLegacyRuntimeConfig,
  normalizeDeploymentTargetConfig,
  normalizeFirstRunProviderId,
  normalizeLinkedAccountFlagsConfig,
  normalizeServiceRoutingConfig,
} from "@elizaos/shared";
import { ensureRouteAuthorized } from "./auth.ts";
import type { CompatRuntimeState } from "./compat-route-shared";
import { sendJson as sendJsonResponse } from "./response";
import {
  deriveFirstRunReplayBody,
  extractAndPersistFirstRunApiKey,
  hasDeprecatedFirstRunRequestFields,
  persistFirstRunDefaults,
} from "./server-first-run-helpers";

async function syncFirstRunConfigState(
  req: http.IncomingMessage,
  config: Record<string, unknown>,
): Promise<void> {
  const loopbackPort = req.socket.localPort;
  if (!loopbackPort) {
    return;
  }

  const syncPatch: Record<string, unknown> = {};
  for (const key of [
    "meta",
    "agents",
    "ui",
    "messages",
    "deploymentTarget",
    "linkedAccounts",
    "serviceRouting",
    "features",
    "connectors",
    "cloud",
  ]) {
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
 * Resolve the cloud apiKey from the three sources we accept, in priority order.
 * Returns the first hit (or `undefined` if none) and writes it back into the
 * `config.cloud` slot when found via the secrets/env fallbacks so the
 * subsequent `saveElizaConfig` persists it.
 */
function resolveCloudApiKeyForFirstRun(
  config: Record<string, unknown>,
): string | undefined {
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

export async function handleFirstRunRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  if (method !== "POST" || url.pathname !== "/api/first-run") {
    return false;
  }

  if (!(await ensureRouteAuthorized(req, res, state))) {
    return true;
  }

  const chunks: Buffer[] = [];
  try {
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
  } catch {
    req.push(null);
    return false;
  }
  const rawBody = Buffer.concat(chunks);

  let capturedCloudApiKey: string | undefined;

  try {
    const body = JSON.parse(rawBody.toString("utf8")) as Record<
      string,
      unknown
    >;
    if (hasDeprecatedFirstRunRequestFields(body)) {
      sendJsonResponse(res, 400, {
        error:
          "deprecated first-run payloads are no longer supported; send deploymentTarget, linkedAccounts, serviceRouting, and credentialInputs",
      });
      return true;
    }
    await extractAndPersistFirstRunApiKey(body);
    persistFirstRunDefaults(body);
    if (typeof body.name === "string" && body.name.trim()) {
      state.pendingAgentName = body.name.trim();
    }

    const { replayBody: replayBodyRecord } = deriveFirstRunReplayBody(body);
    const replayDeploymentTarget = normalizeDeploymentTargetConfig(
      replayBodyRecord.deploymentTarget,
    );
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
        );

        if (!resolvedCloudApiKey) {
          logger.warn(
            "[api] Cloud-linked first-run but no API key found on disk, in sealed secrets, or in env. " +
              "The upstream handler will save config WITHOUT cloud.apiKey.",
          );
        } else {
          logger.info(
            "[api] Cloud-linked first-run: resolved API key, injecting into replay body",
          );
        }

        capturedCloudApiKey = resolvedCloudApiKey;
      }
      saveElizaConfig(config);
      await syncFirstRunConfigState(req, config as Record<string, unknown>);
    } catch (err) {
      logger.warn(
        `[api] Failed to persist first-run state: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } catch {
    // JSON parse failed — let upstream handle the error
  }

  sendJsonResponse(res, 200, { ok: true });

  if (capturedCloudApiKey) {
    scheduleCloudApiKeyResave(capturedCloudApiKey);
  }

  return true;
}
