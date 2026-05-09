/**
 * n8n dispatch service — executes an n8n workflow by id.
 *
 * Consumed by the trigger dispatcher (Track F1) at boot: triggers carrying
 * `kind: "workflow"` resolve a workflow id and call
 *   runtime.getService("WORKFLOW_DISPATCH").execute(workflowId).
 *
 * Mode selection mirrors n8n-routes proxy:
 *   - Cloud mode → POST ${cloudBaseUrl}/api/v1/agents/${agentId}/n8n/workflows/{id}/execute
 *                  Authorization: Bearer ${cloud.apiKey}
 *   - Local mode → GET workflow via /api/v1 with X-N8N-API-KEY, then
 *                  POST ${sidecar.host}/rest/workflows/{id}/run with the
 *                  local owner n8n-auth cookie. n8n's manual run endpoint is
 *                  an internal UI route and does not accept API-key auth.
 *   - Disabled   → immediate `{ ok: false, error: "n8n disabled" }` (no fetch)
 *
 * This module is I/O only — it does not own the sidecar lifecycle, and
 * does not probe readiness. Readiness for the local path is asserted by the
 * presence of a host + api key; callers that want a readiness guarantee
 * should ensure the autostart handle has completed before dispatch.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { isNativeServerPlatform } from "@elizaos/shared";
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
    stateDir?: string;
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
  /**
   * Local-only auth hook. Tests inject a deterministic cookie; production
   * reads the sidecar owner credentials and logs in to n8n.
   */
  getLocalOwnerCookie?: (
    host: string,
    config: N8nDispatchConfigLike,
  ) => Promise<string | null>;
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

function defaultStateDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.tmpdir();
  return path.join(home, ".eliza", "n8n");
}

function extractAuthCookie(res: Response): string | null {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const list =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (headers.get("set-cookie") ?? "")
          .split(/,(?=\s*[\w-]+=)/)
          .filter((value) => value.length > 0);
  for (const raw of list) {
    const first = raw.split(";")[0]?.trim();
    if (first?.startsWith("n8n-auth=")) return first;
  }
  return null;
}

async function defaultGetLocalOwnerCookie(
  host: string,
  config: N8nDispatchConfigLike,
): Promise<string | null> {
  const stateDir = config.n8n?.stateDir?.trim() || defaultStateDir();
  const ownerPath = path.join(stateDir, "owner.json");
  let owner: { email?: unknown; password?: unknown };
  try {
    owner = JSON.parse(await fs.readFile(ownerPath, "utf-8")) as {
      email?: unknown;
      password?: unknown;
    };
  } catch (error) {
    logger.warn(
      `[n8n-dispatch] failed to read local n8n owner credentials: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }

  if (typeof owner.email !== "string" || typeof owner.password !== "string") {
    return null;
  }

  const response = await fetch(`${host.replace(/\/+$/, "")}/rest/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      emailOrLdapLoginId: owner.email,
      password: owner.password,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch((error: unknown) => {
    logger.warn(
      `[n8n-dispatch] local n8n owner login failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  });

  return response?.ok ? extractAuthCookie(response) : null;
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

function extractWorkflowBody(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  if (obj.data && typeof obj.data === "object") {
    return obj.data as Record<string, unknown>;
  }
  return obj;
}

/**
 * Construct the dispatch service. The returned value is registered under
 * `"WORKFLOW_DISPATCH"` on the runtime by `ensureN8nDispatchService` in
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
    getLocalOwnerCookie = defaultGetLocalOwnerCookie,
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
    let requestBody: Record<string, unknown> = payload;

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

      const baseHost = host.replace(/\/+$/, "");
      const workflowResponse = await fetchImpl(
        `${baseHost}/api/v1/workflows/${encodeURIComponent(id)}`,
        {
          method: "GET",
          headers: {
            "X-N8N-API-KEY": apiKey,
            Accept: "application/json",
          },
        },
      ).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[n8n-dispatch] workflow fetch failed for ${id}: ${message}`,
        );
        return null;
      });
      if (!workflowResponse) {
        return { ok: false, error: "n8n workflow fetch failed" };
      }
      if (!workflowResponse.ok) {
        return {
          ok: false,
          error: `n8n workflow fetch returned ${workflowResponse.status}: ${workflowResponse.statusText}`,
        };
      }
      const workflow = extractWorkflowBody(
        await readJsonBody(workflowResponse),
      );
      if (!workflow) {
        return { ok: false, error: "n8n workflow fetch returned invalid body" };
      }

      const cookie = await getLocalOwnerCookie(baseHost, config);
      if (!cookie) {
        return { ok: false, error: "n8n local owner login failed" };
      }

      url = `${baseHost}/rest/workflows/${encodeURIComponent(
        id,
      )}/run?partialExecutionVersion=1`;
      headers = {
        cookie,
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      requestBody = {
        ...payload,
        workflowData: workflow,
      };
    }

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
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

    const responseBody = await readJsonBody(res);
    const executionId = extractExecutionId(responseBody);
    return executionId ? { ok: true, executionId } : { ok: true };
  };

  return { execute };
}
