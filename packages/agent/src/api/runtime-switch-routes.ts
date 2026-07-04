/**
 * One shared HTTP surface for agent-driven runtime switching (#12178): the
 * MODEL_SWITCH / AGENT_SWITCH actions and the deterministic `/model` command
 * all POST here, so user- and agent-initiated switches run one implementation.
 *
 * Routes:
 *   POST /api/runtime/model-switch         — flip text inference local↔cloud
 *   POST /api/runtime/agent-switch         — repoint the app shell to a saved
 *                                            runtime profile (resolved client-side)
 *   POST /api/runtime/agent-switch/result  — frontend result callback
 *
 * Model switching is applied server-side through the EXISTING local-inference
 * routes over loopback (assignments / routing / active / downloads — no second
 * implementation of any of them), then broadcast as `shell:model-switch` so
 * connected shells can surface a notice. Sanctioned-models-only is enforced
 * here at the boundary: local ids must be curated Eliza-1 release tiers
 * (`DEFAULT_ELIGIBLE_MODEL_IDS`), cloud is exactly
 * `DEFAULT_ELIZA_CLOUD_TEXT_MODEL`.
 *
 * Distinct from `POST /api/provider/switch` (provider-switch-routes.ts): that
 * is the BYOK provider-connection axis — persists an API key to the vault,
 * rewrites the runtime connection config, and restarts the runtime. This
 * route is the lightweight local↔cloud inference-routing axis (dossier §H
 * "hybrid axis"): no restart, no key handling, routing preference only.
 *
 * Agent switching cannot complete server-side: runtime profiles are
 * client-persisted (localStorage registry, see
 * `packages/ui/src/state/agent-profiles.ts`), so the server deliberately owns
 * no profile registry. The route broadcasts `shell:switch-agent` with a
 * request id, the shell resolves the profile and applies it via the canonical
 * `switchRuntimeNonDestructive` (inheriting its remote-trust gate), and
 * reports the outcome back through the result callback — same
 * pending-request pattern as the views interact round-trip.
 */

import { randomUUID } from "node:crypto";
import type http from "node:http";

import { logger, resolveServerOnlyPort } from "@elizaos/core";
import {
  DEFAULT_ELIGIBLE_MODEL_IDS,
  DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
  FIRST_RUN_DEFAULT_MODEL_ID,
  findCatalogModel,
  type ProviderId,
  readJsonBody,
  TEXT_GENERATION_SLOTS,
} from "@elizaos/shared";
import { PendingRequestMap } from "./pending-request-map.ts";

// Provider ids as registered with the routing layer. Typed against the shared
// ProviderId union so a rename upstream fails compilation here. The string
// values are owned by plugins/plugin-local-inference/src/provider.ts and
// plugins/plugin-elizacloud — kept literal so this route never imports plugin
// runtime modules.
const LOCAL_TEXT_PROVIDER: ProviderId = "eliza-local-inference";
const CLOUD_TEXT_PROVIDER: ProviderId = "elizacloud";

const PREFIX = "/api/runtime";

/** How long the model-load call may take before the switch reports an error. */
const ACTIVE_LOAD_TIMEOUT_MS = 120_000;
/** How long the shell gets to resolve + apply an agent switch. */
const AGENT_SWITCH_TIMEOUT_MS = 12_000;
const LOOPBACK_TIMEOUT_MS = 10_000;

export type ModelSwitchTarget = "local" | "cloud";
export type ModelSwitchStatus = "ready" | "loading" | "downloading";

/** Wire response of POST /api/runtime/model-switch. */
export interface ModelSwitchResponse {
  ok: true;
  target: ModelSwitchTarget;
  model: string;
  displayName: string;
  status: ModelSwitchStatus;
  /** Bundle size in GB when status === "downloading" (from the catalog). */
  downloadSizeGb?: number;
}

