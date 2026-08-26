/** Pins per-session enqueue ordering independently from terminal result polling. */
import type {
  EncryptedRemoteControlEnvelope,
  SignedRemoteCommand,
} from "@elizaos/shared/contracts/remote-control";
import { describe, expect, it } from "vitest";

import type { AgentProfile } from "../state/agent-profile-types";
import { remoteRelayTransportInternals } from "./remote-relay-transport";

describe("remote relay enqueue ordering", () => {
  it("does not let sequence two reach Cloud before a slow sequence one", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = remoteRelayTransportInternals.withSessionEnqueue(
      "session-1",
      async () => {
        events.push("first-created");
        await firstGate;
        events.push("first-enqueued");
      },
    );
    const second = remoteRelayTransportInternals.withSessionEnqueue(
      "session-1",
      async () => {
        events.push("second-created");
        events.push("second-enqueued");
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["first-created"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first-created",
      "first-enqueued",
      "second-created",
      "second-enqueued",
    ]);
  });

  it("continues durable observation after caller abort without creating a second command", async () => {
    const abort = new AbortController();
    let creates = 0;
    let enqueues = 0;
    let acknowledgements = 0;
    const command = { body: {} } as SignedRemoteCommand;
    const envelope = {} as EncryptedRemoteControlEnvelope;
    const profile = {
      id: "profile-1",
      label: "Remote Linux",
      kind: "remote",
      apiBase: "eliza-remote://session/session-1",
      connectionMode: "relay",
      createdAt: "2026-08-22T00:00:00.000Z",
      remoteRelay: {
        ownerId: "owner-1",
        controllerDeviceId: "controller-1",
        controllerKeyId: "controller-key-1",
        grantId: "grant-1",
        grantRevision: 1,
        sessionId: "session-1",
        targetRuntimeId: "target-1",
        targetKeyId: "target-key-1",
        targetDisplayName: "Remote Linux",
        targetCreatedAt: 1,
        targetPlatform: "linux",
        targetSigningPublicKeyJwk: {},
        targetEncryptionPublicKeyJwk: {},
        expiresAt: null,
      },
    } satisfies AgentProfile;
    const cloud = {
      enqueueCommand: async () => {
        enqueues += 1;
        abort.abort();
      },
      readCommand: async () => ({
        status: "completed" as const,
        startReceipt: null,
        resultEnvelope: envelope,
      }),
    };

    await expect(
      remoteRelayTransportInternals.sendCommand(
        cloud,
        profile,
        "agent.request",
        { path: "/api/conversations", method: "POST" },
        abort.signal,
        {
          getController: async () => ({
            version: 1,
            role: "controller",
            ownerId: "owner-1",
            deviceId: "controller-1",
            keyId: "controller-key-1",
            displayName: "This device",
            platform: "linux",
            signingPublicKeyJwk: {},
            encryptionPublicKeyJwk: {},
            createdAt: 1,
          }),
          createCommand: async () => {
            creates += 1;
            return {
              commandId: "command-1",
              expiresAt: 2_000,
              command,
              envelope,
              recoveredPending: false,
              bindingDigest: "binding-digest-1",
            };
          },
          acknowledgeEnqueue: async () => {
            acknowledgements += 1;
            return true;
          },
          openStartReceipt: async () => ({
            startedAt: 1,
            executionId: "execution-1",
          }),
          openResult: async () => ({
            status: "completed",
            result: { status: 201, body: "{}", headers: {} },
          }),
          now: () => 1_000,
          wait: async () => undefined,
        },
      ),
    ).resolves.toEqual({ status: 201, body: "{}", headers: {} });
    expect(abort.signal.aborted).toBe(true);
    expect({ creates, enqueues, acknowledgements }).toEqual({
      creates: 1,
      enqueues: 1,
      acknowledgements: 1,
    });
  });

  it("maps the target executor's exact health result to the real HTTP response", async () => {
    const response = remoteRelayTransportInternals.responseFromRemoteResult({
      status: 200,
      body: '{"status":"ok"}',
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.text()).resolves.toBe('{"status":"ok"}');
  });

  it("normalizes health/status GETs through the shared strict contract", () => {
    expect(
      remoteRelayTransportInternals.normalizeRelayHealthRequest(
        "eliza-remote://session/session-1/api/health",
        { method: "GET", headers: { accept: "application/json" } },
      ),
    ).toEqual({
      path: "/api/health",
      method: "GET",
      headers: { accept: "application/json" },
    });
  });

  it("normalizes the selected runtime's conversation and chat routes", () => {
    const conversationId = "11111111-1111-4111-8111-111111111111";
    expect(
      remoteRelayTransportInternals.normalizeRelayAgentRequest(
        "eliza-remote://session/session-1/api/conversations",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Remote chat" }),
        },
      ),
    ).toEqual({
      path: "/api/conversations",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"title":"Remote chat"}',
    });
    expect(
      remoteRelayTransportInternals.normalizeRelayAgentRequest(
        `eliza-remote://session/session-1/api/conversations/${conversationId}/messages/stream`,
        {
          method: "POST",
          headers: {
            accept: "text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            text: "hello",
            channelType: "DM",
            clientMessageId: "message-1",
            streamProtocol: "delta-v2",
          }),
        },
      ).path,
    ).toBe(`/api/conversations/${conversationId}/messages/stream`);
  });

  it("rejects arbitrary proxy routes, caller authorization, and binary bodies", () => {
    expect(() =>
      remoteRelayTransportInternals.normalizeRelayAgentRequest(
        "eliza-remote://session/session-1/api/chat",
        { method: "POST", body: "{}" },
      ),
    ).toThrow("not allowlisted");
    expect(() =>
      remoteRelayTransportInternals.normalizeRelayAgentRequest(
        "eliza-remote://session/session-1/api/status",
        { headers: { authorization: "Bearer stale-renderer-token" } },
      ),
    ).toThrow("unsupported value");
    expect(() =>
      remoteRelayTransportInternals.normalizeRelayAgentRequest(
        "eliza-remote://session/session-1/api/conversations",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: new Blob(["{}"]),
        },
      ),
    ).toThrow("text request bodies only");
    expect(() =>
      remoteRelayTransportInternals.normalizeRelayAgentRequest(
        "eliza-remote://attacker@session/session-1/api/status",
        {},
      ),
    ).toThrow("target is invalid");
    expect(() =>
      remoteRelayTransportInternals.normalizeRelayAgentRequest(
        "eliza-remote://session/session-1/api/status#ignored",
        {},
      ),
    ).toThrow("target is invalid");
  });
});
