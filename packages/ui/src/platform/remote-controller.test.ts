/**
 * Covers the renderer remote-control adapter's desktop-bridge contract
 * against a recording fake installed at window.__ELIZA_ELECTROBUN_RPC__
 * (jsdom, deterministic, no native host): per-operation RPC routing,
 * controller/target field flattening, platform-derived display-name
 * defaults, fail-closed errors when the bridge cannot answer, and result
 * unwrapping including the clear-session false fallback.
 */
// @vitest-environment jsdom

import type {
  EncryptedRemoteControlEnvelope,
  RemoteControllerPublicIdentity,
  RemoteTargetPublicIdentity,
  SignedRemoteCommand,
} from "@elizaos/shared/contracts/remote-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ElectrobunRendererRpc } from "../bridge/electrobun-rpc";
import {
  acknowledgeRemoteCommandEnqueue,
  clearRemoteControllerSessionState,
  createRemoteCommand,
  getOrCreateRemoteControllerIdentity,
  openRemoteCommandResult,
  openRemoteCommandStartReceipt,
} from "./remote-controller";

interface BridgeCall {
  method: string;
  params?: unknown;
}

interface BridgeHarness {
  request: Record<string, (params?: unknown) => Promise<unknown>>;
  calls: BridgeCall[];
  onMessage: ReturnType<typeof vi.fn>;
  offMessage: ReturnType<typeof vi.fn>;
  rpc: ElectrobunRendererRpc;
  /** Register a handler that records its invocation and responds. */
  handle(method: string, respond?: (params?: unknown) => unknown): void;
}

function createBridgeHarness(): BridgeHarness {
  const calls: BridgeCall[] = [];
  const request: Record<string, (params?: unknown) => Promise<unknown>> = {};
  const onMessage = vi.fn();
  const offMessage = vi.fn();
  const rpc: ElectrobunRendererRpc = { request, onMessage, offMessage };
  return {
    request,
    calls,
    onMessage,
    offMessage,
    rpc,
    handle(method, respond) {
      request[method] = async (params?: unknown) => {
        calls.push({ method, params });
        return respond ? respond(params) : undefined;
      };
    },
  };
}

function installOnWindow(rpc: ElectrobunRendererRpc): void {
  (
    window as { __ELIZA_ELECTROBUN_RPC__?: ElectrobunRendererRpc }
  ).__ELIZA_ELECTROBUN_RPC__ = rpc;
}

function uninstallFromWindow(): void {
  delete (window as { __ELIZA_ELECTROBUN_RPC__?: ElectrobunRendererRpc })
    .__ELIZA_ELECTROBUN_RPC__;
}

function controllerIdentity(): RemoteControllerPublicIdentity {
  return {
    version: 1,
    role: "controller",
    ownerId: "owner-1",
    deviceId: "controller-device-1",
    keyId: "controller-key-1",
    displayName: "My Mac",
    platform: "macos",
    signingPublicKeyJwk: { kty: "EC", crv: "P-256" },
    encryptionPublicKeyJwk: { kty: "EC", crv: "P-256" },
    createdAt: 1_700_000_000_000,
  };
}

function targetIdentity(): RemoteTargetPublicIdentity {
  return {
    version: 1,
    role: "target",
    ownerId: "owner-1",
    runtimeId: "runtime-1",
    keyId: "target-key-1",
    displayName: "Studio Mac",
    platform: "macos",
    signingPublicKeyJwk: { kty: "EC", crv: "P-256" },
    encryptionPublicKeyJwk: { kty: "EC", crv: "P-256" },
    createdAt: 1_700_000_000_000,
  };
}

function signedCommand(): SignedRemoteCommand {
  return {
    body: {
      version: 1,
      ownerId: "owner-1",
      grantId: "grant-1",
      grantRevision: 3,
      sessionId: "session-1",
      controllerDeviceId: "controller-device-1",
      controllerKeyId: "controller-key-1",
      targetRuntimeId: "runtime-1",
      targetKeyId: "target-key-1",
      commandId: "command-1",
      sequence: 7,
      nonce: "nonce-7",
      issuedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_005_000,
      action: "agent.status",
      payload: {},
      payloadDigest: "dGVzdC1kaWdlc3QtdGVzdC1kaWdlc3QtdGVzdC1kaWdlc3Q",
    },
    signatureAlgorithm: "ECDSA-P256-SHA256",
    signature: "c2lnbmF0dXJlLXZhbHVl",
  };
}

