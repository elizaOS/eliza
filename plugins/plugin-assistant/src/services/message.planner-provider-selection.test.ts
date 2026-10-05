/**
 * Unit tests for selectV5PlannerStateProviderNames, the v5 planner
 * state-provider selection (#13203): a provider's FULL declared contextGate
 * (anyOf/allOf/noneOf) must gate its planner inclusion, undeclared providers
 * resolve through the provider-context catalog, and diagnostic records load
 * only for their system context. Deterministic fake
 * runtime with literal provider fixtures — no live model or database.
 */

import type {
  AgentContext,
  IAgentRuntime,
  Memory,
  Provider,
  UUID,
} from "@elizaos/core";
import { recentErrorsProvider } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { selectV5PlannerStateProviderNames } from "./message.ts";

function provider(overrides: Partial<Provider> & { name: string }): Provider {
  return {
    description: "test provider",
    get: async () => ({ text: "" }),
    ...overrides,
  } as Provider;
}

function makeRuntime(providers: Provider[]): IAgentRuntime {
  // `getSetting` is a required IAgentRuntime collaborator: ambient-turn
  // selection reads the response-bypass channel/source settings before it can
  // decide whether a turn is ambient. The fixture answers "nothing configured"
  // so selection exercises the built-in bypass set only.
  return {
    providers,
    getSetting: () => undefined,
  } as unknown as IAgentRuntime;
}

function msg(): Memory {
  return {
    id: "00000000-0000-0000-0000-0000000000b2" as UUID,
    entityId: "00000000-0000-0000-0000-0000000000c2" as UUID,
    roomId: "00000000-0000-0000-0000-0000000000d2" as UUID,
    content: { text: "plan it" },
  } as unknown as Memory;
}

function select(
  providers: Provider[],
  selectedContexts: AgentContext[],
): string[] {
  return selectV5PlannerStateProviderNames({
    runtime: makeRuntime(providers),
    message: msg(),
    selectedContexts,
    userRoles: ["MEMBER"],
  });
}

describe("selectV5PlannerStateProviderNames — declared contextGate honored (#13203)", () => {
  const walletGated = provider({
    name: "WALLET_GATED_SIGNAL",
    contextGate: { anyOf: ["wallet"] },
  });

  it("selects a gate-only anyOf provider on its gate turn", () => {
    expect(select([walletGated], ["wallet"])).toContain("WALLET_GATED_SIGNAL");
  });

  it("excludes a gate-only anyOf provider on unrelated turns", () => {
    expect(select([walletGated], ["documents"])).not.toContain(
      "WALLET_GATED_SIGNAL",
    );
    expect(select([walletGated], [])).not.toContain("WALLET_GATED_SIGNAL");
  });

  it("honors noneOf: an active denied context excludes the provider", () => {
    const notInCode = provider({
      name: "NOT_IN_CODE",
      contextGate: { anyOf: ["general"], noneOf: ["code"] },
    });
    expect(select([notInCode], ["general"])).toContain("NOT_IN_CODE");
    expect(select([notInCode], ["general", "code"])).not.toContain(
      "NOT_IN_CODE",
    );
  });

  it("routes undeclared orchestrator providers via the catalog to code/automation turns", () => {
    const availableAgents = provider({
      name: "AVAILABLE_AGENTS",
      dynamic: true,
    });
    const activeSubAgents = provider({
      name: "ACTIVE_SUB_AGENTS",
      dynamic: true,
    });
    const onCodeTurn = select([availableAgents, activeSubAgents], ["code"]);
    expect(onCodeTurn).toContain("AVAILABLE_AGENTS");
    expect(onCodeTurn).toContain("ACTIVE_SUB_AGENTS");

    const onGeneralTurn = select(
      [availableAgents, activeSubAgents],
      ["general"],
    );
    expect(onGeneralTurn).not.toContain("AVAILABLE_AGENTS");
    expect(onGeneralTurn).not.toContain("ACTIVE_SUB_AGENTS");
  });

  it("keeps declared-contexts providers on their declared routing (hot-path parity)", () => {
    const declared = provider({
      name: "DECLARED_SIGNAL",
      contexts: ["documents"],
    });
    expect(select([declared], ["documents"])).toContain("DECLARED_SIGNAL");
    expect(select([declared], ["wallet"])).not.toContain("DECLARED_SIGNAL");
  });

  it("keeps the legacy PROVIDERS catalog out of v5 planner composition", () => {
    const catalog = provider({
      name: "PROVIDERS",
      contextGate: { anyOf: ["general"] },
    });
    const selected = select([catalog], ["general"]);

    expect(selected).not.toContain("PROVIDERS");
  });

  it("keeps an undeclared, uncataloged plugin provider on narrow turns (#13204 follow-up)", () => {
    // TWITTER_IDENTITY shape: a plugin provider with no contexts, no
    // contextGate, and no catalog entry. Hosts that bypass the wrapped
    // registration path hand the selection exactly this object; the pre-#13203
    // filter included it on every turn, and undeclared must keep that safe
    // default — only a declared gate/contexts or catalog entry may gate it out.
    const undeclared = provider({ name: "TWITTER_IDENTITY", dynamic: true });
    expect(select([undeclared], ["messaging"])).toContain("TWITTER_IDENTITY");
    expect(select([undeclared], ["general"])).toContain("TWITTER_IDENTITY");
    expect(select([undeclared], [])).toContain("TWITTER_IDENTITY");
  });

  it("keeps the registration-materialized general lean for providers that carry it (#13204 follow-up)", () => {
    // The wrapped registration path materializes the undeclared class to
    // ["general"] (plugin-lifecycle); those providers stay off narrow turns.
    const materialized = provider({
      name: "NOISY_PLUGIN_SIGNAL",
      contexts: ["general"],
    });
    expect(select([materialized], ["wallet"])).not.toContain(
      "NOISY_PLUGIN_SIGNAL",
    );
    expect(select([materialized], ["general"])).toContain(
      "NOISY_PLUGIN_SIGNAL",
    );
  });

  it("loads diagnostics for system work, not unrelated planner turns", () => {
    expect(select([recentErrorsProvider], ["system"])).toContain(
      "RECENT_ERRORS",
    );
    expect(select([recentErrorsProvider], ["code"])).not.toContain(
      "RECENT_ERRORS",
    );
    expect(select([recentErrorsProvider], [])).not.toContain("RECENT_ERRORS");
  });
});

