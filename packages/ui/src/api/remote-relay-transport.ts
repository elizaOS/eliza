/**
 * Sends controller requests through the opaque Cloud relay with native E2EE
 * signing/decryption. A command is enqueued exactly once; after a signed start
 * receipt the client only polls status and never replays the effect.
 */
import type {
  RemoteCommandAction,
  RemoteJsonValue,
  RemoteTargetPublicIdentity,
  SignedRemoteCommand,
} from "@elizaos/shared/contracts/remote-control";
import {
  createRemoteCommand,
  getOrCreateRemoteControllerIdentity,
  openRemoteCommandResult,
  openRemoteCommandStartReceipt,
} from "../platform/remote-controller";
import type { AgentProfile } from "../state/agent-profile-types";
import { loadAgentProfileRegistry } from "../state/agent-profiles";
import type { RemoteControlCloudClient } from "./remote-control-cloud-client";

async function defaultCloudClient(): Promise<RemoteControlCloudClient> {
  const module = await import("./remote-control-cloud-default");
  return module.createDefaultRemoteControlCloudClient();
}

import type { AgentRequestTransport } from "./transport";
import { bodyToString, headersToRecord } from "./transport";

const enqueueTails = new Map<string, Promise<void>>();

function relayProfileForUrl(url: string): AgentProfile | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "eliza-remote:" || parsed.hostname !== "session") {
    return null;
  }
  const sessionId = parsed.pathname.split("/").filter(Boolean)[0];
  if (!sessionId) return null;
  return (
    loadAgentProfileRegistry().profiles.find(
      (profile) =>
        profile.connectionMode === "relay" &&
        profile.remoteRelay?.sessionId === sessionId,
    ) ?? null
  );
}

async function withSessionEnqueue<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = enqueueTails.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = predecessor.catch(() => undefined).then(() => current);
  enqueueTails.set(sessionId, queued);
  await predecessor.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (enqueueTails.get(sessionId) === queued) {
      enqueueTails.delete(sessionId);
    }
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

async function sendCommand(
  cloud: RemoteControlCloudClient,
  profile: AgentProfile,
  action: RemoteCommandAction,
  payload: RemoteJsonValue,
  signal?: AbortSignal,
): Promise<RemoteJsonValue | undefined> {
  const relay = profile.remoteRelay;
  if (!relay) throw new Error("Remote relay authority is missing.");
  const controller = await getOrCreateRemoteControllerIdentity({
    ownerId: relay.ownerId,
  });
  const target: RemoteTargetPublicIdentity = {
    version: 1,
    role: "target",
    ownerId: relay.ownerId,
    runtimeId: relay.targetRuntimeId,
    keyId: relay.targetKeyId,
    displayName: relay.targetDisplayName,
    platform: relay.targetPlatform,
    signingPublicKeyJwk: relay.targetSigningPublicKeyJwk,
    encryptionPublicKeyJwk: relay.targetEncryptionPublicKeyJwk,
    createdAt: 0,
  };
  const created = await withSessionEnqueue(relay.sessionId, async () => {
    const next = await createRemoteCommand({
      ownerId: relay.ownerId,
      grantId: relay.grantId,
      grantRevision: relay.grantRevision,
      sessionId: relay.sessionId,
      controller,
      target,
      action,
      payload,
    });
    await cloud.enqueueCommand({
      sessionId: relay.sessionId,
      envelope: next.envelope,
    });
    return next;
  });

  const resultDeadline = created.expiresAt + 10 * 60_000;
  let crossedStartBoundary = false;
  let verifiedStartReceipt = false;
  const command: SignedRemoteCommand = created.command;
  while (Date.now() <= resultDeadline) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const current = await cloud.readCommand({
      sessionId: relay.sessionId,
      commandId: created.commandId,
    });
    if (current.startReceipt && !verifiedStartReceipt) {
      await openRemoteCommandStartReceipt({
        ownerId: relay.ownerId,
        controllerDeviceId: controller.deviceId,
        envelope: current.startReceipt,
        command,
        targetIdentity: target,
      });
      verifiedStartReceipt = true;
      crossedStartBoundary = true;
    }
    if (current.status === "started" && !verifiedStartReceipt) {
      throw new Error(
        "The remote runtime reported a start without a verifiable receipt. The command was not retried.",
      );
    }
    if (current.status === "execution_ambiguous") {
      throw new Error(
        "The remote runtime started this command, but its final result is unknown. It was not retried.",
      );
    }
    if (current.status === "expired" || current.status === "cancelled") {
      throw new Error("The remote command expired before it could start.");
    }
    if (current.status === "failed" && !current.resultEnvelope) {
      throw new Error("The remote runtime reported a command failure.");
    }
    if (
      (current.status === "completed" || current.status === "failed") &&
      current.resultEnvelope
    ) {
      const result = await openRemoteCommandResult({
        ownerId: relay.ownerId,
        controllerDeviceId: controller.deviceId,
        envelope: current.resultEnvelope,
        command,
        targetIdentity: target,
      });
      if (result.status !== "completed") {
        throw new Error(
          result.errorCode
            ? `Remote command failed (${result.errorCode}).`
            : "Remote command failed.",
        );
      }
      return result.result;
    }
    if (!crossedStartBoundary && Date.now() > created.expiresAt + 30_000) {
      throw new Error("The remote host did not accept the command in time.");
    }
    await wait(300, signal);
  }
  throw new Error(
    crossedStartBoundary
      ? "The remote command may still be running. It was not retried."
      : "The remote command timed out before starting.",
  );
}

function safeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const source = headersToRecord(headers);
  return Object.fromEntries(
    Object.entries(source).filter(([name]) =>
      ["accept", "content-type"].includes(name.toLowerCase()),
    ),
  );
}

export function remoteRelayTransportForUrl(
  url: string,
  cloudFactory: () =>
    | RemoteControlCloudClient
    | Promise<RemoteControlCloudClient> = defaultCloudClient,
): AgentRequestTransport | null {
  const profile = relayProfileForUrl(url);
  if (!profile) return null;
  return {
    async request(requestUrl, init) {
      const parsed = new URL(requestUrl);
      const segments = parsed.pathname.split("/").filter(Boolean);
      const path = `/${segments.slice(1).join("/")}${parsed.search}`;
      const rawBody = bodyToString(init.body);
      if (rawBody === undefined && init.body !== undefined) {
        throw new Error("The remote relay supports text request bodies only.");
      }
      const result = await sendCommand(
        await cloudFactory(),
        profile,
        "agent.request",
        {
          path,
          method: (init.method ?? "GET").toUpperCase(),
          body: rawBody ?? null,
          headers: safeHeaders(init.headers),
        },
        init.signal ?? undefined,
      );
      const response =
        result && typeof result === "object" && !Array.isArray(result)
          ? (result as Record<string, RemoteJsonValue>)
          : {};
      return new Response(
        typeof response.body === "string" ? response.body : "",
        {
          status:
            typeof response.status === "number" &&
            response.status >= 100 &&
            response.status <= 599
              ? response.status
              : 502,
          headers:
            response.headers &&
            typeof response.headers === "object" &&
            !Array.isArray(response.headers)
              ? (response.headers as Record<string, string>)
              : { "content-type": "application/json" },
        },
      );
    },
  };
}

export const remoteRelayTransportInternals = { withSessionEnqueue };
