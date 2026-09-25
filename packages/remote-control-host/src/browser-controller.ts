/** Owner-authorized agent controller. The Cloud relay receives ciphertext only. */
import {
  ElizaError,
  fetchWithSsrfGuard,
  type IAgentRuntime,
} from "@elizaos/core";
import {
  type BrowserService,
  createRemoteBrowserDeviceTarget,
} from "@elizaos/plugin-browser";
import type { HttpPlugin, RouteHandlerContext } from "@elizaos/shared";
import type {
  RemoteBrowserCommandPayload,
  RemoteControllerPublicIdentity,
  RemoteTargetPublicIdentity,
} from "@elizaos/shared/contracts/remote-control";
import {
  isRemoteControllerPublicIdentity,
  isRemoteTargetPublicIdentity,
} from "@elizaos/shared/contracts/remote-control";
import {
  RemoteControlCloudClient,
  type RemoteSessionSummary,
} from "./cloud-client";
import {
  desktopAcknowledgeRemoteCommandEnqueue,
  desktopCreateRemoteCommand,
  desktopGetOrCreateControllerIdentity,
  desktopOpenRemoteCommandResult,
  desktopOpenRemoteCommandStartReceipt,
} from "./controller";
import { createRuntimePlatformSecureStore } from "./runtime-store";
import type { PlatformSecureStore } from "./secure-store-contract";

const VAULT = "agent-preferred-browser-v1";
const CONFIGURED = "remote-browser-controller:configured:v1";
interface Enrollment {
  version: 1;
  ownerId: string;
  apiBaseUrl: string;
  authToken: string;
  profileId: string;
  controller: RemoteControllerPublicIdentity;
  target: RemoteTargetPublicIdentity;
  deviceId: string;
  sessionId: string;
  grantId: string;
  grantRevision: number;
  preferred: boolean;
  active: boolean;
}
function failure(message: string): ElizaError {
  return new ElizaError(message, { code: "REMOTE_BROWSER_AUTHORITY" });
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096)
    throw failure("Required remote browser parameter is invalid.");
  return value;
}
function identifier(value: unknown): string {
  const result = string(value);
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(result))
    throw failure("Remote browser identity is invalid.");
  return result;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw failure("Remote browser parameters are required.");
  return value as Record<string, unknown>;
}

export function createAgentRemoteCloudClient(enrollment: {
  apiBaseUrl: string;
  authToken: string;
}): RemoteControlCloudClient {
  const base = new URL(enrollment.apiBaseUrl);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw failure("Cloud browser relay must use HTTPS.");
  return new RemoteControlCloudClient({
    baseUrl: base.toString(),
    authToken: enrollment.authToken,
    request: async (url, init) => {
      const guarded = await fetchWithSsrfGuard({
        url,
        init,
        maxRedirects: 0,
        timeoutMs: 30000,
      });
      try {
        // Return complete bytes after releasing the pinned network resource.
        const bytes = await guarded.response.arrayBuffer();
        return new Response(guarded.response.status === 204 ? null : bytes, {
          status: guarded.response.status,
          headers: guarded.response.headers,
        });
      } finally {
        await guarded.release();
      }
    },
  });
}