function encryptedEnvelope(): EncryptedRemoteControlEnvelope {
  return {
    messageKind: "result",
    version: 1,
    ownerId: "owner-1",
    grantId: "grant-1",
    grantRevision: 3,
    sessionId: "session-1",
    controllerDeviceId: "controller-device-1",
    controllerKeyId: "controller-key-1",
    targetRuntimeId: "runtime-1",
    targetKeyId: "target-key-1",
    commandId: "command-1",
    algorithm: "ECDH-P256-HKDF-SHA256+A256GCM",
    senderKeyId: "target-key-1",
    recipientKeyId: "controller-key-1",
    messageDigest: "bWVzc2FnZS1kaWdlc3QtbWVzc2FnZS1kaWdlc3QtbWVzc2FnZQ",
    ephemeralPublicKeyJwk: { kty: "EC", crv: "P-256" },
    salt: "c2FsdC1zYWx0LXNhbHQtc2FsdC1zYWx0LXNhbHQ",
    iv: "aXZpdmVjdG9yMTIzNDU2",
    ciphertext: "Y2lwaGVydGV4dC12YWx1ZS1mb3ItdGVzdA",
  };
}

afterEach(() => {
  uninstallFromWindow();
  vi.unstubAllGlobals();
});

describe("getOrCreateRemoteControllerIdentity", () => {
  it("routes the identity request over the desktop bridge and returns the stored identity", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    const identity = controllerIdentity();
    harness.handle("remoteControllerGetOrCreateIdentity", () => identity);
    vi.stubGlobal("navigator", { platform: "MacIntel" });

    const result = await getOrCreateRemoteControllerIdentity({
      ownerId: "owner-1",
    });

    expect(result).toEqual(identity);
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.method).toBe(
      "remoteControllerGetOrCreateIdentity",
    );
    expect(harness.calls[0]?.params).toEqual({
      ownerId: "owner-1",
      displayName: "My Mac",
      platform: "macos",
    });
  });

  it("defaults the display name for Windows when no explicit name is given", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("remoteControllerGetOrCreateIdentity", () =>
      controllerIdentity(),
    );
    vi.stubGlobal("navigator", { platform: "Win32" });

    await getOrCreateRemoteControllerIdentity({ ownerId: "owner-1" });

    expect(harness.calls[0]?.params).toMatchObject({
      displayName: "My Windows PC",
      platform: "windows",
    });
  });

  it("defaults the display name for Linux when no explicit name is given", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("remoteControllerGetOrCreateIdentity", () =>
      controllerIdentity(),
    );
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });

    await getOrCreateRemoteControllerIdentity({ ownerId: "owner-1" });

    expect(harness.calls[0]?.params).toMatchObject({
      displayName: "My Linux computer",
      platform: "linux",
    });
  });

  it("prefers an explicit displayName over the platform default", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("remoteControllerGetOrCreateIdentity", () =>
      controllerIdentity(),
    );
    vi.stubGlobal("navigator", { platform: "Win32" });

    await getOrCreateRemoteControllerIdentity({
      ownerId: "owner-1",
      displayName: "Studio PC",
    });

    expect(harness.calls[0]?.params).toMatchObject({
      displayName: "Studio PC",
      platform: "windows",
    });
  });

  it("fails closed when the desktop bridge has no identity to return", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("remoteControllerGetOrCreateIdentity", () => null);

    await expect(
      getOrCreateRemoteControllerIdentity({ ownerId: "owner-1" }),
    ).rejects.toThrow(
      "Secure device pairing requires the Eliza desktop app so private keys stay in OS credential storage.",
    );
  });
});

