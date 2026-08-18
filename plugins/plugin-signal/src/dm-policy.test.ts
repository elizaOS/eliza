/**
 * Unit tests for the Signal DM access gate: `dm.policy` resolution
 * (fail-closed default), the pairing handshake delegation, and the
 * `SignalService.handleIncomingMessage` wiring that enforces the advertised
 * policy before the agent turn runs. The PairingService is a duck-typed
 * double; the core `checkPairingAllowed` integration runs for real. No live
 * signal-cli — transport-adjacent internals are stubbed on the instance.
 */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { checkSignalDmAccess, DEFAULT_SIGNAL_DM_POLICY, resolveSignalDmPolicy } from "./dm-policy";
import { SignalService } from "./service";
import type { SignalMessage } from "./types";

function makePairingRuntime(
  options: { pairingAllowed?: boolean; signalSettings?: Record<string, unknown> } = {}
) {
  const pairingService = {
    isAllowed: vi.fn(async () => options.pairingAllowed ?? false),
    upsertRequest: vi.fn(async () => ({ code: "PAIRCODE1", created: true })),
    claimPairingReply: vi.fn(() => true),
  };
  const runtime = {
    agentId: "agent-1",
    getSetting: vi.fn(() => undefined),
    getService: vi.fn(() => pairingService),
    reportError: vi.fn(),
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    },
    character: { settings: { signal: options.signalSettings } },
  } as unknown as IAgentRuntime;
  return { runtime, pairingService };
}

describe("resolveSignalDmPolicy", () => {
  it("fails closed to pairing when the setting is absent or blank", () => {
    expect(DEFAULT_SIGNAL_DM_POLICY).toBe("pairing");
    expect(resolveSignalDmPolicy(undefined)).toBe("pairing");
    expect(resolveSignalDmPolicy(null)).toBe("pairing");
    expect(resolveSignalDmPolicy("")).toBe("pairing");
    expect(resolveSignalDmPolicy("   ")).toBe("pairing");
  });

  it("accepts the documented policies case-insensitively", () => {
    expect(resolveSignalDmPolicy("open")).toBe("open");
    expect(resolveSignalDmPolicy(" OPEN ")).toBe("open");
    expect(resolveSignalDmPolicy("Pairing")).toBe("pairing");
    expect(resolveSignalDmPolicy("ALLOWLIST")).toBe("allowlist");
    expect(resolveSignalDmPolicy("disabled")).toBe("disabled");
  });

  it("fails closed to the default on unrecognized values", () => {
    expect(resolveSignalDmPolicy("pariing")).toBe("pairing");
    expect(resolveSignalDmPolicy("open;drop")).toBe("pairing");
  });
});

describe("checkSignalDmAccess", () => {
  it("allows everyone under the explicit open policy", async () => {
    const { runtime, pairingService } = makePairingRuntime();

    const access = await checkSignalDmAccess(runtime, {
      policy: "open",
      senderId: "+15550001111",
    });

    expect(access).toEqual({ allowed: true });
    expect(pairingService.isAllowed).not.toHaveBeenCalled();
  });

  it("denies silently under the disabled policy", async () => {
    const { runtime, pairingService } = makePairingRuntime();

    const access = await checkSignalDmAccess(runtime, {
      policy: "disabled",
      senderId: "+15550001111",
      allowFrom: ["+15550001111"],
    });

    expect(access).toEqual({ allowed: false });
    expect(pairingService.isAllowed).not.toHaveBeenCalled();
  });

  it("admits a statically allowlisted sender under any non-disabled policy", async () => {
    const { runtime, pairingService } = makePairingRuntime();

    for (const policy of ["allowlist", "pairing"] as const) {
      const access = await checkSignalDmAccess(runtime, {
        policy,
        senderId: "+15550001111",
        allowFrom: ["+15550001111"],
      });
      expect(access).toEqual({ allowed: true });
    }
    expect(pairingService.upsertRequest).not.toHaveBeenCalled();
  });

  it("consults the core allowlist under the allowlist policy", async () => {
    const { runtime, pairingService } = makePairingRuntime({
      pairingAllowed: true,
    });

    const access = await checkSignalDmAccess(runtime, {
      policy: "allowlist",
      senderId: "+15550001111",
    });

    expect(access).toEqual({ allowed: true });
    expect(pairingService.isAllowed).toHaveBeenCalledWith("signal", "+15550001111");
    expect(pairingService.upsertRequest).not.toHaveBeenCalled();
  });

  it("holds an unknown sender under pairing and returns the one-time reply", async () => {
    const { runtime, pairingService } = makePairingRuntime();

    const access = await checkSignalDmAccess(runtime, {
      policy: "pairing",
      senderId: "+15550001111",
      username: "Ada",
    });

    expect(access.allowed).toBe(false);
    expect(access.replyMessage).toContain("Pairing code: PAIRCODE1");
    expect(pairingService.upsertRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "signal",
        senderId: "+15550001111",
        metadata: { username: "Ada" },
      })
    );
  });
});

