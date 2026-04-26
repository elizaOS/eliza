import { ElizaClient } from "@elizaos/app-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/api/client-lifeops.js";

type CapturedRequest = {
  init: RequestInit | undefined;
  url: string;
};

function parseJsonBody(
  body: BodyInit | null | undefined,
): Record<string, unknown> {
  if (typeof body !== "string") {
    throw new Error("Expected JSON string request body");
  }
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected JSON object request body");
  }
  return Object.fromEntries(Object.entries(parsed));
}

describe("LifeOps activity signal client", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const requests: CapturedRequest[] = [];

  beforeEach(() => {
    requests.length = 0;
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        requests.push({
          url: typeof input === "string" ? input : input.toString(),
          init,
        });
        return new Response(
          JSON.stringify({
            signal: {
              id: "signal-1",
              source: "mobile_device",
              platform: "mobile_app",
              state: "active",
              observedAt: "2026-04-20T14:00:00.000Z",
              createdAt: "2026-04-20T14:00:00.000Z",
              metadata: {},
            },
          }),
          {
            status: 201,
            headers: { "Content-Type": "application/json" },
          },
        );
      });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("posts mobile activity to a configured private-network agent with bearer auth", async () => {
    const client = new ElizaClient("http://192.168.1.2:31337", "remote-token");

    await client.captureLifeOpsActivitySignal({
      source: "mobile_device",
      platform: "mobile_app",
      state: "active",
      observedAt: "2026-04-20T14:00:00.000Z",
      idleState: "unlocked",
      idleTimeSeconds: 0,
      onBattery: true,
      metadata: {
        deviceId: "iphone-owner",
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "http://192.168.1.2:31337/api/lifeops/activity-signals",
    );
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer remote-token");
    expect(headers.get("Content-Type")).toBe("application/json");

    const body = parseJsonBody(requests[0]?.init?.body);
    expect(body.source).toBe("mobile_device");
    expect(body.platform).toBe("mobile_app");
    expect(body.metadata).toEqual({ deviceId: "iphone-owner" });
  });
});
