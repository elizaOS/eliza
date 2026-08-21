/** Exercises the internal relay URL without exposing native private keys. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createEncryptedRemoteCommand: vi.fn(),
  getOrCreateControllerPublicIdentity: vi.fn(),
  openRemoteCommandResult: vi.fn(),
  loadAgentProfileRegistry: vi.fn(),
}));

vi.mock("../platform/remote-control-crypto", () => ({
  createEncryptedRemoteCommand: mocks.createEncryptedRemoteCommand,
}));
vi.mock("../platform/remote-controller-identity", () => ({
  getOrCreateControllerPublicIdentity:
    mocks.getOrCreateControllerPublicIdentity,
  openRemoteCommandResult: mocks.openRemoteCommandResult,
}));
vi.mock("../state/agent-profiles", () => ({
  loadAgentProfileRegistry: mocks.loadAgentProfileRegistry,
}));

import { remoteRelayTransportForUrl } from "./remote-relay-transport";

const SESSION = "23766030-0000-0000-0000-000000000000";
const BASE = `eliza-remote://session/${SESSION}`;
const envelope = {
  version: 1 as const,
  algorithm: "ECDH-P256-HKDF-SHA256+A256GCM" as const,
  senderKeyId: "phone-key",
  recipientKeyId: "host-key",
  ephemeralPublicKeyJwk: {},
  salt: "salt",
  iv: "iv",
  ciphertext: "ciphertext",
};

describe("remoteRelayTransportForUrl", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      clear: () => values.clear(),
    });
    vi.clearAllMocks();
    mocks.loadAgentProfileRegistry.mockReturnValue({
      version: 1,
      activeProfileId: "profile-1",
      profiles: [
        {
          id: "profile-1",
          kind: "remote",
          label: "Linked Mac",
          apiBase: BASE,
          createdAt: new Date().toISOString(),
          remoteRelay: {
            ownerId: "owner-1",
            sessionId: SESSION,
            targetRuntimeId: "host-1",
            targetKeyId: "host-key",
            targetSigningPublicKeyJwk: {},
            targetEncryptionPublicKeyJwk: {},
          },
        },
      ],
    });
    mocks.getOrCreateControllerPublicIdentity.mockResolvedValue({
      deviceId: "phone-1",
      keyId: "phone-key",
    });
    mocks.createEncryptedRemoteCommand.mockResolvedValue({
      command: {
        body: {
          commandId: "command-1",
          expiresAt: Date.now() + 60_000,
        },
      },
      envelope,
    });
    mocks.openRemoteCommandResult.mockResolvedValue({
      status: "completed",
      result: {
        status: 200,
        body: 'event: done\ndata: {"type":"done","fullText":"Hello from the Mac"}\n\n',
        headers: { "content-type": "text/event-stream" },
      },
    });
  });

  it("turns a streaming chat request into one encrypted command and SSE result", async () => {
    const cloud = {
      enqueueCloudRemoteCommand: vi.fn().mockResolvedValue(undefined),
      readCloudRemoteCommandResult: vi.fn().mockResolvedValue({
        status: "completed",
        resultEnvelope: envelope,
      }),
    };
    const transport = remoteRelayTransportForUrl(
      `${BASE}/api/conversations/room-1/messages/stream`,
      cloud,
    );
    expect(transport).not.toBeNull();
    if (!transport) throw new Error("relay transport missing");
    const response = await transport.request(
      `${BASE}/api/conversations/room-1/messages/stream`,
      {
        method: "POST",
        body: JSON.stringify({ text: "hi", channelType: "DM" }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Hello from the Mac");
    expect(mocks.createEncryptedRemoteCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agent.request",
        targetRuntimeId: "host-1",
        payload: expect.objectContaining({
          path: "/api/conversations/room-1/messages/stream",
          method: "POST",
        }),
      }),
    );
    expect(cloud.enqueueCloudRemoteCommand).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: "command-1", sequence: 1 }),
    );
    expect(mocks.openRemoteCommandResult).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCommandId: "command-1",
        expectedTargetRuntimeId: "host-1",
      }),
    );
  });

  it("does not claim unrelated or malformed URL schemes", () => {
    const cloud = {
      enqueueCloudRemoteCommand: vi.fn(),
      readCloudRemoteCommandResult: vi.fn(),
    };
    expect(
      remoteRelayTransportForUrl("https://example.test/api/health", cloud),
    ).toBeNull();
    expect(
      remoteRelayTransportForUrl("eliza-remote://other/value", cloud),
    ).toBeNull();
  });

  it("serializes concurrent sequence allocation when Web Locks are unavailable", async () => {
    const cloud = {
      enqueueCloudRemoteCommand: vi.fn().mockResolvedValue(undefined),
      readCloudRemoteCommandResult: vi.fn().mockResolvedValue({
        status: "completed",
        resultEnvelope: envelope,
      }),
    };
    const transport = remoteRelayTransportForUrl(`${BASE}/api/health`, cloud);
    if (!transport) throw new Error("relay transport missing");

    await Promise.all([
      transport.request(`${BASE}/api/health`, { method: "GET" }),
      transport.request(`${BASE}/api/health`, { method: "GET" }),
    ]);

    expect(
      cloud.enqueueCloudRemoteCommand.mock.calls.map(
        ([input]) => input.sequence,
      ),
    ).toEqual([1, 2]);
  });
});
