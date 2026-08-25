/** Main-process shell-controller authority tests exercise exclusive ownership,
 * crash handoff, strict validation, terminal command idempotency, and targeted
 * voice delivery with real authority instances and fake renderer boundaries. */
import { describe, expect, it, vi } from "vitest";
import {
  SHELL_AUTHORITY_COMMAND_MESSAGE,
  SHELL_AUTHORITY_DELIVERY_MESSAGE,
  SHELL_SYNC_PROTOCOL_VERSION,
  ShellControllerAuthority,
} from "./shell-sync-relay";

function snapshot(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: "idle",
    responding: false,
    turnStatus: null,
    messages: [],
    canSend: true,
    modelStatus: { kind: "ready", blocksSend: false },
    recording: false,
    waveformMode: "idle",
    isOpen: true,
    visionCapturing: false,
    transcript: "",
    speaking: false,
    agentVoiceMuted: false,
    needsAudioUnlock: false,
    handsFree: false,
    micPermission: "granted",
    transcriptionMode: false,
    conversationNav: {
      hasPrev: false,
      hasNext: false,
      activeId: null,
      index: 0,
    },
    ...over,
  };
}

describe("ShellControllerAuthority ownership", () => {
  it("keeps one non-preemptive owner and promotes a follower on release", () => {
    const authority = new ShellControllerAuthority();
    const tray = authority.register("tray-popover", vi.fn());
    const main = authority.register("main", vi.fn());
    const trayState = tray.connect({
      protocolVersion: SHELL_SYNC_PROTOCOL_VERSION,
    });
    const mainState = main.connect({
      protocolVersion: SHELL_SYNC_PROTOCOL_VERSION,
    });
    expect(trayState.role).toBe("owner");
    expect(mainState.ownerEndpointId).toBe(trayState.endpointId);
    expect(mainState.role).toBe("follower");

    tray.release();
    const promoted = main.heartbeat({
      protocolVersion: SHELL_SYNC_PROTOCOL_VERSION,
    });
    expect(promoted.role).toBe("owner");
    expect(promoted.generation).toBeGreaterThan(mainState.generation);
    main.release();
  });

  it("does not promote on a heartbeat gap until native close fences the owner", () => {
    let now = 0;
    const authority = new ShellControllerAuthority(() => now);
    const owner = authority.register("main", vi.fn());
    const follower = authority.register("surface", vi.fn());
    owner.connect({ protocolVersion: SHELL_SYNC_PROTOCOL_VERSION });
    follower.connect({ protocolVersion: SHELL_SYNC_PROTOCOL_VERSION });
    now = 10_001;
    const promoted = follower.heartbeat({
      protocolVersion: SHELL_SYNC_PROTOCOL_VERSION,
    });
    expect(promoted.role).toBe("follower");
    owner.release();
    expect(
      follower.heartbeat({ protocolVersion: SHELL_SYNC_PROTOCOL_VERSION }).role,
    ).toBe("owner");
    follower.release();
  });

  it("never elects an incompatible renderer", () => {
    const authority = new ShellControllerAuthority();
    const endpoint = authority.register("main", vi.fn());
    const state = endpoint.connect({ protocolVersion: "old" });
    expect(state.status).toBe("version-mismatch");
    expect(state.ownerEndpointId).toBeNull();
    endpoint.release();
  });

  it("allows a reusable tray RPC endpoint to reconnect after native close", () => {
    const authority = new ShellControllerAuthority();
    const endpoint = authority.register("tray-popover", vi.fn());
    const first = endpoint.connect({
      protocolVersion: SHELL_SYNC_PROTOCOL_VERSION,
    });
    endpoint.release();
    const reopened = endpoint.connect({
      protocolVersion: SHELL_SYNC_PROTOCOL_VERSION,
    });
    expect(reopened.endpointId).toBe(first.endpointId);
    expect(reopened.role).toBe("owner");
    expect(reopened.generation).toBeGreaterThan(first.generation);
    endpoint.release();
  });
});

