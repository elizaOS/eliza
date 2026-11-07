import { describe, expect, test } from "bun:test";
import {
  BridgeConfigurationError,
  containerSettings,
  forwardBridgeRequest,
} from "./bridge";

describe("Cloudflare Redis HTTP bridge", () => {
  test("rejects unauthenticated requests without starting the container", async () => {
    let calls = 0;
    const forward = async () => {
      calls++;
      return new Response("unexpected");
    };
    for (const authorization of ["", "Bearer wrong", "Bearer secretX"]) {
      const response = await forwardBridgeRequest(
        new Request("https://bridge.test/pipeline", {
          headers: { Authorization: authorization },
        }),
        "secret",
        forward,
      );
      expect(response.status).toBe(401);
    }
    expect(
      (
        await forwardBridgeRequest(
          new Request("https://bridge.test"),
          undefined,
          forward,
        )
      ).status,
    ).toBe(503);
    expect(calls).toBe(0);
  });

  test("preserves the authenticated pipeline and response encoding", async () => {
    const request = new Request("https://bridge.test/pipeline", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
        "Upstash-Encoding": "base64",
      },
      body: JSON.stringify([
        ["GET", "receipt"],
        ["PTTL", "receipt"],
      ]),
    });
    const upstream = new Response(
      '[{"result":"cGVuZGluZw=="},{"result":123}]',
      {
        headers: { "Content-Type": "application/json" },
      },
    );
    const response = await forwardBridgeRequest(
      request,
      "secret",
      async (received) => {
        expect(received).toBe(request);
        expect(received.headers.get("Upstash-Encoding")).toBe("base64");
        expect(await received.text()).toBe(
          JSON.stringify([
            ["GET", "receipt"],
            ["PTTL", "receipt"],
          ]),
        );
        return upstream;
      },
    );
    expect(response).toBe(upstream);
  });

  test("does not retry an ambiguous write or hide upstream errors", async () => {
    let calls = 0;
    const request = new Request("https://bridge.test", {
      headers: { Authorization: "Bearer secret" },
    });
    await expect(
      forwardBridgeRequest(request, "secret", async () => {
        calls++;
        throw new Error("connection lost after write");
      }),
    ).rejects.toThrow("connection lost after write");
    expect(calls).toBe(1);
    const failure = new Response("upstream unavailable", { status: 503 });
    expect(
      await forwardBridgeRequest(request, "secret", async () => failure),
    ).toBe(failure);
  });

  test("requires externally reachable Redis and passes only owned settings", () => {
    for (const url of [
      "invalid",
      "https://redis.test",
      "redis://redis.railway.internal",
    ]) {
      expect(() =>
        containerSettings({ SRH_TOKEN: "secret", SRH_CONNECTION_STRING: url }),
      ).toThrow(BridgeConfigurationError);
    }
    const settings = {
      SRH_TOKEN: "secret",
      SRH_CONNECTION_STRING: "rediss://user:password@redis.test:6379",
      UNRELATED_SECRET: "never-forward",
    };
    expect(containerSettings(settings)).toEqual({
      SRH_MODE: "env",
      SRH_TOKEN: settings.SRH_TOKEN,
      SRH_CONNECTION_STRING: settings.SRH_CONNECTION_STRING,
      PORT: "80",
      SRH_PORT: "80",
    });
  });
});
