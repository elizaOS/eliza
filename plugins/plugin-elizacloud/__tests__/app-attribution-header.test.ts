/**
 * Per-app monetization attribution header (#10423).
 *
 * A deployed Eliza Cloud app container has `ELIZA_APP_ID` injected by the deploy
 * path. Every inference the agent sends to Eliza Cloud must then carry the
 * `X-App-Id` header so the charge lands on the APP's credits + creator earnings,
 * not the caller's own org. `createCloudApiClient` wires this from the runtime
 * setting into the SDK's `defaultHeaders`, so it rides on ALL model paths
 * (chat/responses/embeddings/images) without each one re-plumbing it.
 *
 * Absent `ELIZA_APP_ID`, no header is sent (a normal local agent bills its own
 * org). The cloud independently authorizes the header and soft-falls-back to
 * caller billing for an unauthorized id, so this is attribution, not a trust
 * boundary — but the agent must actually SEND it, which is what this pins.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudApiClient } from "../src/utils/sdk-client";

function makeRuntime(settings: Record<string, string | undefined>): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key],
  } as unknown as IAgentRuntime;
}

/** Install a fetch stub that records the outgoing request and returns 200 JSON. */
function captureFetch(): { calls: Request[] } {
  const calls: Request[] = [];
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input as RequestInfo, init));
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  globalThis.fetch = stub as unknown as typeof fetch;
  return { calls };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const BASE = {
  ELIZAOS_CLOUD_API_KEY: "eliza_test_key",
  ELIZAOS_CLOUD_BASE_URL: "https://elizacloud.ai/api/v1",
};

describe("app attribution header (#10423)", () => {
  it("sends X-App-Id from ELIZA_APP_ID on every cloud request", async () => {
    const { calls } = captureFetch();
    const runtime = makeRuntime({ ...BASE, ELIZA_APP_ID: "app-uuid-123" });

    await createCloudApiClient(runtime).requestRaw("GET", "/models");

    expect(calls.length).toBe(1);
    expect(calls[0].headers.get("X-App-Id")).toBe("app-uuid-123");
    // Auth still rides along — attribution does not displace the caller key.
    expect(calls[0].headers.get("Authorization")).toContain("eliza_test_key");
  });

  it("omits X-App-Id entirely when ELIZA_APP_ID is not set (bills the caller org)", async () => {
    const { calls } = captureFetch();
    const runtime = makeRuntime({ ...BASE });

    await createCloudApiClient(runtime).requestRaw("GET", "/models");

    expect(calls.length).toBe(1);
    expect(calls[0].headers.has("X-App-Id")).toBe(false);
  });

  it("reads ELIZA_APP_ID from runtime settings (not just env)", async () => {
    const { calls } = captureFetch();
    // No env involvement: the value comes from the runtime setting reader.
    const runtime = makeRuntime({ ...BASE, ELIZA_APP_ID: "from-runtime-setting" });

    await createCloudApiClient(runtime, true).requestRaw("GET", "/models");

    expect(calls[0].headers.get("X-App-Id")).toBe("from-runtime-setting");
  });
});
