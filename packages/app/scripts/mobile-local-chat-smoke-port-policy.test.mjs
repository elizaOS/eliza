/**
 * Covers the host command contract that opts Android acceptance builds into
 * the bearer-protected loopback API and reliably removes that override.
 */
import { afterAll, describe, expect, it } from "bun:test";

const originalArgv = process.argv;
process.argv = [
  "bun",
  "mobile-local-chat-smoke-port-policy.test.mjs",
  "--platform",
  "unit-test",
];
const smoke = await import("./mobile-local-chat-smoke.mjs");
process.argv = originalArgv;

afterAll(() => {
  process.argv = originalArgv;
});

describe("Android acceptance API port policy", () => {
  it("builds explicit enable and cleanup setprop commands", () => {
    expect(smoke.androidE2eApiPortOverrideArgs("serial", true)).toEqual([
      "-s",
      "serial",
      "shell",
      "setprop",
      "debug.eliza.api_expose_port",
      "1",
    ]);
    expect(smoke.androidE2eApiPortOverrideArgs("serial", false)).toEqual([
      "-s",
      "serial",
      "shell",
      "setprop",
      "debug.eliza.api_expose_port",
      "0",
    ]);
  });

  it("clears the override when launch preparation fails after enablement", async () => {
    const calls = [];
    const launchFailure = new Error("model staging failed");
    const context = { adb: "adb", serial: "serial", installed: true };

    await expect(
      smoke.withAndroidE2eApiPortOverride(
        context,
        async () => {
          calls.push("prepare");
          throw launchFailure;
        },
        (target, enabled) => {
          calls.push(enabled ? "enable" : "clear");
          target.e2eApiPortOverride = enabled;
        },
      ),
    ).rejects.toBe(launchFailure);

    expect(calls).toEqual(["enable", "prepare", "clear"]);
    expect(context.e2eApiPortOverride).toBe(false);
  });

  it("uses authenticated status details when health is topology-trimmed", async () => {
    let uptime = 10;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        expect(request.headers.get("authorization")).toBe("Bearer secret");
        if (url.pathname === "/api/status") {
          uptime += 1;
          return Response.json({
            state: "running",
            canRespond: true,
            uptime,
            startup: { attempt: 1 },
          });
        }
        if (url.pathname === "/api/health") {
          return Response.json({ ready: true });
        }
        return new Response("missing", { status: 404 });
      },
    });
    try {
      await expect(
        smoke.waitForAndroidProcessStability(
          server.url.toString().replace(/\/$/, ""),
          "secret",
        ),
      ).resolves.toMatchObject({ state: "running", canRespond: true });
    } finally {
      server.stop(true);
    }
  });
});
