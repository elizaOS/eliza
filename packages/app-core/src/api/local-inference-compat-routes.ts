/**
 * HTTP routes for the local-inference / model management feature.
 *
 * Route shape and auth follow the established `*-compat-routes.ts` pattern:
 *   - `handleLocalInferenceCompatRoutes` returns `true` when it handles a
 *     request and `false` to pass through to the next handler.
 *   - Regular reads use `ensureCompatApiAuthorized`.
 *   - Mutating routes (download start/cancel, active switch, uninstall)
 *     use `ensureCompatSensitiveRouteAuthorized`.
 *   - SSE allows `?token=...` as an alternative to the auth header, via
 *     `isStreamAuthorized`.
 */

import type http from "node:http";
import { deviceBridge } from "../services/local-inference/device-bridge";
import {
  handlerRegistry,
  toPublicRegistration,
} from "../services/local-inference/handler-registry";
import { snapshotProviders } from "../services/local-inference/providers";
import {
  type RoutingPolicy,
  readRoutingPreferences,
  setPolicy,
  setPreferredProvider,
} from "../services/local-inference/routing-preferences";
import { localInferenceService } from "../services/local-inference/service";
import type {
  AgentModelSlot,
  CatalogModel,
} from "../services/local-inference/types";
import { AGENT_MODEL_SLOTS } from "../services/local-inference/types";
import {
  ensureCompatSensitiveRouteAuthorized,
  ensureRouteAuthorized,
  getCompatApiToken,
  getProvidedApiToken,
  tokenMatches,
} from "./auth";
import {
  type CompatRuntimeState,
  readCompatJsonBody,
} from "./compat-route-shared";
import {
  sendJsonError as sendJsonErrorResponse,
  sendJson as sendJsonResponse,
} from "./response";

function isCatalogModel(value: unknown): value is CatalogModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<CatalogModel>;
  return (
    typeof record.id === "string" &&
    typeof record.displayName === "string" &&
    typeof record.hfRepo === "string" &&
    typeof record.ggufFile === "string" &&
    typeof record.params === "string" &&
    typeof record.quant === "string" &&
    typeof record.sizeGb === "number" &&
    typeof record.minRamGb === "number" &&
    typeof record.category === "string" &&
    typeof record.bucket === "string" &&
    typeof record.blurb === "string"
  );
}

function isStreamAuthorized(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): boolean {
  const expected = getCompatApiToken();
  if (!expected) return true;

  const headerToken = getProvidedApiToken(req);
  const queryToken = url.searchParams.get("token")?.trim();
  if (
    (headerToken && tokenMatches(expected, headerToken)) ||
    (queryToken && tokenMatches(expected, queryToken))
  ) {
    return true;
  }

  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
  return false;
}

