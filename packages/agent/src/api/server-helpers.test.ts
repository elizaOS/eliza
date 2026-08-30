/**
 * Unit tests for the API server-helpers conversation-greeting persona
 * selection and avatar-to-preset mirroring. Deterministic — a mocked
 * `Math.random` sweep drives the real helpers with a cast-fake runtime,
 * no live model. Blocked-object-key sanitization is covered in
 * `blocked-object-keys.test.ts`.
 */
import type { AgentRuntime } from "@elizaos/core";
import { resolveStylePresetById } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildWalletActionNotExecutedReply,
  resolveConversationGreetingText,
  resolveMirroredAvatarPresetId,
} from "./server-helpers";
import {
  beginAgentWalletAddressCacheSession,
  cacheAgentWalletAddresses,
} from "./wallet.ts";

describe("resolveConversationGreetingText persona selection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeRuntime = (name: string) =>
    ({ character: { name, postExamples: [] } }) as unknown as AgentRuntime;

  // The greeting is picked at random from the resolved preset's postExamples.
  // Sweep Math.random across every index so the full reachable greeting set is
  // observable — Eliza and Chen share a couple of lines, so a single draw could
  // mask a persona swap.
  const collectGreetings = (
    runtimeName: string,
    uiConfig: { presetId?: string; avatarIndex?: number },
  ): Set<string> => {
    const greetings = new Set<string>();
    for (let step = 0; step < 32; step += 1) {
      vi.spyOn(Math, "random").mockReturnValue(step / 32);
      greetings.add(
        resolveConversationGreetingText(makeRuntime(runtimeName), "en", {
          assistant: { name: runtimeName },
          ...uiConfig,
        }),
      );
      vi.restoreAllMocks();
    }
    return greetings;
  };

  it("greets a default-Eliza config (presetId eliza + shared avatarIndex) as Eliza, not Chen", () => {
    const eliza = resolveStylePresetById("eliza");
    expect(eliza).toBeDefined();
    const greetings = collectGreetings("Eliza", {
      presetId: "eliza",
      avatarIndex: eliza?.avatarIndex,
    });
    expect(greetings).toEqual(new Set(eliza?.postExamples));
  });

  it("keeps Chen's greeting for a Chen config sharing the same avatarIndex", () => {
    const chen = resolveStylePresetById("chen");
    expect(chen).toBeDefined();
    const greetings = collectGreetings("Chen", {
      presetId: "chen",
      avatarIndex: chen?.avatarIndex,
    });
    expect(greetings).toEqual(new Set(chen?.postExamples));
  });
});

describe("resolveMirroredAvatarPresetId", () => {
  it("keeps a persisted presetId that is consistent with the selected avatar", () => {
    expect(resolveMirroredAvatarPresetId("chen", 1)).toBe("chen");
    expect(resolveMirroredAvatarPresetId("eliza", 1)).toBe("eliza");
  });

  it("derives the default persona for an unnamed or inconsistent config", () => {
    expect(resolveMirroredAvatarPresetId(undefined, 1)).toBe("eliza");
    // jin renders asset 2 — selecting avatar 1 means the persisted id no
    // longer matches, so the id is re-derived from the index (default-first).
    expect(resolveMirroredAvatarPresetId("jin", 1)).toBe("eliza");
    expect(resolveMirroredAvatarPresetId("chen", 2)).toBe("jin");
  });
});

describe("wallet reply runtime isolation", () => {
  const agentA = "00000000-0000-0000-0000-0000000000aa";
  const agentB = "00000000-0000-0000-0000-0000000000bb";
  const addressA = "0x1111111111111111111111111111111111111111";
  const addressB = "0x2222222222222222222222222222222222222222";
  const shadowingEnvKeys = [
    "EVM_PRIVATE_KEY",
    "STEWARD_EVM_ADDRESS",
    "ELIZA_MANAGED_EVM_ADDRESS",
    "WALLET_SOURCE_EVM",
  ] as const;
  let originalEnv: Record<string, string | undefined>;
  let agentASession: ReturnType<typeof beginAgentWalletAddressCacheSession>;
  let agentBSession: ReturnType<typeof beginAgentWalletAddressCacheSession>;

  const runtimeFor = (agentId: string) =>
    ({ agentId, plugins: [] }) as unknown as AgentRuntime;

  beforeEach(() => {
    originalEnv = Object.fromEntries(
      shadowingEnvKeys.map((key) => [key, process.env[key]]),
    );
    for (const key of shadowingEnvKeys) delete process.env[key];
    agentASession = beginAgentWalletAddressCacheSession(agentA);
    agentBSession = beginAgentWalletAddressCacheSession(agentB);
  });

  afterEach(() => {
    beginAgentWalletAddressCacheSession(agentA);
    beginAgentWalletAddressCacheSession(agentB);
    for (const key of shadowingEnvKeys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("uses the requesting runtime's cached address in wallet guidance", () => {
    cacheAgentWalletAddresses(agentASession, {
      evmAddress: addressA,
      solanaAddress: null,
    });
    cacheAgentWalletAddresses(agentBSession, {
      evmAddress: addressB,
      solanaAddress: null,
    });

    const replyA = buildWalletActionNotExecutedReply(
      runtimeFor(agentA),
      "send ETH",
    );
    const replyB = buildWalletActionNotExecutedReply(
      runtimeFor(agentB),
      "send ETH",
    );

    expect(replyA).toContain(addressA);
    expect(replyA).not.toContain(addressB);
    expect(replyB).toContain(addressB);
    expect(replyB).not.toContain(addressA);
  });
});
