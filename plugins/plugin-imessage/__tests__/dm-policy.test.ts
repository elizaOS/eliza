/**
 * Covers the DM access gate for the "pairing" policy: unknown senders are
 * held through the core PairingService handshake (a request is created and the
 * one-time code is returned for the consent-gated reply) instead of being
 * silently allowed, pairing-approved senders and static allowlist entries
 * pass, a missing PairingService fails closed, and open/allowlist/disabled
 * policies keep their existing semantics. Runs the real IMessageService
 * against a stub runtime with a mocked PairingService — no chat.db or macOS
 * bridge.
 */
import { type IAgentRuntime, ServiceType, type UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { IMessageService } from "../src/service.js";
import type { IMessageSettings } from "../src/types.js";

type DmAccess = { allowed: boolean; pairingReplyMessage?: string };
type ServiceInternals = {
  settings: IMessageSettings | null;
  checkDmAccess(handle: string): Promise<DmAccess>;
  isAutoReplyEnabled(): boolean;
};

function makeSettings(overrides: Partial<IMessageSettings> = {}): IMessageSettings {
  return {
    cliPath: "imsg",
    pollIntervalMs: 5000,
    heartbeatIntervalMs: 60000,
    dmPolicy: "pairing",
    groupPolicy: "allowlist",
    allowFrom: [],
    enabled: true,
    ...overrides,
  };
}

function makeService(
  settings: IMessageSettings,
  options: {
    pairingAllowed?: boolean;
    pairingService?: boolean;
    settings?: Record<string, unknown>;
  } = {}
) {
  const pairingService = {
    isAllowed: vi.fn(async () => options.pairingAllowed ?? false),
    upsertRequest: vi.fn(async () => ({ code: "PAIRCODE1", created: true })),
    claimPairingReply: vi.fn(() => true),
  };
  const runtime = {
    agentId: "agent-1" as UUID,
    getSetting: (key: string) => options.settings?.[key],
    getService: (serviceType: string) =>
      serviceType === ServiceType.PAIRING && options.pairingService !== false
        ? pairingService
        : null,
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  const service = new IMessageService(runtime);
  const internals = service as unknown as ServiceInternals;
  internals.settings = settings;
  return { service, internals, runtime, pairingService };
}

describe("iMessage DM pairing gate", () => {
  it("holds an unknown sender and returns the pairing-code reply message", async () => {
    const { internals, pairingService } = makeService(makeSettings());

    const access = await internals.checkDmAccess("+14155552671");

    expect(access.allowed).toBe(false);
    expect(access.pairingReplyMessage).toContain("PAIRCODE1");
    expect(pairingService.isAllowed).toHaveBeenCalledWith("imessage", "+14155552671");
    expect(pairingService.upsertRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "imessage",
        senderId: "+14155552671",
      })
    );
  });

  it("admits a pairing-approved sender without a reply message", async () => {
    const { internals, pairingService } = makeService(makeSettings(), {
      pairingAllowed: true,
    });

    const access = await internals.checkDmAccess("+14155552671");

    expect(access).toEqual({ allowed: true });
    expect(pairingService.upsertRequest).not.toHaveBeenCalled();
  });

  it("admits a statically allowlisted sender without consulting pairing", async () => {
    const { internals, pairingService } = makeService(
      makeSettings({ allowFrom: ["+14155552671"] })
    );

    const access = await internals.checkDmAccess("+14155552671");

    expect(access).toEqual({ allowed: true });
    expect(pairingService.isAllowed).not.toHaveBeenCalled();
  });

  it("fails closed when the PairingService is not registered", async () => {
    const { internals, runtime } = makeService(makeSettings(), {
      pairingService: false,
    });

    const access = await internals.checkDmAccess("+14155552671");

    expect(access.allowed).toBe(false);
    expect(runtime.reportError).toHaveBeenCalled();
  });

  it("keeps open, allowlist, and disabled policy semantics", async () => {
    const open = makeService(makeSettings({ dmPolicy: "open" }));
    expect(await open.internals.checkDmAccess("+14155559999")).toEqual({
      allowed: true,
    });

    const allowlist = makeService(
      makeSettings({
        dmPolicy: "allowlist",
        allowFrom: ["alice@example.com"],
      })
    );
    expect(await allowlist.internals.checkDmAccess("ALICE@example.com")).toEqual({ allowed: true });
    expect(await allowlist.internals.checkDmAccess("+14155559999")).toEqual({
      allowed: false,
    });

    const disabled = makeService(makeSettings({ dmPolicy: "disabled" }));
    expect(await disabled.internals.checkDmAccess("+14155552671")).toEqual({
      allowed: false,
    });
  });

  it("gates autonomous replies on IMESSAGE_AUTO_REPLY", () => {
    const off = makeService(makeSettings());
    expect(off.internals.isAutoReplyEnabled()).toBe(false);

    const on = makeService(makeSettings(), {
      settings: { IMESSAGE_AUTO_REPLY: "true" },
    });
    expect(on.internals.isAutoReplyEnabled()).toBe(true);

    const passive = makeService(makeSettings(), {
      settings: {
        IMESSAGE_AUTO_REPLY: "true",
        ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "true",
      },
    });
    expect(passive.internals.isAutoReplyEnabled()).toBe(false);
  });
});