/** Ambient routing cannot reintroduce diagnostics outside their declared domain. */
describe("selectV5PlannerStateProviderNames — ambient-turn exclusions", () => {
  function groupMsg(content: Record<string, unknown>): Memory {
    return {
      id: "00000000-0000-0000-0000-0000000000b3" as UUID,
      entityId: "00000000-0000-0000-0000-0000000000c3" as UUID,
      roomId: "00000000-0000-0000-0000-0000000000d3" as UUID,
      content: { text: "anyone seen the game last night?", ...content },
    } as unknown as Memory;
  }

  function selectFor(content: Record<string, unknown>): string[] {
    return selectV5PlannerStateProviderNames({
      runtime: makeRuntime([recentErrorsProvider]),
      message: groupMsg(content),
      selectedContexts: ["general"],
      userRoles: ["MEMBER"],
    });
  }

  it("excludes RECENT_ERRORS from the planner recompose of an unaddressed group turn", () => {
    expect(selectFor({ channelType: "GROUP" })).not.toContain("RECENT_ERRORS");
  });

  it("does not add system diagnostics merely because a group turn addresses the agent", () => {
    expect(
      selectFor({
        channelType: "GROUP",
        mentionContext: { isMention: true, isReply: false, isThread: false },
      }),
    ).not.toContain("RECENT_ERRORS");
  });

  it("keeps diagnostics out of ordinary private and unknown-channel conversation", () => {
    expect(selectFor({ channelType: "DM" })).not.toContain("RECENT_ERRORS");
    expect(selectFor({ channelType: "VOICE_DM" })).not.toContain(
      "RECENT_ERRORS",
    );
    expect(selectFor({})).not.toContain("RECENT_ERRORS");
  });

  it("keeps the Stage-1-only exclusions out of scope: the planner still re-adds ENTITIES", () => {
    // Ambient exclusions are turn-scoped, not stage-scoped — the planner
    // legitimately restores the Stage-1-only ENTITIES/DOCUMENTS set.
    const names = selectFor({ channelType: "GROUP" });
    expect(names).toContain("ENTITIES");
  });
});
