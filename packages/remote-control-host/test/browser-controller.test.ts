import { describe, expect, it } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import {
  copyRemoteCommandBinding,
  type RemoteControllerPublicIdentity,
  type SignedRemoteCommand,
} from "@elizaos/core/contracts/remote-control";
import type { BrowserTarget } from "../../../plugins/plugin-browser/src/browser-service";
import {
  AgentRemoteBrowserController,
  remoteBrowserControllerPlugin,
} from "../src/browser-controller";
import { RemoteControlCloudClient } from "../src/cloud-client";
import {
  digestRemoteCommand,
  digestRemoteResultValue,
  openRemoteControlMessage,
  sealRemoteControlMessage,
  signRemoteCommandResult,
} from "../src/crypto";
import type { PlatformSecureStore } from "../src/secure-store-contract";

function fixture() {
  const ownerId = randomUUID(),
    agentId = randomUUID(),
    hostId = randomUUID(),
    sessionId = randomUUID(),
    grantId = randomUUID();
  const keys = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const signing = keys(),
    encryption = keys();
  const publicKey = (key: ReturnType<typeof keys>) =>
    key.publicKey.export({ format: "jwk" });
  const privateKey = (key: ReturnType<typeof keys>) =>
    key.privateKey.export({ format: "jwk" });
  const slots = new Map<string, string>(),
    cache = new Map<string, unknown>(),
    targets = new Map<string, BrowserTarget>();
  const secureStore: PlatformSecureStore = {
    backend: "runtime_encrypted_store",
    isAvailable: async () => true,
    get: async (key) =>
      slots.has(key)
        ? { ok: true, value: slots.get(key) ?? "" }
        : { ok: false, reason: "not_found" },
    set: async (key, _valueKind, value) => {
      slots.set(key, value);
      return { ok: true };
    },
    delete: async (key) => ({ ok: true, deleted: slots.delete(key) }),
  };
  let controller: RemoteControllerPublicIdentity;
  let status = "active",
    revision = 1,
    enqueues = 0,
    pairings = 0,
    forged = false;
  let command: SignedRemoteCommand;
  const host = {
    id: hostId,
    deviceId: "android-device",
    displayName: "My phone",
    platform: "android",
    connectionMode: "relay",
    runtimeKeyId: "target-key",
    signingPublicKeyJwk: publicKey(signing),
    encryptionPublicKeyJwk: publicKey(encryption),
    status: "active",
    lastSeenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    revokedAt: null,
  };
  const cloud = new RemoteControlCloudClient({
    baseUrl: "https://cloud.example",
    authToken: "owner-token",
    request: async (url, init) => {
      const path = new URL(url).pathname;
      let result: unknown;
      if (path.endsWith("/hosts")) result = { ownerId, hosts: [host] };
      else if (path.endsWith("/pair")) {
        pairings++;
        controller = JSON.parse(String(init.body)).controller;
        result = {
          ownerId,
          sessionId,
          grantId,
          grantRevision: 1,
          targetRuntimeId: hostId,
          targetKeyId: "target-key",
          code: "123456",
          expiresAt: new Date(Date.now() + 120000).toISOString(),
          grantExpiresAt: new Date(Date.now() + 3600000).toISOString(),
          status: "pending",
        };
      } else if (path.endsWith("/sessions"))
        result = {
          sessions: [
            {
              id: sessionId,
              ownerId,
              grantId,
              grantRevision: revision,
              hostId,
              targetRuntimeId: hostId,
              status,
              controllerDeviceId: controller.deviceId,
              controllerKeyId: controller.keyId,
              targetKeyId: "target-key",
              grantExpiresAt: new Date(Date.now() + 3600000).toISOString(),
              createdAt: host.createdAt,
              updatedAt: host.createdAt,
            },
          ],
        };
      else if (path.endsWith("/commands")) {
        enqueues++;
        const envelope = JSON.parse(String(init.body)).envelope;
        command = openRemoteControlMessage(envelope, privateKey(encryption), {
          ...copyRemoteCommandBinding(envelope),
          messageKind: "command",
          senderKeyId: controller.keyId,
          recipientKeyId: "target-key",
        }) as SignedRemoteCommand;
        result = { accepted: true };
      } else if (path.includes("/commands/")) {
        const full = "complete Ελληνικά 文\n".repeat(30000);
        const value = {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "desktop",
            subaction: (
              command.body.payload as { command: { subaction: string } }
            ).command.subaction,
            pageContentObserved: true,
            value: { text: full },
          }),
        };
        const signed = signRemoteCommandResult(
          {
            ...copyRemoteCommandBinding(command.body),
            commandDigest: digestRemoteCommand(command),
            status: "completed",
            executionId: "execution-1",
            startedAt: Date.now(),
            completedAt: Date.now(),
            result: value,
            resultDigest: digestRemoteResultValue(value, undefined),
          },
          privateKey(forged ? keys() : signing),
        );
        result = {
          status: "completed",
          startReceipt: null,
          resultEnvelope: sealRemoteControlMessage(
            signed,
            {
              ...copyRemoteCommandBinding(command.body),
              messageKind: "result",
              senderKeyId: "target-key",
              recipientKeyId: controller.keyId,
            },
            controller.encryptionPublicKeyJwk,
          ),
        };
      } else throw new Error(`Unexpected path ${path}`);
      return Response.json(result);
    },
  });
  const runtime = {
    agentId,
    character: { name: "Agent" },
    getService: () => ({
      registerTarget: (target: BrowserTarget) => targets.set(target.id, target),
      unregisterTarget: (id: string) => targets.delete(id),
    }),
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
  } as unknown as IAgentRuntime;
  const instance = new AgentRemoteBrowserController(
    runtime,
    secureStore,
    () => cloud,
  );
  return {
    instance,
    targets,
    slots,
    runtime,
    secureStore,
    cloud,
    sessionId,
    get pairings() {
      return pairings;
    },
    get enqueues() {
      return enqueues;
    },
    setStatus: (value: string) => {
      status = value;
    },
    setRevision: (value: number) => {
      revision = value;
    },
    forge: () => {
      forged = true;
    },
  };
}
async function pair(f: ReturnType<typeof fixture>) {
  await f.instance.pair({
    apiBaseUrl: "https://cloud.example",
    authToken: "owner-token",
    deviceId: "android-device",
    profileId: "profile-1",
    preferred: true,
  });
  await f.instance.confirm({
    sessionId: f.sessionId,
    profileId: "profile-1",
    authorizeBrowser: true,
  });
  const target = [...f.targets.values()][0];
  if (!target) throw new Error("Target missing");
  return target;
}
describe("agent remote browser controller", () => {
  it("rejects a different managed cloud owner before pairing or storing authority", async () => {
    const f = fixture();
    await expect(
      f.instance.pair(
        {
          apiBaseUrl: "https://cloud.example",
          authToken: "other-owner-token",
          deviceId: "android-device",
          profileId: "profile-1",
          preferred: true,
        },
        randomUUID(),
      ),
    ).rejects.toThrow("authenticated agent owner");
    expect(f.pairings).toBe(0);
    expect(f.slots.size).toBe(0);
    expect(f.targets.size).toBe(0);
    expect(f.instance.status()).toEqual({ configured: false });
    expect(f.enqueues).toBe(0);
  });
  it("refuses persisted authority for a different managed owner before registering a target", async () => {
    const f = fixture();
    await pair(f);
    f.targets.clear();
    const restored = new AgentRemoteBrowserController(
      f.runtime,
      f.secureStore,
      () => f.cloud,
    );
    await expect(restored.restore(randomUUID())).rejects.toThrow(
      "different agent owner",
    );
    expect(f.targets.size).toBe(0);
    expect(restored.status()).toEqual({ configured: false });
  });
  it("pairs persisted exact profile, dispatches encrypted once, verifies full signed result, and restores preference", async () => {
    const f = fixture(),
      target = await pair(f);
    expect(target.priority).toBe(1000);
    const result = await target.execute({ subaction: "snapshot", id: "1" });
    expect(result.pageContentObserved).toBe(true);
    expect(result.value).toEqual({
      text: "complete Ελληνικά 文\n".repeat(30000),
    });
    expect(f.enqueues).toBe(1);
    const restored = new AgentRemoteBrowserController(
      f.runtime,
      f.secureStore,
      () => f.cloud,
    );
    await restored.restore();
    expect(restored.status()).toMatchObject({
      active: true,
      profileId: "profile-1",
      preferred: true,
    });
  });
  it("denies implicit/legacy profile grants and revoked or stale session before enqueue", async () => {
    const f = fixture();
    await f.instance.pair({
      apiBaseUrl: "https://cloud.example",
      authToken: "owner-token",
      deviceId: "android-device",
      profileId: "profile-1",
    });
    await expect(
      f.instance.confirm({ sessionId: f.sessionId, authorizeBrowser: true }),
    ).rejects.toThrow(/exact browser profile/);
    await f.instance.confirm({
      sessionId: f.sessionId,
      profileId: "profile-1",
      authorizeBrowser: true,
    });
    const target = [...f.targets.values()][0];
    if (!target) throw new Error("Target missing");
    f.setRevision(2);
    expect(await target.available()).toBe(false);
    await expect(
      target.execute({ subaction: "click", id: "1", selector: "#submit" }),
    ).rejects.toThrow(/grant changed/);
    expect(f.enqueues).toBe(0);
  });
  it("rejects forged terminal receipt without replaying dispatched effect", async () => {
    const f = fixture(),
      target = await pair(f);
    f.forge();
    await expect(
      target.execute({ subaction: "click", id: "1", selector: "#submit" }),
    ).rejects.toThrow(/signature/);
    expect(f.enqueues).toBe(1);
  });
  it("refuses a non-owner route request", async () => {
    const route = remoteBrowserControllerPlugin.routes?.find((route) =>
      route.path.endsWith("/pair"),
    );
    if (!route?.routeHandler) throw new Error("Route missing");
    await expect(
      route.routeHandler({
        runtime: fixture().runtime,
        body: {},
        params: {},
        query: {},
        headers: {},
        method: "POST",
        path: route.path,
        inProcess: false,
      }),
    ).rejects.toThrow(/authenticated agent owner/);
  });
});