describe("createRemoteCommand", () => {
  it("flattens controller and target identities into the signing request and returns the signed result", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    const command = signedCommand();
    const envelope = encryptedEnvelope();
    harness.handle("remoteControllerCreateCommand", () => ({
      commandId: "command-1",
      expiresAt: 1_700_000_005_000,
      command,
      envelope,
      recoveredPending: false,
      bindingDigest: "YmluZGluZy1kaWdlc3QtYmluZGluZy1kaWdlc3Q",
    }));
    const controller = controllerIdentity();
    const target = targetIdentity();

    const result = await createRemoteCommand({
      ownerId: "owner-1",
      grantId: "grant-1",
      grantRevision: 3,
      sessionId: "session-1",
      controller,
      target,
      action: "agent.request",
      payload: { prompt: "restart the agent" },
    });

    expect(result.command).toEqual(command);
    expect(result.envelope).toEqual(envelope);
    expect(result.recoveredPending).toBe(false);
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.method).toBe("remoteControllerCreateCommand");
    expect(harness.calls[0]?.params).toEqual({
      ownerId: "owner-1",
      grantId: "grant-1",
      grantRevision: 3,
      sessionId: "session-1",
      controllerDeviceId: "controller-device-1",
      controllerKeyId: "controller-key-1",
      targetRuntimeId: "runtime-1",
      targetKeyId: "target-key-1",
      targetEncryptionPublicKeyJwk: { kty: "EC", crv: "P-256" },
      action: "agent.request",
      payload: { prompt: "restart the agent" },
    });
  });

  it("surfaces a recovered pending command when the main process reports one", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("remoteControllerCreateCommand", () => ({
      commandId: "command-1",
      expiresAt: 1_700_000_005_000,
      command: signedCommand(),
      envelope: encryptedEnvelope(),
      recoveredPending: true,
      bindingDigest: "YmluZGluZy1kaWdlc3QtYmluZGluZy1kaWdlc3Q",
    }));

    const result = await createRemoteCommand({
      ownerId: "owner-1",
      grantId: "grant-1",
      grantRevision: 3,
      sessionId: "session-1",
      controller: controllerIdentity(),
      target: targetIdentity(),
      action: "agent.status",
      payload: null,
    });

    expect(result.recoveredPending).toBe(true);
  });

  it("rejects when remote command signing is unavailable", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("remoteControllerCreateCommand", () => null);

    await expect(
      createRemoteCommand({
        ownerId: "owner-1",
        grantId: "grant-1",
        grantRevision: 3,
        sessionId: "session-1",
        controller: controllerIdentity(),
        target: targetIdentity(),
        action: "agent.stop",
        payload: null,
      }),
    ).rejects.toThrow("Secure remote command signing is unavailable.");
  });
});

describe("acknowledgeRemoteCommandEnqueue", () => {
  it("forwards its input verbatim and unwraps the acknowledgement flag", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("remoteControllerAcknowledgeEnqueue", () => ({
      acknowledged: true,
    }));

    const acknowledged = await acknowledgeRemoteCommandEnqueue({
      ownerId: "owner-1",
      controllerDeviceId: "controller-device-1",
      sessionId: "session-1",
      commandId: "command-1",
      bindingDigest: "YmluZGluZy1kaWdlc3QtYmluZGluZy1kaWdlc3Q",
    });

    expect(acknowledged).toBe(true);
    expect(harness.calls[0]?.method).toBe("remoteControllerAcknowledgeEnqueue");
    expect(harness.calls[0]?.params).toEqual({
      ownerId: "owner-1",
      controllerDeviceId: "controller-device-1",
      sessionId: "session-1",
      commandId: "command-1",
      bindingDigest: "YmluZGluZy1kaWdlc3QtYmluZGluZy1kaWdlc3Q",
    });
  });

  it("resolves false when the main process reports the enqueue was not acknowledged", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("remoteControllerAcknowledgeEnqueue", () => ({
      acknowledged: false,
    }));

    await expect(
      acknowledgeRemoteCommandEnqueue({
        ownerId: "owner-1",
        controllerDeviceId: "controller-device-1",
        sessionId: "session-1",
        commandId: "command-1",
        bindingDigest: "YmluZGluZy1kaWdlc3QtYmluZGluZy1kaWdlc3Q",
      }),
    ).resolves.toBe(false);
  });

  it("rejects when the acknowledgement channel is unavailable", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("remoteControllerAcknowledgeEnqueue", () => null);

    await expect(
      acknowledgeRemoteCommandEnqueue({
        ownerId: "owner-1",
        controllerDeviceId: "controller-device-1",
        sessionId: "session-1",
        commandId: "command-1",
        bindingDigest: "YmluZGluZy1kaWdlc3QtYmluZGluZy1kaWdlc3Q",
      }),
    ).rejects.toThrow("Secure remote enqueue acknowledgement is unavailable.");
  });
});