describe("SignalService DM policy enforcement", () => {
  const inbound: SignalMessage = {
    timestamp: 1_700_000_000_000,
    sender: "+15550001111",
    senderUuid: undefined,
    groupId: undefined,
    message: "hello agent",
    attachments: [],
    quote: undefined,
    reaction: undefined,
    expiresInSeconds: undefined,
    viewOnce: false,
  };

  function makeService(options: {
    signalSettings?: Record<string, unknown>;
    pairingAllowed?: boolean;
  }) {
    const { runtime, pairingService } = makePairingRuntime(options);
    const memory = {
      id: "mem-1",
      content: { text: "hello agent" },
    } as unknown as Memory;
    const room = { id: "room-1" };
    const createMemory = vi.fn(async () => undefined);
    const emitEvent = vi.fn(async () => undefined);
    Object.assign(runtime, {
      createMemory,
      emitEvent,
      ensureConnection: vi.fn(async () => undefined),
      getRoom: vi.fn(async () => room),
    });
    const service = Object.create(SignalService.prototype) as SignalService;
    const processMessage = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async () => ({ timestamp: 1 }));
    Object.assign(service, {
      runtime,
      character: runtime.character,
      defaultAccountId: "default",
      settings: {
        shouldIgnoreGroupMessages: false,
        allowedGroups: undefined,
        blockedNumbers: undefined,
        autoReply: true,
        receiveMode: "manual",
      },
      getEntityId: vi.fn(() => "entity-1" as UUID),
      getRoomId: vi.fn(async () => "room-1" as UUID),
      getCachedContact: vi.fn(() => undefined),
      ensureRoomExists: vi.fn(async () => room),
      buildMemoryFromMessage: vi.fn(async () => memory),
      processMessage,
      sendMessage,
    });
    return { service, processMessage, sendMessage, createMemory, emitEvent, pairingService };
  }

  it("ingests but blocks an unpaired sender by default and replies with the pairing code", async () => {
    const { service, processMessage, sendMessage, createMemory, emitEvent } = makeService({});

    await (
      service as unknown as {
        handleIncomingMessage: (msg: SignalMessage, accountId?: string) => Promise<void>;
      }
    ).handleIncomingMessage(inbound);

    expect(createMemory).toHaveBeenCalledTimes(1);
    expect(processMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toBe("+15550001111");
    expect(String(sendMessage.mock.calls[0][1])).toContain("Pairing code: PAIRCODE1");
    expect(emitEvent).toHaveBeenCalledWith(
      "MESSAGE_RECEIVED",
      expect.objectContaining({ source: "signal" })
    );
  });

  it("routes a pairing-approved sender into the agent turn", async () => {
    const { service, processMessage, sendMessage, pairingService } = makeService({
      pairingAllowed: true,
    });

    await (
      service as unknown as {
        handleIncomingMessage: (msg: SignalMessage, accountId?: string) => Promise<void>;
      }
    ).handleIncomingMessage(inbound);

    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(pairingService.isAllowed).toHaveBeenCalledWith("signal", "+15550001111");
  });

  it("fails closed on an unrecognized dm.policy value", async () => {
    const { service, processMessage, sendMessage } = makeService({
      signalSettings: { dm: { policy: "pariing" } },
    });

    await (
      service as unknown as {
        handleIncomingMessage: (msg: SignalMessage, accountId?: string) => Promise<void>;
      }
    ).handleIncomingMessage(inbound);

    expect(processMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("blocks silently under dm.policy disabled and dm.enabled false", async () => {
    for (const signalSettings of [{ dm: { policy: "disabled" } }, { dm: { enabled: false } }]) {
      const { service, processMessage, sendMessage, pairingService } = makeService({
        signalSettings,
      });

      await (
        service as unknown as {
          handleIncomingMessage: (msg: SignalMessage, accountId?: string) => Promise<void>;
        }
      ).handleIncomingMessage(inbound);

      expect(processMessage).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(pairingService.isAllowed).not.toHaveBeenCalled();
    }
  });

  it("admits a statically allowlisted sender without a pairing round-trip", async () => {
    const { service, processMessage, sendMessage, pairingService } = makeService({
      signalSettings: { dm: { allowFrom: ["+15550001111"] } },
    });

    await (
      service as unknown as {
        handleIncomingMessage: (msg: SignalMessage, accountId?: string) => Promise<void>;
      }
    ).handleIncomingMessage(inbound);

    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(pairingService.upsertRequest).not.toHaveBeenCalled();
  });

  it("honors flat dmPolicy and allowFrom at the base and account compatibility surfaces", async () => {
    for (const signalSettings of [
      { dmPolicy: "open" },
      { dmPolicy: "allowlist", allowFrom: ["+15550001111"] },
      { accounts: { default: { dmPolicy: "open" } } },
      {
        dmPolicy: "disabled",
        accounts: {
          default: { dmPolicy: "allowlist", allowFrom: ["+15550001111"] },
        },
      },
    ]) {
      const { service, processMessage, pairingService } = makeService({
        signalSettings,
      });

      await (
        service as unknown as {
          handleIncomingMessage: (msg: SignalMessage, accountId?: string) => Promise<void>;
        }
      ).handleIncomingMessage(inbound);

      expect(processMessage).toHaveBeenCalledTimes(1);
      expect(pairingService.upsertRequest).not.toHaveBeenCalled();
    }
  });

  it("does not gate group messages", async () => {
    const { service, processMessage, pairingService } = makeService({});

    await (
      service as unknown as {
        handleIncomingMessage: (msg: SignalMessage, accountId?: string) => Promise<void>;
      }
    ).handleIncomingMessage({ ...inbound, groupId: "group-1" });

    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(pairingService.isAllowed).not.toHaveBeenCalled();
  });
});