export class AgentRemoteBrowserController {
  private enrollment: Enrollment | null = null;
  private targetId: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    readonly runtime: IAgentRuntime,
    readonly store: PlatformSecureStore = createRuntimePlatformSecureStore(
      runtime,
    ),
    readonly cloudFactory = createAgentRemoteCloudClient,
  ) {}

  private async persist(next: Enrollment): Promise<void> {
    const written = await this.store.set(
      VAULT,
      "runtime.agent_profiles",
      JSON.stringify(next),
    );
    if (!written.ok)
      throw failure("Could not persist encrypted browser authority.");
    if (!(await this.runtime.setCache(CONFIGURED, true)))
      throw failure("Could not persist browser preference marker.");
    this.enrollment = next;
  }
  async restore(): Promise<void> {
    if (!(await this.runtime.getCache<boolean>(CONFIGURED))) return;
    const read = await this.store.get(VAULT, "runtime.agent_profiles");
    if (!read.ok) throw failure("Persisted browser authority is unavailable.");
    const value = record(JSON.parse(read.value));
    if (
      value.version !== 1 ||
      !isRemoteTargetPublicIdentity(value.target) ||
      typeof value.active !== "boolean" ||
      typeof value.preferred !== "boolean"
    )
      throw failure("Persisted browser authority is invalid.");
    for (const key of [
      "ownerId",
      "profileId",
      "deviceId",
      "sessionId",
      "grantId",
    ])
      identifier(value[key]);
    string(value.authToken);
    string(value.apiBaseUrl);
    const controller = record(value.controller);
    if (
      !isRemoteControllerPublicIdentity(controller) ||
      controller.ownerId !== value.ownerId ||
      value.target.ownerId !== value.ownerId ||
      !Number.isSafeInteger(value.grantRevision)
    )
      throw failure("Persisted browser owner binding is invalid.");
    this.enrollment = value as unknown as Enrollment;
    if (this.enrollment.active) this.register();
  }
  assertOwner(ownerId: string): void {
    if (this.enrollment && this.enrollment.ownerId !== ownerId)
      throw failure("Browser controller belongs to a different owner.");
  }
  status() {
    const value = this.enrollment;
    return value
      ? {
          configured: true,
          active: value.active,
          ownerId: value.ownerId,
          deviceId: value.deviceId,
          profileId: value.profileId,
          sessionId: value.sessionId,
          preferred: value.preferred,
          targetId: this.targetId,
        }
      : { configured: false };
  }
  async pair(body: unknown, expectedOwnerId?: string) {
    const input = record(body);
    const apiBaseUrl = string(input.apiBaseUrl),
      authToken = string(input.authToken);
    const profileId = identifier(input.profileId),
      deviceId = identifier(input.deviceId);
    const cloud = this.cloudFactory({ apiBaseUrl, authToken });
    const directory = await cloud.listHosts();
    if (expectedOwnerId && directory.ownerId !== expectedOwnerId)
      throw failure(
        "Cloud account does not match the authenticated agent owner.",
      );
    const host = directory.hosts.find(
      (item) => item.deviceId === deviceId && item.status !== "revoked",
    );
    if (!host)
      throw failure(
        "The selected browser device does not belong to this Cloud owner.",
      );
    const controller = await desktopGetOrCreateControllerIdentity(
      {
        ownerId: directory.ownerId,
        deviceId: this.runtime.agentId,
        displayName: this.runtime.character.name || "Eliza agent",
        platform: "linux",
      },
      this.store,
    );
    const target: RemoteTargetPublicIdentity = {
      version: 1,
      role: "target",
      ownerId: directory.ownerId,
      runtimeId: host.id,
      keyId: host.runtimeKeyId,
      displayName: host.displayName,
      platform: host.platform,
      signingPublicKeyJwk: host.signingPublicKeyJwk,
      encryptionPublicKeyJwk: host.encryptionPublicKeyJwk,
      createdAt: Date.parse(host.createdAt),
    };
    if (!isRemoteTargetPublicIdentity(target))
      throw failure("Device public identity is invalid.");
    const pairing = await cloud.createPairing({ hostId: host.id, controller });
    await this.persist({
      version: 1,
      ownerId: directory.ownerId,
      apiBaseUrl,
      authToken,
      profileId,
      deviceId,
      controller,
      target,
      sessionId: pairing.sessionId,
      grantId: pairing.grantId,
      grantRevision: pairing.grantRevision,
      preferred: input.preferred === true,
      active: false,
    });
    this.unregister();
    return { ...pairing, controller, profileId, deviceId };
  }
  private async session(
    enrollment: Enrollment,
  ): Promise<RemoteSessionSummary | null> {
    const cloud = this.cloudFactory(enrollment);
    const directory = await cloud.listHosts();
    if (directory.ownerId !== enrollment.ownerId)
      throw failure("Cloud account changed; pair the browser again.");
    const host = directory.hosts.find(
      (item) =>
        item.id === enrollment.target.runtimeId &&
        item.deviceId === enrollment.deviceId,
    );
    if (
      !host ||
      host.runtimeKeyId !== enrollment.target.keyId ||
      host.status === "revoked"
    )
      throw failure("Browser device identity was revoked or replaced.");
    const sessions = await cloud.listSessions(host.id, enrollment.ownerId);
    const session = sessions.find((item) => item.id === enrollment.sessionId);
    if (
      !session ||
      session.grantId !== enrollment.grantId ||
      session.grantRevision !== enrollment.grantRevision ||
      session.controllerDeviceId !== enrollment.controller.deviceId ||
      session.controllerKeyId !== enrollment.controller.keyId ||
      session.targetKeyId !== enrollment.target.keyId ||
      session.targetRuntimeId !== enrollment.target.runtimeId ||
      session.status !== "active" ||
      (session.grantExpiresAt !== null &&
        Date.parse(session.grantExpiresAt) <= Date.now())
    )
      return null;
    return host.status === "active" ? session : null;
  }
  async confirm(body: unknown) {
    const input = record(body),
      current = this.enrollment;
    if (
      !current ||
      input.sessionId !== current.sessionId ||
      input.profileId !== current.profileId ||
      input.authorizeBrowser !== true
    )
      throw failure(
        "Explicit authorization for this exact browser profile and session is required.",
      );
    if (!(await this.session(current)))
      throw failure(
        "The device has not activated this controller grant, or is offline.",
      );
    await this.persist({ ...current, active: true });
    const targetId = `device:${current.deviceId}:${current.profileId}`;
    if (
      current.preferred &&
      !(await this.runtime.setCache("browser.search-profile", {
        targetId,
        profileId: current.profileId,
      }))
    )
      throw failure("Could not persist preferred browser search profile.");
    this.register();
    return this.status();
  }
  private unregister() {
    if (this.targetId)
      this.runtime
        .getService<BrowserService>("browser")
        ?.unregisterTarget(this.targetId);
    this.targetId = null;
  }
  private register() {
    const current = this.enrollment;
    if (!current?.active) return;
    const browser = this.runtime.getService<BrowserService>("browser");
    if (!browser) throw failure("Browser service is unavailable.");
    this.unregister();
    const target = createRemoteBrowserDeviceTarget({
      deviceId: current.deviceId,
      profileId: current.profileId,
      displayName: current.target.displayName,
      available: async () =>
        this.enrollment === current && Boolean(await this.session(current)),
      execute: (command) => {
        const next = this.tail.then(() => this.execute(current, command));
        // error-policy:J5 The dispatch caller receives failure; preserve queue progress without replay.
        this.tail = next.catch(() => undefined);
        return next;
      },
    });
    browser.registerTarget(
      current.preferred ? { ...target, priority: 1000 } : target,
    );
    this.targetId = target.id;
  }
  private async execute(
    current: Enrollment,
    payload: RemoteBrowserCommandPayload,
  ) {
    if (
      this.enrollment !== current ||
      payload.profileId !== current.profileId ||
      !(await this.session(current))
    )
      throw failure("Browser grant changed before dispatch.");
    const cloud = this.cloudFactory(current);
    const created = await desktopCreateRemoteCommand(
      {
        ownerId: current.ownerId,
        grantId: current.grantId,
        grantRevision: current.grantRevision,
        sessionId: current.sessionId,
        controllerDeviceId: current.controller.deviceId,
        controllerKeyId: current.controller.keyId,
        targetRuntimeId: current.target.runtimeId,
        targetKeyId: current.target.keyId,
        targetEncryptionPublicKeyJwk: current.target.encryptionPublicKeyJwk,
        action: "browser.command",
        payload,
      },
      this.store,
    );
    if (created.recoveredPending)
      throw failure(
        "An earlier browser command has an unresolved enqueue; recover its receipt before issuing another command.",
      );
    await cloud.enqueueCommand({
      sessionId: current.sessionId,
      envelope: created.envelope,
    });
    const acknowledged = await desktopAcknowledgeRemoteCommandEnqueue(
      {
        ownerId: current.ownerId,
        controllerDeviceId: current.controller.deviceId,
        sessionId: current.sessionId,
        commandId: created.commandId,
        bindingDigest: created.bindingDigest,
      },
      this.store,
    );
    if (!acknowledged.acknowledged)
      throw failure(
        "Browser enqueue receipt could not be persisted; the command will not be replayed.",
      );
    let verifiedStart = false;
    while (Date.now() <= created.expiresAt + 10 * 60_000) {
      const status = await cloud.readCommand({
        sessionId: current.sessionId,
        commandId: created.commandId,
      });
      const binding = {
        ownerId: current.ownerId,
        controllerDeviceId: current.controller.deviceId,
        command: created.command,
        targetIdentity: current.target,
      };
      if (status.startReceipt && !verifiedStart) {
        await desktopOpenRemoteCommandStartReceipt(
          { ...binding, envelope: status.startReceipt },
          this.store,
        );
        verifiedStart = true;
      }
      if (status.status === "started" && !verifiedStart)
        throw failure(
          "Browser start receipt could not be verified; command was not replayed.",
        );
      if (
        (status.status === "completed" || status.status === "failed") &&
        status.resultEnvelope
      ) {
        const result = await desktopOpenRemoteCommandResult(
          { ...binding, envelope: status.resultEnvelope },
          this.store,
        );
        if (result.status !== "completed")
          throw failure(
            `Remote browser command failed: ${result.errorCode ?? "unknown"}`,
          );
        const response = record(result.result);
        if (response.status !== 200 || typeof response.body !== "string")
          throw failure("Remote browser result is malformed.");
        return JSON.parse(response.body);
      }
      if (
        ["execution_ambiguous", "expired", "cancelled", "failed"].includes(
          status.status,
        )
      )
        throw failure(
          "Browser command did not produce a verified success; it was not replayed.",
        );
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw failure("Browser command result is unresolved; it was not replayed.");
  }
  async revoke() {
    const current = this.enrollment;
    if (current)
      await this.cloudFactory(current).revokeSession(current.sessionId);
    this.unregister();
    const removed = await this.store.delete(VAULT, "runtime.agent_profiles");
    if (!removed.ok)
      throw failure("Could not remove encrypted browser authority.");
    this.enrollment = null;
    const selected = await this.runtime.getCache<{ targetId?: string }>(
      "browser.search-profile",
    );
    if (
      current &&
      selected?.targetId === `device:${current.deviceId}:${current.profileId}`
    )
      await this.runtime.setCache("browser.search-profile", { disabled: true });
    await this.runtime.setCache(CONFIGURED, false);
    return { revoked: true };
  }
}

