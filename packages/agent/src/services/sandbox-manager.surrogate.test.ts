/** Surrogate safety for sandbox command event detail in sandbox-manager.ts. */

import { describe, expect, test } from "vitest";
import type {
  ContainerExecOptions,
  ContainerExecResult,
  EngineInfo,
  ISandboxEngine,
} from "./sandbox-engine.ts";
import { SandboxManager } from "./sandbox-manager.ts";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return true;
}

function createFakeEngine(mode: "success" | "throw"): ISandboxEngine {
  return {
    engineType: "docker",
    isAvailable: () => true,
    getInfo: () =>
      ({
        type: "docker",
        available: true,
        version: "test",
        platform: "linux",
        arch: "x64",
        details: "test",
      }) as EngineInfo,
    runContainer: async () => "fake-id",
    execInContainer: async (
      _opts: ContainerExecOptions,
    ): Promise<ContainerExecResult> => {
      if (mode === "throw") throw new Error("fake exec failure");
      return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
    },
    stopContainer: async () => {},
    removeContainer: async () => {},
    isContainerRunning: () => true,
    imageExists: () => true,
    pullImage: async () => {},
    listContainers: () => [],
    healthCheck: async () => true,
  };
}

async function createReadyManager(
  mode: "success" | "throw",
): Promise<SandboxManager> {
  const manager = new SandboxManager({ mode: "standard" });
  (manager as unknown as { engine: ISandboxEngine }).engine =
    createFakeEngine(mode);
  (manager as unknown as { containerId: string | null }).containerId =
    "test-container";
  (manager as unknown as { state: string }).state = "ready";
  return manager;
}