/** Wire response of POST /api/runtime/agent-switch. */
export interface AgentSwitchResponse {
  ok: boolean;
  profileId?: string;
  profileLabel?: string;
  /**
   * Refusal/failure reason when ok=false:
   * "not-found" | "untrusted-remote" (from the shell's trust gate) or
   * "no-shell" (no connected shell answered in time).
   */
  reason?: string;
}

const pendingAgentSwitches = new PendingRequestMap();

export interface RuntimeSwitchRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  broadcastWs?: (payload: object) => void;
  /** Test seam; defaults to global fetch against the server's own loopback. */
  loopbackFetch?: typeof fetch;
}

function loopbackBase(): string {
  return `http://127.0.0.1:${resolveServerOnlyPort(process.env)}`;
}

interface LoopbackResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
}

async function loopbackJson(
  fetchImpl: typeof fetch,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  timeoutMs: number = LOOPBACK_TIMEOUT_MS,
): Promise<LoopbackResult> {
  const response = await fetchImpl(`${loopbackBase()}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const parsed: unknown = await response.json().catch(() => null);
  return {
    ok: response.ok,
    status: response.status,
    body:
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null,
  };
}

function sanctionedLocalIds(): string {
  return [...DEFAULT_ELIGIBLE_MODEL_IDS].join(", ");
}

/**
 * Resolve the effective local model id for a switch request: an explicit
 * sanctioned id wins; otherwise the current TEXT_LARGE assignment when it is
 * sanctioned; otherwise the first-run default tier.
 */
async function resolveLocalModelId(
  fetchImpl: typeof fetch,
  requested: string | null,
): Promise<string> {
  if (requested) return requested;
  const assignments = await loopbackJson(
    fetchImpl,
    "GET",
    "/api/local-inference/assignments",
  );
  const current = (
    assignments.body?.assignments as Record<string, unknown> | undefined
  )?.TEXT_LARGE;
  if (typeof current === "string" && DEFAULT_ELIGIBLE_MODEL_IDS.has(current)) {
    return current;
  }
  return FIRST_RUN_DEFAULT_MODEL_ID;
}

async function applyTextRouting(
  fetchImpl: typeof fetch,
  provider: ProviderId,
): Promise<void> {
  // `preferredProvider` is only honoured under the "manual" policy
  // (plugin-local-inference routing-policy.ts), so both are set per text slot.
  for (const slot of TEXT_GENERATION_SLOTS) {
    const preferred = await loopbackJson(
      fetchImpl,
      "POST",
      "/api/local-inference/routing/preferred",
      { slot, provider },
    );
    if (!preferred.ok) {
      throw new Error(`routing/preferred ${slot} returned ${preferred.status}`);
    }
    const policy = await loopbackJson(
      fetchImpl,
      "POST",
      "/api/local-inference/routing/policy",
      { slot, policy: "manual" },
    );
    if (!policy.ok) {
      throw new Error(`routing/policy ${slot} returned ${policy.status}`);
    }
  }
}

async function isModelInstalled(
  fetchImpl: typeof fetch,
  modelId: string,
): Promise<boolean> {
  const installed = await loopbackJson(
    fetchImpl,
    "GET",
    "/api/local-inference/installed",
  );
  const models = installed.body?.models;
  return (
    Array.isArray(models) &&
    models.some(
      (model) =>
        model !== null &&
        typeof model === "object" &&
        (model as Record<string, unknown>).id === modelId,
    )
  );
}

async function switchToLocal(
  fetchImpl: typeof fetch,
  modelId: string,
): Promise<ModelSwitchResponse> {
  const catalog = findCatalogModel(modelId);
  const displayName = catalog?.displayName ?? modelId;

  // Assign the chat slot first so readiness derivation reflects the chosen
  // tier even while the bundle is still downloading.
  const assignment = await loopbackJson(
    fetchImpl,
    "POST",
    "/api/local-inference/assignments",
    { slot: "TEXT_LARGE", modelId },
  );
  if (!assignment.ok) {
    throw new Error(
      typeof assignment.body?.error === "string"
        ? assignment.body.error
        : `assignments returned ${assignment.status}`,
    );
  }
  await applyTextRouting(fetchImpl, LOCAL_TEXT_PROVIDER);

  if (await isModelInstalled(fetchImpl, modelId)) {
    const active = await loopbackJson(
      fetchImpl,
      "POST",
      "/api/local-inference/active",
      { modelId },
      ACTIVE_LOAD_TIMEOUT_MS,
    );
    if (!active.ok) {
      throw new Error(
        typeof active.body?.error === "string"
          ? active.body.error
          : `active returned ${active.status}`,
      );
    }
    const status: ModelSwitchStatus =
      active.body?.status === "ready" ? "ready" : "loading";
    return { ok: true, target: "local", model: modelId, displayName, status };
  }

  const download = await loopbackJson(
    fetchImpl,
    "POST",
    "/api/local-inference/downloads",
    { modelId },
  );
  if (!download.ok) {
    throw new Error(
      typeof download.body?.error === "string"
        ? download.body.error
        : `downloads returned ${download.status}`,
    );
  }
  return {
    ok: true,
    target: "local",
    model: modelId,
    displayName,
    status: "downloading",
    ...(catalog ? { downloadSizeGb: catalog.sizeGb } : {}),
  };
}

async function switchToCloud(
  fetchImpl: typeof fetch,
  modelId: string,
): Promise<ModelSwitchResponse> {
  await applyTextRouting(fetchImpl, CLOUD_TEXT_PROVIDER);
  return {
    ok: true,
    target: "cloud",
    model: modelId,
    displayName: `Eliza Cloud (${modelId})`,
    status: "ready",
  };
}

/**
 * Resolve a pending agent switch from the frontend's result callback. Exposed
 * for the route's own result endpoint and for tests.
 */
export function resolveAgentSwitchResult(result: {
  requestId: string;
  ok: boolean;
  profileId?: string;
  profileLabel?: string;
  reason?: string;
}): void {
  pendingAgentSwitches.resolve(result.requestId, {
    requestId: result.requestId,
    success: result.ok,
    result: {
      profileId: result.profileId,
      profileLabel: result.profileLabel,
      reason: result.reason,
    },
  });
}

export async function handleRuntimeSwitchRoutes(
  ctx: RuntimeSwitchRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, json, error } = ctx;
  if (!pathname.startsWith(PREFIX)) return false;
  const fetchImpl = ctx.loopbackFetch ?? fetch;

  // ── POST /api/runtime/model-switch ────────────────────────────────────────
  if (method === "POST" && pathname === `${PREFIX}/model-switch`) {
    const body = await readJsonBody<Record<string, unknown>>(req, res).catch(
      () => null,
    );
    if (!body) return true;

    const target = body.target;
    if (target !== "local" && target !== "cloud") {
      error(res, 'target must be "local" or "cloud"', 400);
      return true;
    }
    const requestedModel =
      typeof body.model === "string" && body.model.trim().length > 0
        ? body.model.trim()
        : null;

    // Sanctioned-models-only is a hard product rule: local = curated Eliza-1
    // release tiers, cloud = the managed default text model. No other ids.
    if (
      target === "local" &&
      requestedModel &&
      !DEFAULT_ELIGIBLE_MODEL_IDS.has(requestedModel)
    ) {
      error(
        res,
        `"${requestedModel}" is not a sanctioned local model. Available: ${sanctionedLocalIds()}.`,
        400,
      );
      return true;
    }
    if (
      target === "cloud" &&
      requestedModel &&
      requestedModel !== DEFAULT_ELIZA_CLOUD_TEXT_MODEL
    ) {
      error(
        res,
        `"${requestedModel}" is not a sanctioned cloud model. Available: ${DEFAULT_ELIZA_CLOUD_TEXT_MODEL}.`,
        400,
      );
      return true;
    }

    try {
      const result =
        target === "local"
          ? await switchToLocal(
              fetchImpl,
              await resolveLocalModelId(fetchImpl, requestedModel),
            )
          : await switchToCloud(
              fetchImpl,
              requestedModel ?? DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
            );

      logger.info(
        {
          src: "RuntimeSwitchRoutes",
          target: result.target,
          model: result.model,
          status: result.status,
        },
        `[RuntimeSwitchRoutes] Model switch → ${result.target} (${result.model}, ${result.status})`,
      );
      ctx.broadcastWs?.({
        type: "shell:model-switch",
        target: result.target,
        model: result.model,
        displayName: result.displayName,
        status: result.status,
        ...(result.downloadSizeGb !== undefined
          ? { downloadSizeGb: result.downloadSizeGb }
          : {}),
      });
      json(res, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { src: "RuntimeSwitchRoutes", err: message, target },
        `[RuntimeSwitchRoutes] Model switch to ${target} failed: ${message}`,
      );
      error(res, `Model switch failed: ${message}`, 502);
    }
    return true;
  }

  // ── POST /api/runtime/agent-switch ────────────────────────────────────────
  if (method === "POST" && pathname === `${PREFIX}/agent-switch`) {
    const body = await readJsonBody<Record<string, unknown>>(req, res).catch(
      () => null,
    );
    if (!body) return true;

    const profile =
      typeof body.profile === "string" && body.profile.trim().length > 0
        ? body.profile.trim()
        : null;
    if (!profile) {
      error(res, "profile is required", 400);
      return true;
    }
    if (!ctx.broadcastWs) {
      json(res, {
        ok: false,
        reason: "no-shell",
      } satisfies AgentSwitchResponse);
      return true;
    }

    const requestId = randomUUID();
    logger.info(
      { src: "RuntimeSwitchRoutes", requestId, profile },
      `[RuntimeSwitchRoutes] Agent switch requested → "${profile}"`,
    );
    const pending = pendingAgentSwitches.waitFor(
      requestId,
      AGENT_SWITCH_TIMEOUT_MS,
    );
    ctx.broadcastWs({ type: "shell:switch-agent", requestId, profile });

    try {
      const outcome = await pending;
      const detail =
        outcome.result !== null &&
        typeof outcome.result === "object" &&
        !Array.isArray(outcome.result)
          ? (outcome.result as Record<string, unknown>)
          : {};
      const response: AgentSwitchResponse = {
        ok: outcome.success,
        ...(typeof detail.profileId === "string"
          ? { profileId: detail.profileId }
          : {}),
        ...(typeof detail.profileLabel === "string"
          ? { profileLabel: detail.profileLabel }
          : {}),
        ...(typeof detail.reason === "string" ? { reason: detail.reason } : {}),
      };
      logger.info(
        { src: "RuntimeSwitchRoutes", requestId, ...response },
        `[RuntimeSwitchRoutes] Agent switch ${response.ok ? "applied" : `refused (${response.reason ?? "unknown"})`}`,
      );
      json(res, response);
    } catch {
      // waitFor timeout — no connected shell resolved the request.
      logger.warn(
        { src: "RuntimeSwitchRoutes", requestId, profile },
        "[RuntimeSwitchRoutes] Agent switch timed out waiting for a shell",
      );
      json(res, {
        ok: false,
        reason: "no-shell",
      } satisfies AgentSwitchResponse);
    }
    return true;
  }

  // ── POST /api/runtime/agent-switch/result ─────────────────────────────────
  if (method === "POST" && pathname === `${PREFIX}/agent-switch/result`) {
    const body = await readJsonBody<Record<string, unknown>>(req, res).catch(
      () => null,
    );
    if (!body) return true;
    const requestId =
      typeof body.requestId === "string" ? body.requestId : null;
    if (!requestId) {
      error(res, "requestId is required", 400);
      return true;
    }
    resolveAgentSwitchResult({
      requestId,
      ok: body.ok === true,
      profileId:
        typeof body.profileId === "string" ? body.profileId : undefined,
      profileLabel:
        typeof body.profileLabel === "string" ? body.profileLabel : undefined,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });
    json(res, { ok: true });
    return true;
  }

  return false;
}
