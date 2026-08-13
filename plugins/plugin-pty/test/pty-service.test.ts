/**
 * Unit coverage for `PtyService` registration, lifecycle, cwd confinement, and
 * startup configuration validation. Session behavior uses an injected fake
 * spawn; configuration cases exercise the real service-start boundary.
 */
import os from "node:os";
import type { ElizaError } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PtyService } from "../services/pty-service";
import type { PtySpawnSpec } from "../services/pty-types";
import { makeFakeSpawn } from "./fake-pty";

function makeService(over?: { allowedRoot?: string }) {
  const fake = makeFakeSpawn();
  const svc = new PtyService(undefined, fake.resolver, {
    allowedRoot: over?.allowedRoot ?? os.tmpdir(),
  });
  return { svc, fake };
}

const spec = (cwd: string): PtySpawnSpec => ({
  command: "bun",
  args: ["/bin/eliza-code.js", "--interactive"],
  cwd,
  kind: "eliza-code",
  label: "eliza-code · fast",
});

function runtimeWithIdleTimeout(value: string | number | boolean | null) {
  return createMockRuntime({
    getSetting: (key) => (key === "PTY_IDLE_TIMEOUT_MS" ? value : null),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PtyService", () => {
  it("registers as the PTY_SERVICE the agent server looks up", () => {
    expect(PtyService.serviceType).toBe("PTY_SERVICE");
  });

  it("exposes a consoleBridge (what getPtyConsoleBridge returns)", () => {
    const { svc } = makeService();
    expect(svc.consoleBridge).toBeDefined();
    expect(typeof svc.consoleBridge.writeRaw).toBe("function");
    expect(typeof svc.consoleBridge.resize).toBe("function");
    expect(typeof svc.consoleBridge.on).toBe("function");
    expect(typeof svc.consoleBridge.off).toBe("function");
    expect(svc.capabilityDescription).toMatch(/interactive/i);
  });

  it("startSession spawns and listSessions reflects it", async () => {
    const { svc, fake } = makeService();
    const info = await svc.startSession(spec(os.tmpdir()));
    expect(fake.calls).toHaveLength(1);
    expect(svc.listSessions().map((s) => s.sessionId)).toContain(
      info.sessionId,
    );
    expect(svc.hasSession(info.sessionId)).toBe(true);
  });

  it("output written to a session's PTY reaches consoleBridge subscribers", async () => {
    const { svc, fake } = makeService();
    const chunks: string[] = [];
    svc.consoleBridge.on("session_output", (e) =>
      chunks.push((e as { data: string }).data),
    );
    const info = await svc.startSession(spec(os.tmpdir()));
    fake.ptys[0].emitData("$ ");
    // and a keystroke round-trips to the PTY through the bridge
    svc.consoleBridge.writeRaw(info.sessionId, "/help\r");
    expect(chunks).toEqual(["$ "]);
    expect(fake.ptys[0].written).toEqual(["/help\r"]);
    expect(svc.getBufferedOutput(info.sessionId)).toBe("$ ");
  });

  it("stopSession kills the process; stop() tears everything down", async () => {
    const { svc, fake } = makeService();
    const a = await svc.startSession(spec(os.tmpdir()));
    await svc.stopSession(a.sessionId);
    expect(fake.ptys[0].killed).toBe(true);
    expect(svc.hasSession(a.sessionId)).toBe(false);

    await svc.startSession(spec(os.tmpdir()));
    await svc.startSession(spec(os.tmpdir()));
    await svc.stop();
    expect(svc.listSessions()).toHaveLength(0);
    expect(fake.ptys.every((p) => p.killed)).toBe(true);
  });
});

describe("PtyService idle-timeout configuration", () => {
  it("starts with the documented default when neither source is configured", async () => {
    vi.stubEnv("PTY_IDLE_TIMEOUT_MS", "");
    const service = await PtyService.start(runtimeWithIdleTimeout(null));
    await service.stop();
  });

  it.each(["0", 0, "900000", 900_000, " 900000 ", 2_147_483_647])(
    "starts with supported timeout value %j",
    async (value) => {
      const service = await PtyService.start(runtimeWithIdleTimeout(value));
      await service.stop();
    },
  );

  it.each([
    "1.5",
    1.5,
    "-1",
    -1,
    "2147483648",
    2_147_483_648,
    "900000oops",
    "1e3",
    true,
  ])("rejects invalid timeout value %j at service startup", async (value) => {
    await expect(
      PtyService.start(runtimeWithIdleTimeout(value)),
    ).rejects.toMatchObject({
      code: "PTY_IDLE_TIMEOUT_INVALID",
      context: {
        configured: value,
        maximum: 2_147_483_647,
        minimum: 0,
        setting: "PTY_IDLE_TIMEOUT_MS",
        source: "runtime",
      },
      severity: "fatal",
    } satisfies Partial<ElizaError>);
  });

  it("validates the environment fallback when the runtime setting is blank", async () => {
    vi.stubEnv("PTY_IDLE_TIMEOUT_MS", "-1");
    await expect(
      PtyService.start(runtimeWithIdleTimeout("")),
    ).rejects.toMatchObject({
      code: "PTY_IDLE_TIMEOUT_INVALID",
      context: { configured: "-1", source: "environment" },
    } satisfies Partial<ElizaError>);
  });

  it("prefers a runtime setting over the environment fallback", async () => {
    vi.stubEnv("PTY_IDLE_TIMEOUT_MS", "-1");
    const service = await PtyService.start(runtimeWithIdleTimeout(" 900000 "));
    await service.stop();
  });
});
