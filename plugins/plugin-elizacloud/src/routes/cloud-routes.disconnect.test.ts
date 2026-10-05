/**
 * Login persists the Cloud API key and identity into the live runtime's
 * settings; disconnect must remove every copy the Cloud model handlers read,
 * not only the secrets map.
 */
import { Readable } from "node:stream";
import type http from "node:http";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "@elizaos/core";
import { handleCloudRoute } from "./cloud-routes";
import { getApiKey } from "../utils/config";

function req(method: string, url: string, body?: unknown): http.IncomingMessage {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage;
  Object.assign(r, { method, url, headers: { host: "localhost" } });
  return r;
}
function res() {
  const out: { status?: number; body?: string } = {};
  const r = {
    statusCode: 200,
    headersSent: false,
    setHeader() {}, getHeader() {}, writeHead(s: number) { out.status = s; return r; },
    end(b?: string) { out.body = b; if (out.status === undefined) out.status = r.statusCode; },
    write() { return true; },
  } as unknown as http.ServerResponse;
  return { r, out };
}

describe("cloud disconnect", () => {
  it("stops the running runtime from resolving the Cloud API key", async () => {
    const savedEnv = { ...process.env };
    for (const k of Object.keys(process.env)) if (k.startsWith("ELIZAOS_CLOUD") || k.startsWith("ELIZA_DEV_CLOUD")) delete process.env[k];
    try {
    const runtime = new AgentRuntime({ character: { name: "t", bio: [], secrets: {}, settings: {} } as never });
    (runtime as unknown as { updateAgent: unknown }).updateAgent = async () => true;
    const config: Record<string, unknown> = {
      serviceRouting: { llmText: { backend: "elizacloud", transport: "cloud-proxy", accountId: "elizacloud" } },
    };
    const state = { config: config as never, cloudManager: null, runtime, services: { saveElizaConfig: () => {} } };

    const a = res();
    await handleCloudRoute(req("POST", "/api/cloud/login/persist", { apiKey: "eliza_secret_KEY", organizationId: "org-1", userId: "u-1" }), a.r, "/api/cloud/login/persist", "POST", state);
    expect(a.out.status).toBe(200);
    expect(getApiKey(runtime)).toBe("eliza_secret_KEY");

    const b = res();
    await handleCloudRoute(req("POST", "/api/cloud/disconnect"), b.r, "/api/cloud/disconnect", "POST", state);
    expect(b.out.status).toBe(200);
    expect(getApiKey(runtime)).toBeUndefined();
    expect(runtime.getSetting("ELIZAOS_CLOUD_USER_ID")).toBeNull();
    expect(runtime.getSetting("ELIZAOS_CLOUD_ORG_ID")).toBeNull();
    } finally {
      process.env = savedEnv;
    }
  });
});