describe("openRemoteCommandResult", () => {
  it("sends the sealed envelope for decryption and returns the opened result", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    const envelope = encryptedEnvelope();
    const command = signedCommand();
    const target = targetIdentity();
    harness.handle("remoteControllerOpenResult", () => ({
      status: "completed",
      result: { output: "agent stopped" },
      errorCode: undefined,
    }));

    const result = await openRemoteCommandResult({
      ownerId: "owner-1",
      controllerDeviceId: "controller-device-1",
      envelope,
      command,
      targetIdentity: target,
    });

    expect(result).toEqual({
      status: "completed",
      result: { output: "agent stopped" },
      errorCode: undefined,
    });
    expect(harness.calls[0]?.method).toBe("remoteControllerOpenResult");
    expect(harness.calls[0]?.params).toEqual({
      ownerId: "owner-1",
      controllerDeviceId: "controller-device-1",
      envelope,
      command,
      targetIdentity: target,
    });
  });

  it("rejects when result decryption is unavailable", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("remoteControllerOpenResult", () => null);

    await expect(
      openRemoteCommandResult({
        ownerId: "owner-1",
        controllerDeviceId: "controller-device-1",
        envelope: encryptedEnvelope(),
        command: signedCommand(),
        targetIdentity: targetIdentity(),
      }),
    ).rejects.toThrow("Secure remote result decryption is unavailable.");
  });
});

describe("openRemoteCommandStartReceipt", () => {
  it("returns the verified start receipt fields", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("remoteControllerOpenStartReceipt", () => ({
      startedAt: 1_700_000_001_000,
      executionId: "execution-1",
    }));

    const receipt = await openRemoteCommandStartReceipt({
      ownerId: "owner-1",
      controllerDeviceId: "controller-device-1",
      envelope: encryptedEnvelope(),
      command: signedCommand(),
      targetIdentity: targetIdentity(),
    });

    expect(receipt).toEqual({
      startedAt: 1_700_000_001_000,
      executionId: "execution-1",
    });
    expect(harness.calls[0]?.method).toBe("remoteControllerOpenStartReceipt");
  });

  it("rejects when start-receipt verification is unavailable", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("remoteControllerOpenStartReceipt", () => null);

    await expect(
      openRemoteCommandStartReceipt({
        ownerId: "owner-1",
        controllerDeviceId: "controller-device-1",
        envelope: encryptedEnvelope(),
        command: signedCommand(),
        targetIdentity: targetIdentity(),
      }),
    ).rejects.toThrow(
      "Secure remote start receipt verification is unavailable.",
    );
  });
});

describe("clearRemoteControllerSessionState", () => {
  it("resolves true when the main process cleared the session state", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("remoteControllerClearSessionState", () => ({
      cleared: true,
    }));

    const cleared = await clearRemoteControllerSessionState({
      ownerId: "owner-1",
      controllerDeviceId: "controller-device-1",
      sessionId: "session-1",
    });

    expect(cleared).toBe(true);
    expect(harness.calls[0]?.method).toBe("remoteControllerClearSessionState");
    expect(harness.calls[0]?.params).toEqual({
      ownerId: "owner-1",
      controllerDeviceId: "controller-device-1",
      sessionId: "session-1",
    });
  });

  it("resolves false without throwing when the main process did not clear", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("remoteControllerClearSessionState", () => ({
      cleared: false,
    }));

    await expect(
      clearRemoteControllerSessionState({
        ownerId: "owner-1",
        controllerDeviceId: "controller-device-1",
        sessionId: "session-1",
      }),
    ).resolves.toBe(false);
  });

  it("resolves false when the desktop bridge is absent entirely", async () => {
    await expect(
      clearRemoteControllerSessionState({
        ownerId: "owner-1",
        controllerDeviceId: "controller-device-1",
        sessionId: "session-1",
      }),
    ).resolves.toBe(false);
  });
});
