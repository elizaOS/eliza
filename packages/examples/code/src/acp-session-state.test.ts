import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { stringToUuid } from "@elizaos/core";
import {
  AcpSessionAdmission,
  AcpTurnRegistry,
  createAcpSessionState,
} from "./acp-session-state.js";
import type { SessionIdentity } from "./lib/identity.js";

function identity(): SessionIdentity {
  return {
    projectId: stringToUuid("acp-session-state-project"),
    userId: stringToUuid("acp-session-state-user"),
    worldId: stringToUuid("acp-session-state-world"),
    messageServerId: stringToUuid("acp-session-state-server"),
  };
}

describe("ACP session state", () => {
  it("derives a distinct runtime room for each session identity", () => {
    const first = createAcpSessionState("first", identity(), "/workspace/a");
    const second = createAcpSessionState("second", identity(), "/workspace/b");

    expect(first.room.elizaRoomId).not.toBe(second.room.elizaRoomId);
    expect(first.cwd).toBe("/workspace/a");
    expect(second.cwd).toBe("/workspace/b");
  });

  it("admits exactly one workspace session for the lifetime of an ACP process", () => {
    const admission = new AcpSessionAdmission();
    admission.reserve("first");

    expect(() => admission.reserve("second")).toThrow(
      "already reserved for session first",
    );
  });

  it("registers a prompt turn before asynchronous workspace setup", () => {
    const source = readFileSync(new URL("./acp.ts", import.meta.url), "utf8");
    const promptStart = source.indexOf("async prompt(params:");
    const turnRegistration = source.indexOf("turns.run(", promptStart);
    const manualRead = source.indexOf(
      "readWorkspaceManual(session.cwd)",
      promptStart,
    );

    expect(promptStart).toBeGreaterThanOrEqual(0);
    expect(turnRegistration).toBeGreaterThan(promptStart);
    expect(manualRead).toBeGreaterThan(turnRegistration);
  });
});

describe("AcpTurnRegistry", () => {
  it("aborts an active turn and reports ACP cancellation", async () => {
    const registry = new AcpTurnRegistry();
    let observedSignal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const turn = registry.run("session-1", async (signal) => {
      observedSignal = signal;
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        void blocked.then(resolve);
      });
      return "late reply";
    });

    expect(registry.hasActiveTurn("session-1")).toBe(true);
    expect(registry.cancel("session-1")).toBe(true);
    expect(observedSignal?.aborted).toBe(true);
    await expect(turn).resolves.toEqual({ cancelled: true });
    expect(registry.hasActiveTurn("session-1")).toBe(false);
    release?.();
  });

  it("rejects overlapping prompts without cancelling another session", async () => {
    const registry = new AcpTurnRegistry();
    let release: (() => void) | undefined;
    const first = registry.run("session-1", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "done";
    });

    await expect(
      registry.run("session-1", async () => "overlap"),
    ).rejects.toThrow("already has an active prompt");
    await expect(
      registry.run("session-2", async () => "independent"),
    ).resolves.toEqual({ cancelled: false, value: "independent" });

    release?.();
    await expect(first).resolves.toEqual({ cancelled: false, value: "done" });
  });

  it("does not report an uncooperative turn quiesced until it actually settles", async () => {
    const registry = new AcpTurnRegistry();
    let release: (() => void) | undefined;
    const turn = registry.run("session-1", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "must not publish";
    });

    let quiesced = false;
    const cancellation = registry
      .cancelAndWait("session-1", 1_000)
      .then((value) => {
        quiesced = true;
        return value;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(quiesced).toBe(false);
    release?.();
    await expect(cancellation).resolves.toBe(true);
    await expect(turn).resolves.toEqual({ cancelled: true });
  });

  it("fails closed when an aborted operation does not quiesce before close timeout", async () => {
    const registry = new AcpTurnRegistry();
    let release: (() => void) | undefined;
    const turn = registry.run("session-1", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "must not publish";
    });

    await expect(registry.cancelAndWait("session-1", 20)).rejects.toThrow(
      "did not quiesce within 20ms",
    );
    expect(registry.hasActiveTurn("session-1")).toBe(true);

    release?.();
    await expect(turn).resolves.toEqual({ cancelled: true });
  });

  it("aborts and drains every active session when the connection closes", async () => {
    const registry = new AcpTurnRegistry();
    const first = registry.run("session-1", async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      return "first late reply";
    });
    const second = registry.run("session-2", async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      return "second late reply";
    });

    await expect(registry.cancelAllAndWait(100)).resolves.toBe(2);
    await expect(first).resolves.toEqual({ cancelled: true });
    await expect(second).resolves.toEqual({ cancelled: true });
    expect(registry.hasActiveTurn("session-1")).toBe(false);
    expect(registry.hasActiveTurn("session-2")).toBe(false);
  });
});
