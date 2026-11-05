/**
 * Regression guard for the capability-router trust-audit contract: the module
 * documents "a bounded trust-audit trail", but every persisted connect
 * appended one full record to ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT with no
 * cap — unbounded growth in the owner's config and growing per-connect
 * validation cost on the path that re-reads (and fail-closed re-validates)
 * the whole trail before each write.
 *
 * Drives the real POST /api/capability-router/connect handler end to end —
 * the real persist path (read, validate, merge, serialize, config write) over
 * an injected endpoint provider, the route's designed seam; the transport to
 * the remote endpoint is the only boundary replaced.
 */
import type http from "node:http";
import type { IAgentRuntime, JsonObject } from "@elizaos/core";
import { AgentRuntime } from "@elizaos/core";
import { expect, it } from "vitest";
import {
  handleRemoteCapabilityRoutes,
  type RemoteCapabilityRouteContext,
} from "../src/api/remote-capability-routes.ts";

const CONNECTS = 105;
const TRUST_AUDIT_KEY = "ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT";
const TRUST_AUDIT_LIMIT = 100;

it("caps the persisted trust-audit trail at the newest records", async () => {
  const runtime: IAgentRuntime = new AgentRuntime({
    character: { name: "trust-audit-guard", bio: [] },
    logLevel: "fatal",
  });
  const config: { env?: { vars?: Record<string, string> } } = {};
  const persistedEnv: Record<string, string> = {};
  const responses: JsonObject[] = [];
  let body: Record<string, unknown> = {};

  const ctx: RemoteCapabilityRouteContext = {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "POST",
    pathname: "/api/capability-router/connect",
    runtime,
    config,
    saveConfig: (next) => {
      config.env = next.env;
    },
    persistConfigEnv: async (key, value) => {
      persistedEnv[key] = value;
    },
    readJsonBody: async <T = Record<string, unknown>>(
      _req: http.IncomingMessage,
      _res: http.ServerResponse,
      _options?: { requireObject?: boolean },
    ): Promise<T | null> => body as T,
    json: (_res, data) => {
      responses.push(data as JsonObject);
    },
    error: (_res, message, status) => {
      throw new Error(`route error ${status ?? 500}: ${message}`);
    },
    connectEndpointProvider: async (_runtime, options) => ({
      providerId: "direct",
      endpoint: (
        options.provisionOptions as {
          endpoint: {
            id: string;
            baseUrl: string;
            token?: string;
          };
        }
      ).endpoint,
      sync: { registered: [], unloaded: [], skipped: [], trustDecisions: [] },
    }),
  };

  for (let index = 1; index <= CONNECTS; index++) {
    body = {
      endpoint: {
        id: "trust-audit-guard-endpoint",
        baseUrl: "https://trust-audit-guard.example.test",
      },
      persist: true,
      allowedModuleIds: [`guard-module-${index}`],
    };
    const handled = await handleRemoteCapabilityRoutes(ctx);
    expect(handled).toBe(true);
    expect(responses[responses.length - 1]?.success).toBe(true);
  }

  const trail = JSON.parse(config.env?.vars?.[TRUST_AUDIT_KEY] ?? "[]") as {
    allowedModuleIds: string[];
  }[];

  // The trail is capped at the documented bound, not grown per connect.
  expect(trail.length).toBe(TRUST_AUDIT_LIMIT);
  // The cap keeps the NEWEST records — the first retained connect is #6.
  expect(trail[0]?.allowedModuleIds[0]).toBe("guard-module-6");
  expect(trail[trail.length - 1]?.allowedModuleIds[0]).toBe(
    `guard-module-${CONNECTS}`,
  );
  // The endpoint itself is still deduplicated by key: one endpoint, one URL.
  const endpoints = JSON.parse(
    config.env?.vars?.ELIZA_CAPABILITY_ROUTER_URLS ?? "[]",
  ) as unknown[];
  expect(endpoints.length).toBe(1);
  expect(persistedEnv.ELIZA_CAPABILITY_ROUTER_ENABLED).toBe("true");
});
