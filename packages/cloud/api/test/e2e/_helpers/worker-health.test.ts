import { describe, expect, test } from "bun:test";
import { waitForWorkerHealth } from "./worker-health";

describe("waitForWorkerHealth", () => {
  test("recovers from one transient 500 only after the owned receipt answers", async () => {
    const responses = [
      new Response("Internal Server Error", {
        status: 500,
        headers: {
          "content-type": "text/plain; charset=UTF-8",
          server: "workerd",
        },
      }),
      Response.json({ status: "ok", e2eRunReceipt: "owned-run" }),
    ];

    const result = await waitForWorkerHealth({
      baseUrl: "http://127.0.0.1:41234",
      expectedReceipt: "owned-run",
      timeoutMs: 100,
      retryIntervalMs: 1,
      fetchImpl: async () => responses.shift() ?? responses[0],
    });

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({
      status: 500,
      server: "workerd",
      bodyPreview: "Internal Server Error",
      receipt: null,
    });
    expect(result.attempts[0]?.bodySha256).toHaveLength(64);
    expect(result.attempts[1]).toMatchObject({
      status: 200,
      receipt: "owned-run",
    });
  });

  test("rejects a healthy response from the wrong listener", async () => {
    await expect(
      waitForWorkerHealth({
        baseUrl: "http://127.0.0.1:41234",
        expectedReceipt: "owned-run",
        timeoutMs: 5,
        retryIntervalMs: 1,
        fetchImpl: async () =>
          Response.json({ status: "ok", e2eRunReceipt: "other-run" }),
      }),
    ).rejects.toThrow(/receipt owned-run/);
  });

  test("fails immediately when the owned Worker wrapper exited", async () => {
    let fetched = false;
    await expect(
      waitForWorkerHealth({
        baseUrl: "http://127.0.0.1:41234",
        expectedReceipt: "owned-run",
        serverPid: 42,
        isProcessAlive: () => false,
        fetchImpl: async () => {
          fetched = true;
          return Response.json({ status: "ok", e2eRunReceipt: "owned-run" });
        },
      }),
    ).rejects.toThrow(/process 42 exited/);
    expect(fetched).toBe(false);
  });
});
