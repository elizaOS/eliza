/**
 * Unit tests for the X DM access gate: `TWITTER_DM_POLICY` resolution
 * (fail-closed default) and the pairing handshake delegation used by the DM
 * polling loop. The PairingService is a duck-typed double; the core
 * `checkPairingAllowed` integration runs for real.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  checkTwitterDmAccess,
  DEFAULT_TWITTER_DM_POLICY,
  resolveTwitterDmPolicy,
} from "./dm-policy";

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

describe("resolveTwitterDmPolicy", () => {
  it("fails closed to pairing when the setting is absent or blank", () => {
    expect(DEFAULT_TWITTER_DM_POLICY).toBe("pairing");
    expect(resolveTwitterDmPolicy(undefined)).toBe("pairing");
    expect(resolveTwitterDmPolicy(null)).toBe("pairing");
    expect(resolveTwitterDmPolicy("")).toBe("pairing");
    expect(resolveTwitterDmPolicy("   ")).toBe("pairing");
  });

  it("accepts the documented policies case-insensitively", () => {
    expect(resolveTwitterDmPolicy("open")).toBe("open");
    expect(resolveTwitterDmPolicy(" OPEN ")).toBe("open");
    expect(resolveTwitterDmPolicy("Pairing")).toBe("pairing");
    expect(resolveTwitterDmPolicy("ALLOWLIST")).toBe("allowlist");
    expect(resolveTwitterDmPolicy("disabled")).toBe("disabled");
  });

  it("fails closed to the default on unrecognized values", () => {
    expect(resolveTwitterDmPolicy("bogus")).toBe("pairing");
    expect(resolveTwitterDmPolicy("open;drop")).toBe("pairing");
  });
});

describe("checkTwitterDmAccess", () => {
  it("allows everyone under the explicit open policy", async () => {
    const { runtime, pairingService } = makePairingRuntime();

    const access = await checkTwitterDmAccess(runtime, {
      policy: "open",
      senderId: "42",
    });

    expect(access).toEqual({ allowed: true });
    expect(pairingService.isAllowed).not.toHaveBeenCalled();
  });

  it("denies silently under the disabled policy", async () => {
    const { runtime, pairingService } = makePairingRuntime();

    const access = await checkTwitterDmAccess(runtime, {
      policy: "disabled",
      senderId: "42",
    });
    expect(access).toEqual({ allowed: false });
    expect(pairingService.isAllowed).not.toHaveBeenCalled();
  });

  it("consults the core allowlist without issuing a pairing code", async () => {
    const { runtime, pairingService } = makePairingRuntime({
      pairingAllowed: true,
    });

    const access = await checkTwitterDmAccess(runtime, {
      policy: "allowlist",
      senderId: "42",
    });

    expect(access).toEqual({ allowed: true });
    expect(pairingService.isAllowed).toHaveBeenCalledWith("x", "42");
    expect(pairingService.upsertRequest).not.toHaveBeenCalled();
  });

  it("admits a pairing-approved sender without a reply", async () => {
    const { runtime, pairingService } = makePairingRuntime({
      pairingAllowed: true,
    });

    const access = await checkTwitterDmAccess(runtime, {
      policy: "pairing",
      senderId: "42",
    });

    expect(access).toEqual({ allowed: true });
    expect(pairingService.isAllowed).toHaveBeenCalledWith("x", "42");
    expect(pairingService.upsertRequest).not.toHaveBeenCalled();
  });

  it("holds an unknown sender and returns the one-time pairing reply", async () => {
    const { runtime, pairingService } = makePairingRuntime();

    const access = await checkTwitterDmAccess(runtime, {
      policy: "pairing",
      senderId: "42",
      username: "ada",
    });

    expect(access.allowed).toBe(false);
    expect(access.replyMessage).toContain("Pairing code: PAIRCODE1");
    expect(pairingService.upsertRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "x",
        senderId: "42",
        metadata: { username: "ada" },
      }),
    );
  });

  it("suppresses the reply when the sender was already answered", async () => {
    const { runtime } = makePairingRuntime({ claim: false });

    const access = await checkTwitterDmAccess(runtime, {
      policy: "pairing",
      senderId: "42",
    });

    expect(access).toEqual({ allowed: false });
  });

  it("fails closed when the PairingService is not registered", async () => {
    const { runtime } = makePairingRuntime({ pairingService: false });

    const access = await checkTwitterDmAccess(runtime, {
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