function writeSseEvent(
  res: http.ServerResponse,
  payload: Record<string, unknown>,
): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function stringBody(
  body: Record<string, unknown> | null,
  key: string,
): string | null {
  if (!body) return null;
  const raw = body[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * Match POST/DELETE/GET for `/api/local-inference/installed/:id`.
 * Returns the trimmed id or null.
 */
function matchInstalledId(pathname: string): string | null {
  const match = /^\/api\/local-inference\/installed\/([^/]+)$/.exec(pathname);
  return match?.[1] ?? null;
}

export async function handleLocalInferenceCompatRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (!pathname.startsWith("/api/local-inference/")) return false;

  // ── SSE: download progress stream ───────────────────────────────────
  if (
    method === "GET" &&
    pathname === "/api/local-inference/downloads/stream"
  ) {
    if (!isStreamAuthorized(req, res, url)) return true;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Send initial snapshot so a freshly-opened stream immediately reflects
    // whatever is in flight.
    writeSseEvent(res, {
      type: "snapshot",
      downloads: localInferenceService.getDownloads(),
      active: localInferenceService.getActive(),
    });

    const unsubscribeDownloads = localInferenceService.subscribeDownloads(
      (event) => {
        writeSseEvent(res, {
          type: event.type,
          job: event.job,
        });
      },
    );
    const unsubscribeActive = localInferenceService.subscribeActive(
      (active) => {
        writeSseEvent(res, {
          type: "active",
          active,
        });
      },
    );

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 15_000);
    if (typeof heartbeat === "object" && "unref" in heartbeat) {
      heartbeat.unref();
    }

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribeDownloads();
      unsubscribeActive();
    };
    req.on("close", cleanup);
    req.on("aborted", cleanup);
    return true;
  }

  // ── GET: full hub snapshot (catalog + installed + hardware + state) ─
  if (method === "GET" && pathname === "/api/local-inference/hub") {
    if (!(await ensureRouteAuthorized(req, res, state))) return true;
    try {
      const snapshot = await localInferenceService.snapshot();
      sendJsonResponse(res, 200, snapshot);
    } catch (err) {
      sendJsonErrorResponse(
        res,
        500,
        err instanceof Error ? err.message : "Failed to load hub",
      );
    }
    return true;
  }

  // ── GET: hardware probe only ────────────────────────────────────────
  if (method === "GET" && pathname === "/api/local-inference/hardware") {
    if (!(await ensureRouteAuthorized(req, res, state))) return true;
    try {
      const probe = await localInferenceService.getHardware();
      sendJsonResponse(res, 200, probe);
    } catch (err) {
      sendJsonErrorResponse(
        res,
        500,
        err instanceof Error ? err.message : "Failed to probe hardware",
      );
    }
    return true;
  }

  // ── GET: curated catalog ────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/local-inference/catalog") {
    if (!(await ensureRouteAuthorized(req, res, state))) return true;
    sendJsonResponse(res, 200, {
      models: localInferenceService.getCatalog(),
    });
    return true;
  }

  // ── GET: installed models ───────────────────────────────────────────
  if (method === "GET" && pathname === "/api/local-inference/installed") {
    if (!(await ensureRouteAuthorized(req, res, state))) return true;
    try {
      const models = await localInferenceService.getInstalled();
      sendJsonResponse(res, 200, { models });
    } catch (err) {
      sendJsonErrorResponse(
        res,
        500,
        err instanceof Error ? err.message : "Failed to list installed models",
      );
    }
    return true;
  }

  // ── POST: start download ────────────────────────────────────────────
  // Body: either `{ modelId }` for a curated entry, or
  // `{ spec: CatalogModel }` for a HuggingFace-search result.
  if (method === "POST" && pathname === "/api/local-inference/downloads") {
    if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
    const body = await readCompatJsonBody(req, res);
    if (!body) return true;
    const modelId = stringBody(body, "modelId");
    const rawSpec = body.spec;
    try {
      let job: Awaited<ReturnType<typeof localInferenceService.startDownload>>;
      if (rawSpec) {
        if (!isCatalogModel(rawSpec)) {
          sendJsonErrorResponse(res, 400, "Invalid model spec");
          return true;
        }
        job = await localInferenceService.startDownload(rawSpec);
      } else if (modelId) {
        job = await localInferenceService.startDownload(modelId);
      } else {
        sendJsonErrorResponse(res, 400, "modelId or spec is required");
        return true;
      }
      sendJsonResponse(res, 202, { job });
    } catch (err) {
      sendJsonErrorResponse(
        res,
        400,
        err instanceof Error ? err.message : "Failed to start download",
      );
    }
    return true;
  }

  // ── GET: provider status snapshot ──────────────────────────────────
  if (method === "GET" && pathname === "/api/local-inference/providers") {
    if (!(await ensureRouteAuthorized(req, res, state))) return true;
    try {
      const providers = await snapshotProviders();
      sendJsonResponse(res, 200, { providers });
    } catch (err) {
      sendJsonErrorResponse(
        res,
        500,
        err instanceof Error ? err.message : "Failed to read providers",
      );
    }
    return true;
  }

  // ── GET: registered model handlers across all providers ────────────
  if (method === "GET" && pathname === "/api/local-inference/routing") {
    if (!(await ensureRouteAuthorized(req, res, state))) return true;
    try {
      const [prefs, registrations] = await Promise.all([
        readRoutingPreferences(),
        Promise.resolve(handlerRegistry.getAll().map(toPublicRegistration)),
      ]);
      sendJsonResponse(res, 200, {
        registrations,
        preferences: prefs,
      });
    } catch (err) {
      sendJsonErrorResponse(
        res,
        500,
        err instanceof Error ? err.message : "Failed to read routing state",
      );
    }
    return true;
  }

  // ── POST: set preferred provider for a slot (manual override) ──────
  if (
    method === "POST" &&
    pathname === "/api/local-inference/routing/preferred"
  ) {
    if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
    const body = await readCompatJsonBody(req, res);
    if (!body) return true;
    const slot = stringBody(body, "slot") as AgentModelSlot | null;
    if (!slot || !AGENT_MODEL_SLOTS.includes(slot)) {
      sendJsonErrorResponse(
        res,
        400,
        "slot is required and must be a valid AgentModelSlot",
      );
      return true;
    }
    const raw = body.provider;
    const provider =
      raw === null
        ? null
        : typeof raw === "string" && raw.trim().length > 0
          ? raw.trim()
          : null;
    try {
      const prefs = await setPreferredProvider(slot, provider);
      sendJsonResponse(res, 200, { preferences: prefs });
    } catch (err) {
      sendJsonErrorResponse(
        res,
        500,
        err instanceof Error
          ? err.message
          : "Failed to write preferred provider",
      );
    }
    return true;
  }

  // ── POST: set routing policy for a slot ─────────────────────────────
  if (method === "POST" && pathname === "/api/local-inference/routing/policy") {
    if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
    const body = await readCompatJsonBody(req, res);
    if (!body) return true;
    const slot = stringBody(body, "slot") as AgentModelSlot | null;
    if (!slot || !AGENT_MODEL_SLOTS.includes(slot)) {
      sendJsonErrorResponse(
        res,
        400,
        "slot is required and must be a valid AgentModelSlot",
      );
      return true;
    }
    const raw = body.policy;
    const validPolicies: RoutingPolicy[] = [
      "manual",
      "cheapest",
      "fastest",
      "prefer-local",
      "round-robin",
    ];
    const policy =
      raw === null
        ? null
        : typeof raw === "string" &&
            validPolicies.includes(raw as RoutingPolicy)
          ? (raw as RoutingPolicy)
          : null;
    if (raw !== null && policy === null) {
      sendJsonErrorResponse(
        res,
        400,
        `policy must be one of ${validPolicies.join(", ")} or null`,
      );
      return true;
    }
    try {
      const prefs = await setPolicy(slot, policy);
      sendJsonResponse(res, 200, { preferences: prefs });
    } catch (err) {
      sendJsonErrorResponse(
        res,
        500,
        err instanceof Error ? err.message : "Failed to write routing policy",
      );
    }
    return true;
  }

  // ── GET: model-type assignments ─────────────────────────────────────
  if (method === "GET" && pathname === "/api/local-inference/assignments") {
    if (!(await ensureRouteAuthorized(req, res, state))) return true;
    try {
      const assignments = await localInferenceService.getAssignments();
      sendJsonResponse(res, 200, { assignments });
    } catch (err) {
      sendJsonErrorResponse(
        res,
        500,
        err instanceof Error ? err.message : "Failed to read assignments",
      );
    }
    return true;
  }

  // ── POST: set / clear a model-type assignment ───────────────────────
  if (method === "POST" && pathname === "/api/local-inference/assignments") {
    if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
    const body = await readCompatJsonBody(req, res);
    if (!body) return true;
    const slot = stringBody(body, "slot") as AgentModelSlot | null;
    if (!slot || !AGENT_MODEL_SLOTS.includes(slot)) {
      sendJsonErrorResponse(
        res,
        400,
        `slot must be one of ${AGENT_MODEL_SLOTS.join(", ")}`,
      );
      return true;
    }
    // modelId can be null to clear the slot
    const rawModelId = body.modelId;
    const modelId =
      rawModelId === null
        ? null
        : typeof rawModelId === "string" && rawModelId.trim().length > 0
          ? rawModelId.trim()
          : null;
    try {
      const assignments = await localInferenceService.setSlotAssignment(
        slot,
        modelId,
      );
      sendJsonResponse(res, 200, { assignments });
    } catch (err) {
      sendJsonErrorResponse(
        res,
        500,
        err instanceof Error ? err.message : "Failed to write assignment",
      );
    }
    return true;
  }

  // ── GET: device bridge status (paired mobile device connectivity) ───
  if (method === "GET" && pathname === "/api/local-inference/device") {
    if (!(await ensureRouteAuthorized(req, res, state))) return true;
    sendJsonResponse(res, 200, deviceBridge.status());
    return true;
  }

  // ── SSE: device bridge status stream ────────────────────────────────
  if (method === "GET" && pathname === "/api/local-inference/device/stream") {
    if (!isStreamAuthorized(req, res, url)) return true;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    writeSseEvent(res, { type: "status", status: deviceBridge.status() });
    const unsubscribe = deviceBridge.subscribeStatus((status) => {
      writeSseEvent(res, { type: "status", status });
    });
    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 15_000);
    if (typeof heartbeat === "object" && "unref" in heartbeat) {
      heartbeat.unref();
    }
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", cleanup);
    req.on("aborted", cleanup);
    return true;
  }

  // ── GET: HuggingFace search ─────────────────────────────────────────
  if (method === "GET" && pathname === "/api/local-inference/hf-search") {
    if (!(await ensureRouteAuthorized(req, res, state))) return true;
    const q = url.searchParams.get("q")?.trim() ?? "";
    if (q.length === 0) {
      sendJsonResponse(res, 200, { models: [] });
      return true;
    }
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw
      ? Math.max(1, Math.min(50, Number.parseInt(limitRaw, 10) || 12))
      : 12;
    try {
      const models = await localInferenceService.searchHuggingFace(q, limit);
      sendJsonResponse(res, 200, { models });
    } catch (err) {
      sendJsonErrorResponse(
        res,
        502,
        err instanceof Error ? err.message : "HuggingFace search failed",
      );
    }
    return true;
  }

  // ── DELETE: cancel download ─────────────────────────────────────────
  {
    const match = /^\/api\/local-inference\/downloads\/([^/]+)$/.exec(pathname);
    if (method === "DELETE" && match) {
      if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
      const cancelled = localInferenceService.cancelDownload(match[1] ?? "");
      sendJsonResponse(res, cancelled ? 200 : 404, { cancelled });
      return true;
    }
  }

  // ── GET: active model ───────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/local-inference/active") {
    if (!(await ensureRouteAuthorized(req, res, state))) return true;
    sendJsonResponse(res, 200, localInferenceService.getActive());
    return true;
  }

  // ── POST: switch active model ───────────────────────────────────────
  if (method === "POST" && pathname === "/api/local-inference/active") {
    if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
    const body = await readCompatJsonBody(req, res);
    if (!body) return true;
    const modelId = stringBody(body, "modelId");
    if (!modelId) {
      sendJsonErrorResponse(res, 400, "modelId is required");
      return true;
    }
    try {
      const active = await localInferenceService.setActive(
        state.current,
        modelId,
      );
      sendJsonResponse(res, 200, active);
    } catch (err) {
      sendJsonErrorResponse(
        res,
        400,
        err instanceof Error ? err.message : "Failed to set active model",
      );
    }
    return true;
  }

  // ── DELETE: clear active model ──────────────────────────────────────
  if (method === "DELETE" && pathname === "/api/local-inference/active") {
    if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
    try {
      const active = await localInferenceService.clearActive(state.current);
      sendJsonResponse(res, 200, active);
    } catch (err) {
      sendJsonErrorResponse(
        res,
        500,
        err instanceof Error ? err.message : "Failed to unload model",
      );
    }
    return true;
  }

  // ── POST: verify installed model ────────────────────────────────────
  {
    const match = /^\/api\/local-inference\/installed\/([^/]+)\/verify$/.exec(
      pathname,
    );
    if (method === "POST" && match) {
      if (!(await ensureRouteAuthorized(req, res, state))) return true;
      try {
        const result = await localInferenceService.verifyModel(match[1] ?? "");
        sendJsonResponse(res, 200, result);
      } catch (err) {
        sendJsonErrorResponse(
          res,
          404,
          err instanceof Error ? err.message : "Failed to verify model",
        );
      }
      return true;
    }
  }

  // ── DELETE: uninstall model ─────────────────────────────────────────
  {
    const id = matchInstalledId(pathname);
    if (method === "DELETE" && id) {
      if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
      try {
        const result = await localInferenceService.uninstall(id);
        if (result.removed) {
          sendJsonResponse(res, 200, { removed: true });
        } else if (result.reason === "external") {
          sendJsonErrorResponse(
            res,
            409,
            "Model was discovered from another tool; Eliza will not delete files it does not own",
          );
        } else {
          sendJsonErrorResponse(res, 404, "Model not installed");
        }
      } catch (err) {
        sendJsonErrorResponse(
          res,
          500,
          err instanceof Error ? err.message : "Failed to uninstall model",
        );
      }
      return true;
    }
  }

  return false;
}