const instances = new WeakMap<IAgentRuntime, AgentRemoteBrowserController>();
export function remoteBrowserController(runtime: IAgentRuntime) {
  let controller = instances.get(runtime);
  if (!controller) {
    controller = new AgentRemoteBrowserController(runtime);
    instances.set(runtime, controller);
  }
  return controller;
}
export async function restoreRemoteBrowserController(
  runtime: IAgentRuntime,
): Promise<void> {
  try {
    await remoteBrowserController(runtime).restore();
  } catch (error) {
    // error-policy:J1 A unavailable encrypted device grant disables remote browsing, not the agent runtime.
    runtime.reportError("remote-browser-controller.restore", error);
  }
}
function owner(context: RouteHandlerContext) {
  if (
    !context.isTrustedLocal &&
    !context.inProcess &&
    !context.accessContext?.isOwner &&
    context.accessContext?.role !== "OWNER"
  )
    throw failure(
      "Only the authenticated agent owner may configure browser device authority.",
    );
}
export const remoteBrowserControllerPlugin: HttpPlugin = {
  name: "remote-browser-controller",
  description: "Owner-paired device browser preferences for hosted agents.",
  routes: ["status", "pair", "confirm", "revoke"].map((operation) => ({
    type: operation === "status" ? "GET" : "POST",
    path: `/api/remote-browser/${operation}`,
    rawPath: true,
    modes: ["local", "local-only", "cloud", "remote"],
    routeHandler: async (context) => {
      owner(context);
      const controller = remoteBrowserController(context.runtime);
      const result =
        operation === "status"
          ? controller.status()
          : operation === "pair"
            ? await controller.pair(context.body)
            : operation === "confirm"
              ? await controller.confirm(context.body)
              : await controller.revoke();
      return { status: 200, body: result };
    },
  })),
};
