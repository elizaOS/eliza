/** E2E Cloud-relay transport for a controller driving a linked native host. */
import type { EncryptedRemoteCommand } from "@elizaos/shared";
import { createEncryptedRemoteCommand } from "../platform/remote-control-crypto";
import {
  getOrCreateControllerPublicIdentity,
  openRemoteCommandResult,
} from "../platform/remote-controller-identity";
import type { AgentProfile } from "../state/agent-profile-types";
import { loadAgentProfileRegistry } from "../state/agent-profiles";
import { runAsPrivilegedShell } from "../surface-realm-channel";
import type { AgentRequestTransport } from "./transport";

interface RelayClient {
  enqueueCloudRemoteCommand(input: {
    sessionId: string;
    commandId: string;
    sequence: number;
    expiresAt: number;
    envelope: EncryptedRemoteCommand;
  }): Promise<void>;
  readCloudRemoteCommandResult(input: {
    sessionId: string;
    commandId: string;
  }): Promise<{
    status: "pending" | "claimed" | "completed" | "expired";
    resultEnvelope: EncryptedRemoteCommand | null;
  }>;
}

const sequenceLocks = new Map<string, Promise<void>>();

function incrementPersistedSequence(sessionId: string): number {
  const key = `eliza.remote-relay.sequence.v1:${sessionId}`;
  const existing = Number(globalThis.localStorage?.getItem(key) ?? "0");
  const sequence =
    Number.isSafeInteger(existing) && existing >= 0 ? existing + 1 : 1;
  runAsPrivilegedShell(() =>
    globalThis.localStorage?.setItem(key, String(sequence)),
  );
  return sequence;
}

function relayProfileForUrl(url: string): AgentProfile | null {
  let base: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "eliza-remote:" || parsed.hostname !== "session") {
      return null;
    }
    base = `${parsed.protocol}//${parsed.hostname}/${parsed.pathname.split("/").filter(Boolean)[0] ?? ""}`;
  } catch {
    return null;
  }
  return (
    loadAgentProfileRegistry().profiles.find(
      (profile) => profile.remoteRelay && profile.apiBase === base,
    ) ?? null
  );
}

async function nextSequence(sessionId: string): Promise<number> {
  const lockManager = globalThis.navigator?.locks;
  if (lockManager) {
    return lockManager.request(
      `eliza.remote-relay.sequence.v1:${sessionId}`,
      () => incrementPersistedSequence(sessionId),
    );
  }
  const prior = sequenceLocks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = prior.then(() => current);
  sequenceLocks.set(sessionId, queued);
  await prior;
  try {
    return incrementPersistedSequence(sessionId);
  } finally {
    release();
    if (sequenceLocks.get(sessionId) === queued) {
      sequenceLocks.delete(sessionId);
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
  cloud: RelayClient,
  profile: AgentProfile,
  action:
    | "agent.request"
    | "agent.message"
    | "agent.status"
    | "agent.pause"
    | "agent.resume"
    | "agent.stop",
  payload: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const relay = profile.remoteRelay;
  if (!relay) throw new Error("Remote relay authority is missing");
  const identity = await getOrCreateControllerPublicIdentity();
  const sequence = await nextSequence(relay.sessionId);
  const created = await createEncryptedRemoteCommand({
    ownerId: relay.ownerId,
    sessionId: relay.sessionId,
    targetRuntimeId: relay.targetRuntimeId,
    controller: identity,
    targetKeyId: relay.targetKeyId,
    targetEncryptionPublicKeyJwk: relay.targetEncryptionPublicKeyJwk,
    sequence,
    action,
    payload,
  });
  await cloud.enqueueCloudRemoteCommand({
    sessionId: relay.sessionId,
    commandId: created.command.body.commandId,
    sequence,
    expiresAt: created.command.body.expiresAt,
    envelope: created.envelope,
  });
  // `expiresAt` bounds when a host may ACCEPT the signed command. Once claimed,
  // model/tool work may legitimately run longer, so keep waiting for its
  // authenticated result without extending the command's replay window.
  const resultDeadline = created.command.body.expiresAt + 10 * 60_000;
  while (Date.now() <= resultDeadline) {
    if (signal?.aborted)
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const current = await cloud.readCloudRemoteCommandResult({
      sessionId: relay.sessionId,
      commandId: created.command.body.commandId,
    });
    if (current.status === "expired") throw new Error("Remote command expired");
    if (
      current.status === "pending" &&
      Date.now() > created.command.body.expiresAt + 30_000
    ) {
      throw new Error("Remote host did not accept the command in time");
    }
    if (current.status === "completed" && current.resultEnvelope) {
      const result = await openRemoteCommandResult({
        identity,
        envelope: current.resultEnvelope,
        targetSigningPublicKeyJwk: relay.targetSigningPublicKeyJwk,
        expectedCommandId: created.command.body.commandId,
        expectedTargetRuntimeId: relay.targetRuntimeId,
      });
      if (result.status !== "completed") {
        throw new Error(`Remote command was ${result.status}`);
      }
      return result.result;
    }
    await wait(250, signal);
  }
  throw new Error("Remote command timed out");
}

function requestHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> {
  const safe: Record<string, string> = {};
  const source = new Headers(headers ?? {});
  for (const name of ["accept", "content-type"]) {
    const value = source.get(name);
    if (value) safe[name] = value;
  }
  return safe;
}

export function remoteRelayTransportForUrl(
  url: string,
  cloud: RelayClient,
): AgentRequestTransport | null {
  const profile = relayProfileForUrl(url);
  if (!profile) return null;
  return {
    async request(requestUrl, init) {
      const parsed = new URL(requestUrl);
      // The first path segment is the relay session encoded in the pseudo-base;
      // everything after it is the ordinary agent API path.
      const path = `/${parsed.pathname.split("/").filter(Boolean).slice(1).join("/")}`;
      const method = (init.method ?? "GET").toUpperCase();
      const result = (await sendCommand(
        cloud,
        profile,
        "agent.request",
        {
          path: `${path}${parsed.search}`,
          method,
          body: typeof init.body === "string" ? init.body : null,
          headers: requestHeaders(init.headers),
        },
        init.signal ?? undefined,
      )) as {
        status?: unknown;
        body?: unknown;
        headers?: unknown;
      };
      const status =
        typeof result?.status === "number" &&
        result.status >= 100 &&
        result.status <= 599
          ? result.status
          : 502;
      const headers = new Headers(
        result?.headers && typeof result.headers === "object"
          ? (result.headers as Record<string, string>)
          : {},
      );
      if (!headers.has("content-type"))
        headers.set("content-type", "application/json");
      return new Response(typeof result?.body === "string" ? result.body : "", {
        status,
        headers,
      });
    },
  };
}
