/** Verifies the canonical API client carries cookie-session CSRF on mutations. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../config/boot-config";
import { ElizaClient } from "./client-base";
import type { AgentRequestTransport } from "./transport";

function makeClient(baseUrl = "https://agent.example") {
  const request = vi.fn<AgentRequestTransport["request"]>(
    async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const client = new ElizaClient(baseUrl);
  client.setRequestTransport({ request });
  return { client, request };
}

describe("ElizaClient browser-session request auth", () => {
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );

  beforeEach(() => {
    setBootConfig({ branding: {} });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { cookie: "eliza_csrf=csrf-token" },
    });
  });

  afterEach(() => {
    if (originalDocument) {
      Object.defineProperty(globalThis, "document", originalDocument);
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
    vi.clearAllMocks();
  });

  it("mirrors CSRF and includes cookies on ordinary agent mutations", async () => {
    const { client, request } = makeClient();

    await client.fetch("/api/settings", { method: "PATCH" });

    const init = request.mock.calls[0]?.[1];
    expect(init?.credentials).toBe("include");
    expect(new Headers(init?.headers).get("x-eliza-csrf")).toBe("csrf-token");
  });

  it("does not attach CSRF to reads", async () => {
    const { client, request } = makeClient();

    await client.fetch("/api/status");

    const init = request.mock.calls[0]?.[1];
    expect(init?.credentials).toBe("include");
    expect(new Headers(init?.headers).has("x-eliza-csrf")).toBe(false);
  });

  it("omits both cookie credentials and CSRF on dedicated agents", async () => {
    const { client, request } = makeClient("https://agent-123.cloud.eliza.app");

    await client.fetch("/api/settings", { method: "PATCH" });

    const init = request.mock.calls[0]?.[1];
    expect(init?.credentials).toBe("omit");
    expect(new Headers(init?.headers).has("x-eliza-csrf")).toBe(false);
  });
});