describe("ShellControllerAuthority data paths", () => {
  it("accepts snapshots only from the current owner and broadcasts validated state", () => {
    const authority = new ShellControllerAuthority();
    const ownerSend = vi.fn();
    const followerSend = vi.fn();
    const owner = authority.register("main", ownerSend);
    const follower = authority.register("surface", followerSend);
    const ownerState = owner.connect({
      protocolVersion: SHELL_SYNC_PROTOCOL_VERSION,
    });
    const followerState = follower.connect({
      protocolVersion: SHELL_SYNC_PROTOCOL_VERSION,
    });
    expect(
      follower.publishSnapshot({
        generation: ownerState.generation,
        snapshot: snapshot(),
      }),
    ).toEqual({ ok: false });
    expect(
      owner.publishSnapshot({
        generation: ownerState.generation,
        snapshot: { forged: true },
      }),
    ).toEqual({ ok: false });
    expect(
      owner.publishSnapshot({
        generation: ownerState.generation,
        snapshot: snapshot({ transcript: "live" }),
      }),
    ).toEqual({ ok: true });
    expect(followerSend).toHaveBeenCalledWith(
      "shellControllerAuthorityState",
      expect.objectContaining({
        endpointId: followerState.endpointId,
        snapshot: expect.objectContaining({ transcript: "live" }),
      }),
    );
    owner.release();
    follower.release();
  });

  it("resolves a command only after owner completion and reuses its terminal outcome", async () => {
    const authority = new ShellControllerAuthority();
    const ownerSend = vi.fn();
    const owner = authority.register("main", ownerSend);
    const follower = authority.register("surface", vi.fn());
    const ownerState = owner.connect({
      protocolVersion: SHELL_SYNC_PROTOCOL_VERSION,
    });
    follower.connect({ protocolVersion: SHELL_SYNC_PROTOCOL_VERSION });
    ownerSend.mockClear();

    const first = follower.dispatchCommand({
      commandId: "command-1",
      command: { kind: "stop" },
    });
    const duplicate = follower.dispatchCommand({
      commandId: "command-1",
      command: { kind: "stop" },
    });
    expect(ownerSend).toHaveBeenCalledTimes(1);
    expect(ownerSend).toHaveBeenCalledWith(
      SHELL_AUTHORITY_COMMAND_MESSAGE,
      expect.objectContaining({ commandId: "command-1" }),
    );
    expect(
      owner.completeCommand({
        generation: ownerState.generation,
        commandId: "command-1",
        fromEndpointId: "shell-2",
        ok: true,
      }),
    ).toEqual({ ok: true });
    await expect(first).resolves.toEqual({ ok: true });
    await expect(duplicate).resolves.toEqual({ ok: true });
    await expect(
      follower.dispatchCommand({
        commandId: "command-1",
        command: { kind: "stop" },
      }),
    ).resolves.toEqual({ ok: true });
    expect(ownerSend).toHaveBeenCalledTimes(1);
    owner.release();
    follower.release();
  });

  it("rejects forged commands and scopes voice delivery to the requested follower", async () => {
    const authority = new ShellControllerAuthority();
    const owner = authority.register("main", vi.fn());
    const targetSend = vi.fn();
    const otherSend = vi.fn();
    const target = authority.register("surface", targetSend);
    const other = authority.register("tray-popover", otherSend);
    const ownerState = owner.connect({
      protocolVersion: SHELL_SYNC_PROTOCOL_VERSION,
    });
    const targetState = target.connect({
      protocolVersion: SHELL_SYNC_PROTOCOL_VERSION,
    });
    other.connect({ protocolVersion: SHELL_SYNC_PROTOCOL_VERSION });
    await expect(
      target.dispatchCommand({ commandId: "bad", command: { kind: "root" } }),
    ).resolves.toEqual({ ok: false, error: "invalid-command" });
    await expect(
      target.dispatchCommand({
        commandId: "bad-intent",
        command: {
          kind: "routeOsIntent",
          intent: {
            type: "start-voice",
            intentId: "launch-1",
            source: "forged",
            mode: "converse",
          },
          deliveryPolicy: "execute",
        },
      }),
    ).resolves.toEqual({ ok: false, error: "invalid-command" });
    await expect(
      target.dispatchCommand({
        commandId: "bad-intent-attachment",
        command: {
          kind: "routeOsIntent",
          intent: {
            type: "send",
            intentId: "launch-2",
            source: "desktop-deep-link",
            text: "review this",
            images: [{ data: 42, mimeType: "image/png", name: "bad.png" }],
          },
          deliveryPolicy: "review-send",
        },
      }),
    ).resolves.toEqual({ ok: false, error: "invalid-command" });
    expect(
      owner.deliver({
        generation: ownerState.generation,
        targetEndpointId: targetState.endpointId,
        delivery: { kind: "dictation", text: "private draft" },
      }),
    ).toEqual({ ok: true });
    expect(targetSend).toHaveBeenCalledWith(SHELL_AUTHORITY_DELIVERY_MESSAGE, {
      generation: ownerState.generation,
      delivery: { kind: "dictation", text: "private draft" },
    });
    expect(
      owner.deliver({
        generation: ownerState.generation,
        targetEndpointId: targetState.endpointId,
        delivery: { kind: "composer-prefill", text: "review me" },
      }),
    ).toEqual({ ok: true });
    expect(otherSend).not.toHaveBeenCalledWith(
      SHELL_AUTHORITY_DELIVERY_MESSAGE,
      expect.anything(),
    );
    owner.release();
    target.release();
    other.release();
  });

  it("truncates error messages with surrogate safety", async () => {
    const authority = new ShellControllerAuthority();
    const owner = authority.register("main", vi.fn());
    const follower = authority.register("tray", vi.fn());
    const ownerState = owner.connect({
      protocolVersion: SHELL_SYNC_PROTOCOL_VERSION,
    });
    const followerState = follower.connect({
      protocolVersion: SHELL_SYNC_PROTOCOL_VERSION,
    });

    const longError = `${"a".repeat(1999)}😀${"b".repeat(10)}`;
    const outcomePromise = follower.dispatchCommand({
      commandId: "cmd-err-1",
      command: {
        kind: "routeOsIntent",
        intent: {
          type: "start-voice",
          intentId: "launch-1",
          source: "desktop-deep-link",
          mode: "converse",
        },
        deliveryPolicy: "execute",
      },
    });

    owner.completeCommand({
      generation: ownerState.generation,
      commandId: "cmd-err-1",
      fromEndpointId: followerState.endpointId,
      ok: false,
      error: longError,
    });

    const res = await outcomePromise;
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe("string");
    expect(res.error?.length).toBeLessThanOrEqual(2000);
    expect(res.error?.endsWith("😀")).toBe(false);
    expect(res.error?.endsWith("a")).toBe(true);
  });
});
