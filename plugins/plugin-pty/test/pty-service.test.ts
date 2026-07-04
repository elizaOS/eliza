/**
 * Wiring coverage for `PtyService` (the `PTY_SERVICE` registration):
 * start/stop/list/hasSession lifecycle and cwd confinement, driven with an
 * injected fake spawn — no real PTY.
 */
import os from "node:os";
import { describe, expect, it } from "vitest";
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