describe("sandbox command detail surrogate safety via SandboxManager", () => {
  test("success detail at 199+fox boundary backs off without lone surrogate", async () => {
    const manager = await createReadyManager("success");
    const fox = "🦊";
    const command = `${"a".repeat(199)}${fox}${"b".repeat(50)}`;
    await manager.exec({ command });
    const execEvent = manager.getEventLog().find((e) => e.type === "exec");
    expect(execEvent).toBeDefined();
    if (!execEvent) throw new Error("missing exec event");
    const detail = execEvent.detail;
    // Production must use truncateWellFormed(toWellFormedUnicode) — substring would leave lone high at 200.
    expect(isWellFormed(detail)).toBe(true);
    expect(detail.length).toBe(199);
    expect(detail).toBe("a".repeat(199));
    expect(detail.includes(fox)).toBe(false);
    expect(() => JSON.stringify({ detail })).not.toThrow();
  });

  test("failure metadata.command at 199+fox boundary backs off without lone surrogate", async () => {
    const manager = await createReadyManager("throw");
    const fox = "🦊";
    const command = `${"a".repeat(199)}${fox}${"b".repeat(50)}`;
    await manager.exec({ command });
    const errorEvent = manager.getEventLog().find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (!errorEvent) throw new Error("missing error event");
    const metadata = errorEvent.metadata as Record<string, string> | undefined;
    expect(metadata).toBeDefined();
    if (!metadata) throw new Error("missing metadata");
    const cmd = metadata.command;
    // Reverting failure-path truncateWellFormed would leave lone surrogate in metadata.command
    expect(isWellFormed(cmd)).toBe(true);
    expect(cmd.length).toBe(199);
    expect(cmd).toBe("a".repeat(199));
    expect(cmd.includes(fox)).toBe(false);
    expect(() => JSON.stringify({ command: cmd })).not.toThrow();
  });

  test("success detail preserves fitting emoji ending exactly at 200", async () => {
    const manager = await createReadyManager("success");
    const fox = "🦊";
    const command = `${"a".repeat(198)}${fox}`;
    await manager.exec({ command });
    const execEvent = manager.getEventLog().find((e) => e.type === "exec");
    expect(execEvent).toBeDefined();
    if (!execEvent) throw new Error("missing exec event");
    const detail = execEvent.detail;
    expect(isWellFormed(detail)).toBe(true);
    expect(detail).toBe(command);
    expect(detail.length).toBe(200);
    expect(detail.includes(fox)).toBe(true);
    expect(() => JSON.stringify({ detail })).not.toThrow();
  });

  test("failure metadata.command preserves fitting emoji at 200", async () => {
    const manager = await createReadyManager("throw");
    const fox = "🦊";
    const command = `${"a".repeat(198)}${fox}`;
    await manager.exec({ command });
    const errorEvent = manager.getEventLog().find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (!errorEvent) throw new Error("missing error event");
    const metadata = errorEvent.metadata as Record<string, string> | undefined;
    expect(metadata).toBeDefined();
    if (!metadata) throw new Error("missing metadata");
    const cmd = metadata.command;
    expect(isWellFormed(cmd)).toBe(true);
    expect(cmd).toBe(command);
    expect(cmd.length).toBe(200);
    expect(cmd.includes(fox)).toBe(true);
  });

  test("success detail sanitizes lone high surrogate", async () => {
    const manager = await createReadyManager("success");
    const badCommand = `echo \ud800 corrupt surrogate ${"x".repeat(300)}`;
    await manager.exec({ command: badCommand });
    const execEvent = manager.getEventLog().find((e) => e.type === "exec");
    expect(execEvent).toBeDefined();
    if (!execEvent) throw new Error("missing exec event");
    const detail = execEvent.detail;
    expect(isWellFormed(detail)).toBe(true);
    expect(detail.includes("\ud800")).toBe(false);
    expect(detail.includes("�")).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(200);
    expect(() => JSON.stringify({ detail })).not.toThrow();
  });

  test("failure metadata.command sanitizes lone high surrogate", async () => {
    const manager = await createReadyManager("throw");
    const badCommand = `echo \ud800 corrupt surrogate ${"x".repeat(300)}`;
    await manager.exec({ command: badCommand });
    const errorEvent = manager.getEventLog().find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (!errorEvent) throw new Error("missing error event");
    const metadata = errorEvent.metadata as Record<string, string> | undefined;
    expect(metadata).toBeDefined();
    if (!metadata) throw new Error("missing metadata");
    const cmd = metadata.command;
    expect(isWellFormed(cmd)).toBe(true);
    expect(cmd.includes("\ud800")).toBe(false);
    expect(cmd.includes("�")).toBe(true);
    expect(cmd.length).toBeLessThanOrEqual(200);
    expect(() => JSON.stringify({ command: cmd })).not.toThrow();
  });

  test("sweep offsets around 200 cap stay well-formed for both paths", async () => {
    const fox = "🦊";
    for (let offset = -5; offset <= 5; offset++) {
      const n = 200 + offset;
      const command = `${"a".repeat(Math.max(0, n - 2))}${fox}${"b".repeat(20)}`;
      const successManager = await createReadyManager("success");
      await successManager.exec({ command });
      const successEvent = successManager
        .getEventLog()
        .find((e) => e.type === "exec");
      expect(successEvent).toBeDefined();
      if (!successEvent) throw new Error("missing exec event");
      const successDetail = successEvent.detail;
      expect(isWellFormed(successDetail)).toBe(true);
      expect(successDetail.length).toBeLessThanOrEqual(200);
      expect(() => JSON.stringify({ detail: successDetail })).not.toThrow();

      const failManager = await createReadyManager("throw");
      await failManager.exec({ command });
      const failEvent = failManager
        .getEventLog()
        .find((e) => e.type === "error");
      expect(failEvent).toBeDefined();
      if (!failEvent) throw new Error("missing error event");
      const failMetadata = failEvent.metadata as
        | Record<string, string>
        | undefined;
      expect(failMetadata).toBeDefined();
      if (!failMetadata) throw new Error("missing metadata");
      const failCmd = failMetadata.command;
      expect(isWellFormed(failCmd)).toBe(true);
      expect(failCmd.length).toBeLessThanOrEqual(200);
      expect(() => JSON.stringify({ command: failCmd })).not.toThrow();
    }
  });
});
