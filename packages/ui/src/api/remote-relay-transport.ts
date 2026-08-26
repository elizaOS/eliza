/**
 * Sends controller requests through the opaque Cloud relay with native E2EE
 * signing/decryption. A command is enqueued exactly once; after a signed start
 * receipt the client only polls status and never replays the effect.
 */

import {
  parseRemoteAgentRequest,
  type RemoteAgentRequest,
} from "@elizaos/shared/contracts/remote-agent-request";
import type {
  RemoteCommandAction,
  RemoteJsonValue,
  RemoteTargetPublicIdentity,
  SignedRemoteCommand,
} from "@elizaos/shared/contracts/remote-control";
import {
  acknowledgeRemoteCommandEnqueue,
  createRemoteCommand,
  getOrCreateRemoteControllerIdentity,
  openRemoteCommandResult,
  openRemoteCommandStartReceipt,
} from "../platform/remote-controller";
import type { AgentProfile } from "../state/agent-profile-types";
import { loadAgentProfileRegistry } from "../state/agent-profiles";
import type { RemoteControlCloudClient } from "./remote-control-cloud-client";

type RemoteRelayCloudClient = Pick<
  RemoteControlCloudClient,
  "enqueueCommand" | "readCommand"
>;

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
    // error-policy:J3 profile pseudo-URLs are untrusted transport input.
    return null;
  }
  if (
    parsed.protocol !== "eliza-remote:" ||
    parsed.host !== "session" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const sessionId = segments[0];
  if (
    segments.length !== 1 ||
    !sessionId ||
    !/^[A-Za-z0-9._-]{1,256}$/.test(sessionId)
  ) {
    return null;
  }
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
  // error-policy:J5 the failed enqueue caller observes its rejection; this
  // queue tail only preserves progress for later session commands.
  const queued = predecessor.catch(() => undefined).then(() => current);
  enqueueTails.set(sessionId, queued);
  // error-policy:J5 the originating enqueue caller observes the same
  // predecessor rejection; this waiter only preserves queue ordering.
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

interface RemoteRelayCommandDependencies {
  getController: typeof getOrCreateRemoteControllerIdentity;
  createCommand: typeof createRemoteCommand;
  acknowledgeEnqueue: typeof acknowledgeRemoteCommandEnqueue;
  openStartReceipt: typeof openRemoteCommandStartReceipt;
  openResult: typeof openRemoteCommandResult;
  now: () => number;
  wait: (ms: number) => Promise<void>;
}

const remoteRelayCommandDependencies: RemoteRelayCommandDependencies = {
  getController: getOrCreateRemoteControllerIdentity,
  createCommand: createRemoteCommand,
  acknowledgeEnqueue: acknowledgeRemoteCommandEnqueue,
  openStartReceipt: openRemoteCommandStartReceipt,
  openResult: openRemoteCommandResult,
  now: Date.now,
  wait,
};

async function sendCommand(
  cloud: RemoteRelayCloudClient,
  profile: AgentProfile,
  action: RemoteCommandAction,
  payload: RemoteJsonValue,
  signal?: AbortSignal,
  dependencies: RemoteRelayCommandDependencies = remoteRelayCommandDependencies,
): Promise<RemoteJsonValue | undefined> {
  throwIfAborted(signal);
  const relay = profile.remoteRelay;
  if (!relay) throw new Error("Remote relay authority is missing.");
  const controller = await dependencies.getController({
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
    createdAt: relay.targetCreatedAt,
  };
  if (!Number.isSafeInteger(target.createdAt) || target.createdAt <= 0) {
    throw new Error(
      "This remote profile is missing trusted host metadata. Remove it and pair again.",
    );
  }
  const created = await withSessionEnqueue(relay.sessionId, async () => {
    throwIfAborted(signal);
    for (;;) {
      const next = await dependencies.createCommand({
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
      const acknowledged = await dependencies.acknowledgeEnqueue({
        ownerId: relay.ownerId,
        controllerDeviceId: controller.deviceId,
        sessionId: relay.sessionId,
        commandId: next.commandId,
        bindingDigest: next.bindingDigest,
      });
      if (!acknowledged) {
        throw new Error(
          "The remote enqueue acknowledgement was not persisted.",
        );
      }
      if (!next.recoveredPending) return next;
    }
  });

  const resultDeadline = created.expiresAt + 10 * 60_000;
  let crossedStartBoundary = false;
  let verifiedStartReceipt = false;
  const command: SignedRemoteCommand = created.command;
  while (dependencies.now() <= resultDeadline) {
    const current = await cloud.readCommand({
      sessionId: relay.sessionId,
      commandId: created.commandId,
    });
    if (current.startReceipt && !verifiedStartReceipt) {
      await dependencies.openStartReceipt({
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
      const result = await dependencies.openResult({
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
    if (
      !crossedStartBoundary &&
      dependencies.now() > created.expiresAt + 30_000
    ) {
      throw new Error("The remote host did not accept the command in time.");
    }
    // The caller's AbortSignal is intentionally no longer observed after the
    // command has crossed the durable enqueue boundary. Returning AbortError
    // here would discard the only command handle while the target can still
    // execute it, allowing a retry to create a second semantic operation.
    await dependencies.wait(300);
  }
  throw new Error(
    crossedStartBoundary
      ? "The remote command may still be running. It was not retried."
      : "The remote command timed out before starting.",
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
      const request = normalizeRelayAgentRequest(
        requestUrl,
        init,
        profile.remoteRelay?.sessionId,
      );
      // Rebuild the validated DTO as the protocol's JSON index shape instead
      // of widening RemoteAgentRequest (whose optional body is intentionally
      // absent, never serialized as undefined) or asserting through unknown.
      const payload: RemoteJsonValue = {
        path: request.path,
        method: request.method,
        headers: { ...request.headers },
        ...(request.body !== undefined ? { body: request.body } : {}),
      };
      const result = await sendCommand(
        await cloudFactory(),
        profile,
        "agent.request",
        payload,
        init.signal ?? undefined,
      );
      return responseFromRemoteResult(result);
    },
  };
}

function normalizeRelayAgentRequest(
  requestUrl: string,
  init: RequestInit,
  expectedSessionId?: string,
): RemoteAgentRequest {
  const parsed = new URL(requestUrl);
  if (
    parsed.protocol !== "eliza-remote:" ||
    parsed.host !== "session" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error("The encrypted relay request target is invalid.");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (
    segments.length < 2 ||
    (expectedSessionId !== undefined && segments[0] !== expectedSessionId)
  ) {
    throw new Error("The encrypted relay request path is invalid.");
  }
  const path = `/${segments.slice(1).join("/")}${parsed.search}`;
  const method = (init.method ?? "GET").toUpperCase();
  const headers = headersToRecord(init.headers);
  const body = bodyToString(init.body);
  if (body === undefined && init.body !== undefined) {
    throw new Error("The encrypted relay supports text request bodies only.");
  }
  return parseRemoteAgentRequest({
    path,
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
}

function responseFromRemoteResult(
  result: RemoteJsonValue | undefined,
): Response {
  const response =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, RemoteJsonValue>)
      : {};
  const validStatus =
    typeof response.status === "number" &&
    Number.isInteger(response.status) &&
    response.status >= 100 &&
    response.status <= 599;
  const remoteHeaders =
    response.headers &&
    typeof response.headers === "object" &&
    !Array.isArray(response.headers)
      ? (response.headers as Record<string, RemoteJsonValue>)
      : {};
  const contentType = remoteHeaders["content-type"];
  const contentTypeHasControl =
    typeof contentType === "string" &&
    Array.from(contentType).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    });
  const headers =
    typeof contentType === "string" &&
    contentType.length <= 256 &&
    !contentTypeHasControl
      ? { "content-type": contentType }
      : { "content-type": "application/json" };
  return new Response(
    validStatus && typeof response.body === "string" ? response.body : "",
    {
      status: validStatus ? (response.status as number) : 502,
      headers,
    },
  );
}

export const remoteRelayTransportInternals = {
  normalizeRelayAgentRequest,
  // Backward-compatible test seam retained while the route contract expands.
  normalizeRelayHealthRequest: normalizeRelayAgentRequest,
  responseFromRemoteResult,
  sendCommand,
  withSessionEnqueue,
};
