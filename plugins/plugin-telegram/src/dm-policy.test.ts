/**
 * Unit tests for the Telegram DM access gate: `TELEGRAM_DM_POLICY` resolution
 * (fail-closed default), the pairing handshake delegation shared by the full
 * bot service and the standalone poller, and the `TelegramService`
 * authorization middleware wiring. The PairingService is a duck-typed double;
 * the core `checkPairingAllowed` integration runs for real.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  checkTelegramDmAccess,
  DEFAULT_TELEGRAM_DM_POLICY,
  resolveTelegramDmPolicy,
} from "./dm-policy";
import { TelegramService } from "./service";

function makePairingRuntime(
  options: {
    pairingAllowed?: boolean;
    pairingService?: boolean;
    created?: boolean;
    code?: string;
    claim?: boolean;
  } = {},
) {
  const pairingService = {
    isAllowed: vi.fn(async () => options.pairingAllowed ?? false),
    upsertRequest: vi.fn(async () => ({
      code: options.code ?? "PAIRCODE1",
      created: options.created ?? true,
    })),
    claimPairingReply: vi.fn(() => options.claim ?? true),
  };
  const runtime = {
    agentId: "agent-1",
    getSetting: vi.fn(() => undefined),
    getService: vi.fn(() =>
      options.pairingService === false ? null : pairingService,
    ),
    reportError: vi.fn(),
    logger: { warn: vi.fn() },
  } as unknown as IAgentRuntime;
  return { runtime, pairingService };
}

describe("resolveTelegramDmPolicy", () => {
  it("fails closed to pairing when the setting is absent or blank", () => {
    expect(DEFAULT_TELEGRAM_DM_POLICY).toBe("pairing");
    expect(resolveTelegramDmPolicy(undefined)).toBe("pairing");
    expect(resolveTelegramDmPolicy(null)).toBe("pairing");
    expect(resolveTelegramDmPolicy("")).toBe("pairing");
    expect(resolveTelegramDmPolicy("   ")).toBe("pairing");
  });

  it("accepts the documented policies case-insensitively", () => {
    expect(resolveTelegramDmPolicy("open")).toBe("open");
    expect(resolveTelegramDmPolicy(" OPEN ")).toBe("open");
    expect(resolveTelegramDmPolicy("Pairing")).toBe("pairing");
    expect(resolveTelegramDmPolicy("ALLOWLIST")).toBe("allowlist");
    expect(resolveTelegramDmPolicy("disabled")).toBe("disabled");
  });

  it("fails closed to the default on unrecognized values", () => {
    expect(resolveTelegramDmPolicy("bogus")).toBe("pairing");
    expect(resolveTelegramDmPolicy("open;drop")).toBe("pairing");
  });
});

describe("checkTelegramDmAccess", () => {
  it("allows everyone under the explicit open policy", async () => {
    const { runtime, pairingService } = makePairingRuntime();

    const access = await checkTelegramDmAccess(runtime, {
      policy: "open",
      senderId: "42",
    });

    expect(access).toEqual({ allowed: true });
    expect(pairingService.isAllowed).not.toHaveBeenCalled();
  });

  it("denies silently under disabled and allowlist policies", async () => {
    const { runtime, pairingService } = makePairingRuntime();

    for (const policy of ["disabled", "allowlist"] as const) {
      const access = await checkTelegramDmAccess(runtime, {
        policy,
        senderId: "42",
      });
      expect(access).toEqual({ allowed: false });
    }
    expect(pairingService.isAllowed).not.toHaveBeenCalled();
  });

  it("admits a pairing-approved sender without a reply", async () => {
    const { runtime, pairingService } = makePairingRuntime({
      pairingAllowed: true,
    });

    const access = await checkTelegramDmAccess(runtime, {
      policy: "pairing",
      senderId: "42",
    });

    expect(access).toEqual({ allowed: true });
    expect(pairingService.isAllowed).toHaveBeenCalledWith("telegram", "42");
    expect(pairingService.upsertRequest).not.toHaveBeenCalled();
  });

  it("holds an unknown sender and returns the one-time pairing reply", async () => {
    const { runtime, pairingService } = makePairingRuntime();

    const access = await checkTelegramDmAccess(runtime, {
      policy: "pairing",
      senderId: "42",
      username: "ada",
    });

    expect(access.allowed).toBe(false);
    expect(access.replyMessage).toContain("Pairing code: PAIRCODE1");
    expect(pairingService.upsertRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        senderId: "42",
        metadata: { username: "ada" },
      }),
    );
  });

  it("suppresses the reply when the sender was already answered", async () => {
    const { runtime } = makePairingRuntime({ claim: false });

    const access = await checkTelegramDmAccess(runtime, {
      policy: "pairing",
      senderId: "42",
    });

    expect(access).toEqual({ allowed: false });
  });

  it("holds the sender silently when the pending queue is full", async () => {
    const { runtime } = makePairingRuntime({ code: "", created: false });

    const access = await checkTelegramDmAccess(runtime, {
      policy: "pairing",
      senderId: "42",
    });

    expect(access).toEqual({ allowed: false });
  });

  it("fails closed when the PairingService is not registered", async () => {
    const { runtime } = makePairingRuntime({ pairingService: false });

    const access = await checkTelegramDmAccess(runtime, {
      policy: "pairing",
      senderId: "42",
    });

    expect(access.allowed).toBe(false);
    expect(access.replyMessage).toBe(
      "Access pairing is temporarily unavailable.",
    );
    expect(runtime.reportError).toHaveBeenCalled();
  });
});

describe("TelegramService authorization middleware DM gate", () => {
  type Middleware = (
    ctx: unknown,
    next: () => Promise<void>,
    accountId?: string,
  ) => Promise<void>;

  function makeService(
    settings: Record<string, unknown>,
    options: Parameters<typeof makePairingRuntime>[0] = {},
  ) {
    const { runtime, pairingService } = makePairingRuntime(options);
    runtime.getSetting = vi.fn(
      (key: string) => settings[key],
    ) as IAgentRuntime["getSetting"];
    const service = Object.assign(
      Object.create(TelegramService.prototype) as TelegramService,
      { runtime, defaultAccountId: "default" },
    );
    const middleware = (
      service as unknown as { authorizationMiddleware: Middleware }
    ).authorizationMiddleware.bind(service);
    return { middleware, pairingService };
  }

  function dmContext(reply = vi.fn(async () => ({}))) {
    return {
      chat: { id: 111, type: "private" },
      from: { id: 42, username: "ada" },
      reply,
    };
  }

  it("denies an unconfigured DM by default and replies with the pairing code", async () => {
    const { middleware } = makeService({});
    const reply = vi.fn(async () => ({}));
    const next = vi.fn(async () => undefined);

    await middleware(dmContext(reply), next);

    expect(next).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0]).toContain("Pairing code: PAIRCODE1");
  });

  it("admits a configured DM chat from the allowlist without pairing", async () => {
    const { middleware, pairingService } = makeService({
      TELEGRAM_ALLOWED_CHATS: '["111"]',
    });
    const reply = vi.fn(async () => ({}));
    const next = vi.fn(async () => undefined);

    await middleware(dmContext(reply), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
    expect(pairingService.isAllowed).not.toHaveBeenCalled();
  });

  it("denies a DM chat missing from the allowlist without a pairing reply", async () => {
    const { middleware } = makeService({
      TELEGRAM_ALLOWED_CHATS: '["-100999"]',
    });
    const reply = vi.fn(async () => ({}));
    const next = vi.fn(async () => undefined);

    await middleware(dmContext(reply), next);

    expect(next).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it("keeps group chats open when nothing is configured", async () => {
    const { middleware } = makeService({});
    const next = vi.fn(async () => undefined);
    const ctx = {
      chat: { id: -100999, type: "supergroup" },
      from: { id: 42, username: "ada" },
      reply: vi.fn(async () => ({})),
    };

    await middleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("restores the legacy default-open DM behavior only under the explicit open policy", async () => {
    const { middleware } = makeService({ TELEGRAM_DM_POLICY: "open" });
    const next = vi.fn(async () => undefined);

    await middleware(dmContext(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("denies a private chat with no stable sender id", async () => {
    const { middleware } = makeService({});
    const reply = vi.fn(async () => ({}));
    const next = vi.fn(async () => undefined);
    const ctx = { chat: { id: 111, type: "private" }, reply };

    await middleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });
});
