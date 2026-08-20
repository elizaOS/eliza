/** Headless desktop worker that validates, executes, and completes remote commands. */
import type {
  EncryptedRemoteCommand,
  RemoteCommandResult,
  SignedRemoteCommand,
} from "@elizaos/shared";
import { useEffect } from "react";
import { client } from "../../api";
import { invokeDesktopBridgeRequest } from "../../bridge/electrobun-rpc";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import { getOrCreateControllerPublicIdentity } from "../../platform/remote-controller-identity";
import { loadRuntimeCredential } from "../../platform/runtime-credential-store";

const CLOUD_HOST_ID_KEY = "eliza.remote-host.id.v1";

interface ManagedHostCredential {
  hostToken: string;
}

function parseCredential(value: string): ManagedHostCredential | null {
  try {
    const parsed = JSON.parse(value) as Partial<ManagedHostCredential>;
    return typeof parsed.hostToken === "string" && parsed.hostToken
      ? { hostToken: parsed.hostToken }
      : null;
  } catch {
    return null;
  }
}

async function callLocalAgent(command: SignedRemoteCommand): Promise<unknown> {
  let path: string;
  let method: "GET" | "POST";
  let body: string | null = null;
  switch (command.body.action) {
    case "agent.request": {
      const payload = command.body.payload as {
        path?: unknown;
        method?: unknown;
        body?: unknown;
        headers?: unknown;
      };
      if (
        typeof payload?.path !== "string" ||
        payload.path.length > 2_048 ||
        typeof payload.method !== "string" ||
        !["GET", "POST", "PATCH", "DELETE"].includes(payload.method) ||
        (payload.body !== null &&
          payload.body !== undefined &&
          (typeof payload.body !== "string" || payload.body.length > 1_000_000))
      ) {
        throw new Error("Remote agent request is invalid");
      }
      const requestUrl = new URL(payload.path, "http://eliza.local");
      if (requestUrl.origin !== "http://eliza.local") {
        throw new Error("Remote agent request URL is invalid");
      }
      const allowed = [
        /^\/api\/health$/,
        /^\/api\/agents$/,
        /^\/api\/conversations$/,
        /^\/api\/conversations\/messages\/search$/,
        /^\/api\/conversations\/[^/]+$/,
        /^\/api\/conversations\/[^/]+\/messages$/,
        /^\/api\/conversations\/[^/]+\/messages\/stream$/,
        /^\/api\/conversations\/[^/]+\/greeting$/,
        /^\/api\/turns\/[^/]+\/abort$/,
        /^\/api\/agent\/(pause|resume|stop)$/,
      ].some((pattern) => pattern.test(requestUrl.pathname));
      if (!allowed) throw new Error("Remote agent route is not allowed");
      const requestHeaders =
        payload.headers && typeof payload.headers === "object"
          ? Object.fromEntries(
              Object.entries(payload.headers as Record<string, unknown>)
                .filter(
                  ([key, value]) =>
                    ["accept", "content-type"].includes(key.toLowerCase()) &&
                    typeof value === "string" &&
                    value.length <= 256,
                )
                .map(([key, value]) => [key, value as string]),
            )
          : {};
      const response = await invokeDesktopBridgeRequest<{
        status: number;
        body?: string | null;
        headers?: Record<string, string>;
      }>({
        rpcMethod: "localAgentRequest",
        ipcChannel: "local-agent:request",
        params: {
          path: `${requestUrl.pathname}${requestUrl.search}`,
          method: payload.method as "GET" | "POST" | "PATCH" | "DELETE",
          headers: requestHeaders,
          body: typeof payload.body === "string" ? payload.body : null,
          timeoutMs: 10 * 60_000,
        },
      });
      if (!response)
        throw new Error("The local agent transport is unavailable");
      return response;
    }
    case "agent.message": {
      const payload = command.body.payload as {
        conversationId?: unknown;
        text?: unknown;
        channelType?: unknown;
      };
      if (
        typeof payload?.conversationId !== "string" ||
        !payload.conversationId ||
        payload.conversationId.length > 256 ||
        typeof payload.text !== "string" ||
        !payload.text.trim() ||
        payload.text.length > 100_000
      ) {
        throw new Error("Remote message payload is invalid");
      }
      path = `/api/conversations/${encodeURIComponent(payload.conversationId)}/messages`;
      method = "POST";
      body = JSON.stringify({
        text: payload.text,
        channelType:
          typeof payload.channelType === "string" ? payload.channelType : "DM",
      });
      break;
    }
    case "agent.status":
      path = "/api/health";
      method = "GET";
      break;
    case "agent.pause":
      path = "/api/agent/pause";
      method = "POST";
      break;
    case "agent.resume":
      path = "/api/agent/resume";
      method = "POST";
      break;
    case "agent.stop":
      path = "/api/agent/stop";
      method = "POST";
      break;
  }
  const response = await invokeDesktopBridgeRequest<{
    status: number;
    body?: string | null;
  }>({
    rpcMethod: "localAgentRequest",
    ipcChannel: "local-agent:request",
    params: {
      path,
      method,
      headers: { "content-type": "application/json" },
      body,
      timeoutMs: 90_000,
    },
  });
  if (!response) throw new Error("The local agent transport is unavailable");
  const parsed = response.body
    ? (() => {
        try {
          return JSON.parse(response.body) as unknown;
        } catch {
          return { text: response.body };
        }
      })()
    : null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Local agent request failed (${response.status})`);
  }
  return parsed;
}

async function sealResult(input: {
  deviceId: string;
  hostKeyId: string;
  controllerKeyId: string;
  controllerEncryptionPublicKeyJwk: JsonWebKey;
  result: RemoteCommandResult;
}): Promise<EncryptedRemoteCommand> {
  const envelope = await invokeDesktopBridgeRequest<EncryptedRemoteCommand>({
    rpcMethod: "desktopSealRemoteCommandResult",
    ipcChannel: "desktop:sealRemoteCommandResult",
    params: input,
  });
  if (!envelope) throw new Error("Native result encryption is unavailable");
  return envelope;
}

async function processClaim(
  hostId: string,
  hostToken: string,
  hostIdentity: Awaited<ReturnType<typeof getOrCreateControllerPublicIdentity>>,
  sessionId: string,
): Promise<boolean> {
  const claim = await client.claimCloudRemoteCommand({
    sessionId,
    hostId,
    hostToken,
  });
  if (!claim) return false;
  let result: RemoteCommandResult;
  try {
    const command = await invokeDesktopBridgeRequest<SignedRemoteCommand>({
      rpcMethod: "desktopOpenRemoteCommand",
      ipcChannel: "desktop:openRemoteCommand",
      params: {
        deviceId: hostIdentity.deviceId,
        hostKeyId: hostIdentity.keyId,
        envelope: claim.envelope,
        authority: claim.authority,
      },
    });
    if (!command) throw new Error("Native command verification is unavailable");
    result = {
      version: 1,
      commandId: command.body.commandId,
      targetRuntimeId: command.body.targetRuntimeId,
      status: "completed",
      result: await callLocalAgent(command),
      completedAt: Date.now(),
    };
  } catch {
    result = {
      version: 1,
      commandId: claim.commandId,
      targetRuntimeId: claim.authority.targetRuntimeId,
      status: "rejected",
      errorCode: "REMOTE_COMMAND_REJECTED",
      completedAt: Date.now(),
    };
  }
  const resultEnvelope = await sealResult({
    deviceId: hostIdentity.deviceId,
    hostKeyId: hostIdentity.keyId,
    controllerKeyId: claim.authority.controller.keyId,
    controllerEncryptionPublicKeyJwk:
      claim.authority.controller.encryptionPublicKeyJwk,
    result,
  });
  await client.completeCloudRemoteCommand({
    sessionId,
    commandId: claim.commandId,
    hostId,
    hostToken,
    resultEnvelope,
  });
  return true;
}

export function RemoteHostRelayAgent() {
  useEffect(() => {
    if (!isElectrobunRuntime()) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      let delay = 5_000;
      try {
        const hostId = globalThis.localStorage
          ?.getItem(CLOUD_HOST_ID_KEY)
          ?.trim();
        if (!hostId) return;
        const raw = await loadRuntimeCredential(`managed-host:${hostId}`);
        const credential = raw ? parseCredential(raw) : null;
        if (!credential) return;
        const [hostIdentity, sessions] = await Promise.all([
          getOrCreateControllerPublicIdentity(),
          client.listCloudRemoteSessions({ hostId }),
        ]);
        let worked = false;
        for (const session of sessions) {
          if (session.status !== "active" || stopped) continue;
          worked =
            (await processClaim(
              hostId,
              credential.hostToken,
              hostIdentity,
              session.id,
            )) || worked;
        }
        delay = worked ? 100 : 1_500;
      } catch {
        delay = 5_000;
      } finally {
        if (!stopped) timer = setTimeout(() => void run(), delay);
      }
    };
    void run();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
  return null;
}
