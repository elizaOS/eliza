/**
 * n8n dispatch service — executes an n8n workflow by id.
 *
 * Consumed by the trigger dispatcher (Track F1) at boot: triggers carrying
 * `kind: "workflow"` resolve a workflow id and call
 *   runtime.getService("N8N_DISPATCH").execute(workflowId).
 *
 * Mode selection mirrors n8n-routes proxy:
 *   - Cloud mode → POST ${cloudBaseUrl}/api/v1/agents/${agentId}/n8n/workflows/{id}/execute
 *                  Authorization: Bearer ${cloud.apiKey}
 *   - Local mode → POST ${sidecar.host}/rest/workflows/{id}/run
 *                  X-N8N-API-KEY: ${sidecar.getApiKey()}
 *   - Disabled   → immediate `{ ok: false, error: "n8n disabled" }` (no fetch)
 *
 * This module is I/O only — it does not own the sidecar lifecycle, and
 * does not probe readiness. Readiness for the local path is asserted by the
 * presence of a host + api key; callers that want a readiness guarantee
 * should ensure the autostart handle has completed before dispatch.
 */

import type { AgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { isNativeServerPlatform } from "../platform/is-native-server.js";
import { type N8nModeConfigLike, resolveN8nMode } from "./n8n-mode.js";
import { peekN8nSidecar } from "./n8n-sidecar.js";

/**
 * Subset of ElizaConfig the dispatch service reads. Shares shape with
 * n8n-mode / n8n-autostart so the same `loadElizaConfig()` output feeds
 * all three.
 */
export interface N8nDispatchConfigLike extends N8nModeConfigLike {
  cloud?: {
    enabled?: boolean;
    apiKey?: string;
    baseUrl?: string;
  };
  n8n?: {
    localEnabled?: boolean;
    host?: string | null;
    apiKey?: string;
  };
}

export interface N8nDispatchResult {
  ok: boolean;
  error?: string;
  executionId?: string;
}

export interface N8nDispatchService {
  execute(
    workflowId: string,
    payload?: Record<string, unknown>,
  ): Promise<N8nDispatchResult>;
}

export interface CreateN8nDispatchServiceOptions {
  runtime: AgentRuntime;
  /**
   * Supplies the most recent config so cloud/local settings are read fresh
   * at every dispatch rather than captured at service-creation time. This
   * matches the pattern used by n8n-auth-bridge and n8n-autostart.
   */
  getConfig: () => N8nDispatchConfigLike;
  /** Fetch override for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Override for native-platform detection. Defaults to
   * `isNativeServerPlatform()`. Tests inject a deterministic value.
   */
  isNativePlatform?: () => boolean;
  /**
   * Override for the sidecar peek. Defaults to `peekN8nSidecar()`. Tests
   * inject a stub that returns host + api key without spawning a child.
   */
  peekSidecar?: () => {
    getState: () => { host: string | null };
    getApiKey: () => string | null;
  } | null;
  /**
   * Override the agent-id resolver used in the cloud-mode proxy URL.
   * Defaults to `runtime.agentId` with a zero-uuid fallback. Tests inject
   * a deterministic value.
   */
  resolveAgentId?: (runtime: AgentRuntime) => string;
}

const DEFAULT_CLOUD_API_BASE_URL = "https://api.eliza.how";
const ZERO_AGENT_ID = "00000000-0000-0000-0000-000000000000";

function normalizeBaseUrl(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim();
  const base = trimmed.length > 0 ? trimmed : DEFAULT_CLOUD_API_BASE_URL;
  return base.replace(/\/+$/, "");
}

function defaultResolveAgentId(runtime: AgentRuntime): string {
  const ref = runtime as unknown as {
    agentId?: string;
    character?: { id?: string };
  };
  return ref.agentId ?? ref.character?.id ?? ZERO_AGENT_ID;
}

function extractExecutionId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const obj = body as Record<string, unknown>;
  const candidates = [obj.executionId, obj.execution_id];
  const data = obj.data;
  if (data && typeof data === "object") {
    const dataObj = data as Record<string, unknown>;
    candidates.push(dataObj.executionId, dataObj.execution_id, dataObj.id);
  }
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return undefined;
}

async function readJsonBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Construct the dispatch service. The returned value is registered under
 * `"N8N_DISPATCH"` on the runtime by `ensureN8nDispatchService` in
 * runtime/eliza.ts.
 */
export function createN8nDispatchService(
  options: CreateN8nDispatchServiceOptions,
): N8nDispatchService {
  const {
    runtime,
    getConfig,
    fetchImpl = fetch,
    isNativePlatform = isNativeServerPlatform,
    peekSidecar = peekN8nSidecar,
    resolveAgentId = defaultResolveAgentId,
  } = options;

  const execute = async (
    workflowId: string,
    payload: Record<string, unknown> = {},
  ): Promise<N8nDispatchResult> => {
    const id = workflowId.trim();
    if (!id) {
      return { ok: false, error: "workflow id required" };
    }

    const config = getConfig();
    const native = isNativePlatform();
    const { mode } = resolveN8nMode({ config, runtime, native });

    if (mode === "disabled") {
      return { ok: false, error: "n8n disabled" };
    }

    let url: string;
    let headers: Record<string, string>;

    if (mode === "cloud") {
      const apiKey = config.cloud?.apiKey?.trim();
      if (!apiKey) {
        return { ok: false, error: "n8n cloud api key missing" };
      }
      const baseUrl = normalizeBaseUrl(config.cloud?.baseUrl);
      const agentId = resolveAgentId(runtime);
      url = `${baseUrl}/api/v1/agents/${encodeURIComponent(
        agentId,
      )}/n8n/workflows/${encodeURIComponent(id)}/execute`;
      headers = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      };
    } else {
      // mode === "local"
      const sidecar = peekSidecar();
      const host = sidecar?.getState().host ?? config.n8n?.host ?? null;
      if (!host) {
        return { ok: false, error: "n8n local host unknown" };
      }
      const apiKey = sidecar?.getApiKey() ?? config.n8n?.apiKey ?? null;
      if (!apiKey) {
        return { ok: false, error: "n8n local api key missing" };
      }
      url = `${host.replace(/\/+$/, "")}/rest/workflows/${encodeURIComponent(
        id,
      )}/run`;
      headers = {
        "X-N8N-API-KEY": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      };
    }

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[n8n-dispatch] fetch failed for workflow ${id}: ${message}`);
      return { ok: false, error: `n8n fetch failed: ${message}` };
    }

    if (!res.ok) {
      return {
        ok: false,
        error: `n8n returned ${res.status}: ${res.statusText}`,
      };
    }

    const body = await readJsonBody(res);
    const executionId = extractExecutionId(body);
    return executionId ? { ok: true, executionId } : { ok: true };
  };

  return { execute };
}
