/**
 * Pins the agent-scoped config types barrel (`types.agents.ts`). The module is
 * a live `export *` of `@elizaos/shared` so consumers can import AgentConfig
 * and related shapes from this local path without depending on shared directly.
 * Evaluating that star-export loads the entire shared runtime graph, so this
 * suite pins the re-export from the source file and drives the documented
 * AgentConfig / AgentsConfig / AgentBinding contracts: empty vs single vs
 * overflow collections, insertion order, default-flag ties, and missing-id
 * removal.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  AgentBinding as SharedAgentBinding,
  AgentConfig as SharedAgentConfig,
  AgentDefaultsConfig as SharedAgentDefaultsConfig,
  AgentModelConfig as SharedAgentModelConfig,
  AgentsConfig as SharedAgentsConfig,
} from "@elizaos/shared";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AgentBinding,
  AgentConfig,
  AgentDefaultsConfig,
  AgentModelConfig,
  AgentsConfig,
} from "./types.agents.ts";

const SANDBOX_MODES: NonNullable<
  NonNullable<AgentConfig["sandbox"]>["mode"]
>[] = ["off", "non-main", "all"];

const WORKSPACE_ACCESS: NonNullable<
  NonNullable<AgentConfig["sandbox"]>["workspaceAccess"]
>[] = ["none", "ro", "rw"];

const SESSION_TOOLS_VISIBILITY: NonNullable<
  NonNullable<AgentConfig["sandbox"]>["sessionToolsVisibility"]
>[] = ["spawned", "all"];

const SANDBOX_SCOPES: NonNullable<
  NonNullable<AgentConfig["sandbox"]>["scope"]
>[] = ["session", "agent", "shared"];

const PEER_KINDS: NonNullable<
  NonNullable<AgentBinding["match"]["peer"]>["kind"]
>[] = ["dm", "group", "channel"];

function agent(id: string, extras: Omit<AgentConfig, "id"> = {}): AgentConfig {
  return { id, ...extras };
}

function agentsConfig(list?: AgentConfig[]): AgentsConfig {
  return list === undefined ? {} : { list };
}

function agentById(config: AgentsConfig, id: string): AgentConfig | undefined {
  return config.list?.find((entry) => entry.id === id);
}

function removeAgent(config: AgentsConfig, id: string): AgentConfig[] {
  return (config.list ?? []).filter((entry) => entry.id !== id);
}

function defaultMarked(config: AgentsConfig): AgentConfig[] {
  return (config.list ?? []).filter((entry) => entry.default === true);
}

/**
 * Documented skill allowlist: omit = all skills; empty = none.
 */
function skillPolicy(entry: AgentConfig): "all" | "none" | string[] {
  if (entry.skills === undefined) return "all";
  if (entry.skills.length === 0) return "none";
  return entry.skills;
}

/**
 * Documented legacy alias: perSession true → "session", false → "shared",
 * ignored when `scope` is set.
 */
function resolvedSandboxScope(
  sandbox: NonNullable<AgentConfig["sandbox"]>,
): NonNullable<NonNullable<AgentConfig["sandbox"]>["scope"]> | undefined {
  if (sandbox.scope !== undefined) return sandbox.scope;
  if (sandbox.perSession === true) return "session";
  if (sandbox.perSession === false) return "shared";
  return undefined;
}

function bindingFor(
  agentId: string,
  channel: string,
  extras: Omit<AgentBinding["match"], "channel"> = {},
): AgentBinding {
  return { agentId, match: { channel, ...extras } };
}

function bindingMatches(
  binding: AgentBinding,
  candidate: AgentBinding["match"],
): boolean {
  if (binding.match.channel !== candidate.channel) return false;
  if (
    binding.match.accountId !== undefined &&
    binding.match.accountId !== candidate.accountId
  ) {
    return false;
  }
  if (
    binding.match.guildId !== undefined &&
    binding.match.guildId !== candidate.guildId
  ) {
    return false;
  }
  if (
    binding.match.teamId !== undefined &&
    binding.match.teamId !== candidate.teamId
  ) {
    return false;
  }
  if (binding.match.peer) {
    if (
      candidate.peer?.kind !== binding.match.peer.kind ||
      candidate.peer.id !== binding.match.peer.id
    ) {
      return false;
    }
  }
  return true;
}

describe("types.agents barrel", () => {
  it("is a live export-star of @elizaos/shared, not a types-only re-export", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./types.agents.ts", import.meta.url)),
      "utf8",
    );

    expect(source).toContain('export * from "@elizaos/shared"');
    expect(source).not.toMatch(
      /export\s+type\s+\*\s+from\s+"@elizaos\/shared"/,
    );
    expect(source).toMatch(/AgentConfig/);
  });

  it("re-exports the shared AgentConfig / AgentsConfig / AgentBinding contracts", () => {
    expectTypeOf<AgentConfig>().toEqualTypeOf<SharedAgentConfig>();
    expectTypeOf<AgentsConfig>().toEqualTypeOf<SharedAgentsConfig>();
    expectTypeOf<AgentBinding>().toEqualTypeOf<SharedAgentBinding>();
    expectTypeOf<AgentModelConfig>().toEqualTypeOf<SharedAgentModelConfig>();
    expectTypeOf<AgentDefaultsConfig>().toEqualTypeOf<SharedAgentDefaultsConfig>();
  });
});

describe("AgentConfig", () => {
  it("requires id and treats every other field as optional", () => {
    expectTypeOf<AgentConfig>().toMatchTypeOf<{ id: string }>();
    expectTypeOf({ id: "eliza" }).toMatchTypeOf<AgentConfig>();
    expectTypeOf({}).not.toMatchTypeOf<AgentConfig>();
    expectTypeOf({ name: "Eliza" }).not.toMatchTypeOf<AgentConfig>();

    const minimal = agent("eliza");
    expect(minimal.id).toBe("eliza");
    expect(minimal.default).toBeUndefined();
    expect(minimal.skills).toBeUndefined();
    expect(minimal.sandbox).toBeUndefined();
  });

  it("accepts a string model or a primary/fallbacks object", () => {
    const asString: AgentModelConfig = "openai/gpt-4o";
    const asObject: AgentModelConfig = {
      primary: "openai/gpt-4o",
      fallbacks: ["anthropic/claude-sonnet-4"],
    };
    const emptyObject: AgentModelConfig = {};

    expect(typeof asString).toBe("string");
    expect(asObject.primary).toBe("openai/gpt-4o");
    expect(asObject.fallbacks).toEqual(["anthropic/claude-sonnet-4"]);
    expect(emptyObject.primary).toBeUndefined();
    expect(emptyObject.fallbacks).toBeUndefined();

    const withString = agent("a", { model: asString });
    const withObject = agent("b", { model: asObject });
    expect(withString.model).toBe("openai/gpt-4o");
    expect(withObject.model).toEqual(asObject);
  });

  it("treats omitted skills as all-skills and an empty list as none", () => {
    expect(skillPolicy(agent("open"))).toBe("all");
    expect(skillPolicy(agent("closed", { skills: [] }))).toBe("none");
    expect(skillPolicy(agent("filtered", { skills: ["web", "git"] }))).toEqual([
      "web",
      "git",
    ]);
  });

  it("accepts every sandbox discriminant and the perSession legacy alias", () => {
    for (const mode of SANDBOX_MODES) {
      expect(agent("s", { sandbox: { mode } }).sandbox?.mode).toBe(mode);
    }
    for (const workspaceAccess of WORKSPACE_ACCESS) {
      expect(
        agent("s", { sandbox: { workspaceAccess } }).sandbox?.workspaceAccess,
      ).toBe(workspaceAccess);
    }
    for (const sessionToolsVisibility of SESSION_TOOLS_VISIBILITY) {
      expect(
        agent("s", { sandbox: { sessionToolsVisibility } }).sandbox
          ?.sessionToolsVisibility,
      ).toBe(sessionToolsVisibility);
    }
    for (const scope of SANDBOX_SCOPES) {
      expect(agent("s", { sandbox: { scope } }).sandbox?.scope).toBe(scope);
    }

    expect(resolvedSandboxScope({ perSession: true })).toBe("session");
    expect(resolvedSandboxScope({ perSession: false })).toBe("shared");
    expect(resolvedSandboxScope({ scope: "agent", perSession: true })).toBe(
      "agent",
    );
    expect(resolvedSandboxScope({})).toBeUndefined();
  });

  it("accepts knowledge as a path string, path object, or directory object", () => {
    const sources: NonNullable<AgentConfig["knowledge"]> = [
      "notes.md",
      { path: "docs/readme.md", shared: true },
      { directory: "knowledge", shared: false },
    ];
    const configured = agent("k", { knowledge: sources });
    expect(configured.knowledge).toEqual(sources);
    expect(configured.knowledge).toHaveLength(3);
  });

  it("accepts subagent allowlists including the any-agent wildcard", () => {
    const specific = agent("parent", {
      subagents: { allowAgents: ["helper"], model: "openai/gpt-4o-mini" },
    });
    const anyAgent = agent("parent", {
      subagents: { allowAgents: ["*"], model: { primary: "openai/gpt-4o" } },
    });
    expect(specific.subagents?.allowAgents).toEqual(["helper"]);
    expect(anyAgent.subagents?.allowAgents).toEqual(["*"]);
    expect(anyAgent.subagents?.model).toEqual({ primary: "openai/gpt-4o" });
  });
});

describe("AgentsConfig list", () => {
  it("looks up nothing in an omitted or empty list", () => {
    expect(agentsConfig().list).toBeUndefined();
    expect(agentById(agentsConfig(), "missing")).toBeUndefined();
    expect(defaultMarked(agentsConfig())).toEqual([]);
    expect(removeAgent(agentsConfig(), "missing")).toEqual([]);

    const empty = agentsConfig([]);
    expect(empty.list).toEqual([]);
    expect(agentById(empty, "missing")).toBeUndefined();
    expect(defaultMarked(empty)).toEqual([]);
    expect(removeAgent(empty, "missing")).toEqual([]);
  });

  it("holds a single agent and returns undefined for a missing id", () => {
    const config = agentsConfig([agent("eliza", { name: "Eliza" })]);
    expect(config.list).toHaveLength(1);
    expect(agentById(config, "eliza")?.name).toBe("Eliza");
    expect(agentById(config, "missing")).toBeUndefined();
    expect(config.list?.[0]?.id).toBe("eliza");
  });

  it("preserves insertion order even when default-flag ties reverse received order", () => {
    const config = agentsConfig([
      agent("second", { default: true, name: "Second" }),
      agent("first", { default: true, name: "First" }),
      agent("third", { name: "Third" }),
    ]);
    expect(config.list?.map((entry) => entry.id)).toEqual([
      "second",
      "first",
      "third",
    ]);
    const tied = defaultMarked(config);
    expect(tied.map((entry) => entry.id)).toEqual(["second", "first"]);
    expect(tied[0]?.id).toBe("second");
  });

  it("removing a missing agent id leaves the list unchanged", () => {
    const config = agentsConfig([agent("eliza"), agent("helper")]);
    const next = removeAgent(config, "missing");
    expect(next.map((entry) => entry.id)).toEqual(["eliza", "helper"]);
    expect(removeAgent(config, "helper").map((entry) => entry.id)).toEqual([
      "eliza",
    ]);
  });

  it("has no capacity cap: overflow is just a longer insertion-ordered list", () => {
    const list = Array.from({ length: 64 }, (_, index) =>
      agent(`agent-${index}`),
    );
    const config = agentsConfig(list);
    expect(config.list).toHaveLength(64);
    expect(config.list?.[0]?.id).toBe("agent-0");
    expect(config.list?.[63]?.id).toBe("agent-63");
    expect(agentById(config, "agent-17")?.id).toBe("agent-17");
    expect(agentById(config, "agent-64")).toBeUndefined();
  });

  it("carries optional defaults alongside the list", () => {
    const defaults: AgentDefaultsConfig = { workspace: "/tmp/workspace" };
    const config: AgentsConfig = {
      defaults,
      list: [agent("eliza", { default: true })],
    };
    expect(config.defaults?.workspace).toBe("/tmp/workspace");
    expect(defaultMarked(config)).toHaveLength(1);
  });
});

describe("AgentBinding", () => {
  it("requires agentId and a channel match, with optional account/peer/guild/team", () => {
    expectTypeOf<AgentBinding>().toMatchTypeOf<{
      agentId: string;
      match: { channel: string };
    }>();
    expectTypeOf({
      agentId: "eliza",
      match: { channel: "telegram" },
    }).toMatchTypeOf<AgentBinding>();
    expectTypeOf({
      match: { channel: "telegram" },
    }).not.toMatchTypeOf<AgentBinding>();

    const minimal = bindingFor("eliza", "telegram");
    expect(minimal.agentId).toBe("eliza");
    expect(minimal.match.channel).toBe("telegram");
    expect(minimal.match.accountId).toBeUndefined();
    expect(minimal.match.peer).toBeUndefined();
  });

  it("returns no match against an empty binding queue", () => {
    const bindings: AgentBinding[] = [];
    const hit = bindings.find((binding) =>
      bindingMatches(binding, { channel: "telegram" }),
    );
    expect(hit).toBeUndefined();
  });

  it("matches a single binding by channel and ignores a missing account constraint", () => {
    const bindings = [bindingFor("eliza", "telegram")];
    expect(
      bindings.find((binding) =>
        bindingMatches(binding, { channel: "telegram" }),
      )?.agentId,
    ).toBe("eliza");
    expect(
      bindings.find((binding) =>
        bindingMatches(binding, { channel: "discord" }),
      ),
    ).toBeUndefined();
  });

  it("treats two matching bindings as a first-wins tie, not dual dispatch", () => {
    const bindings = [
      bindingFor("primary", "telegram"),
      bindingFor("secondary", "telegram"),
    ];
    const hit = bindings.find((binding) =>
      bindingMatches(binding, { channel: "telegram" }),
    );
    expect(hit?.agentId).toBe("primary");
    expect(
      bindings.filter((binding) => binding.match.channel === "telegram"),
    ).toHaveLength(2);
  });

  it("accepts every peer kind and fails closed when the peer id is missing", () => {
    for (const kind of PEER_KINDS) {
      const bindings = [
        bindingFor("eliza", "telegram", { peer: { kind, id: "peer-1" } }),
      ];
      expect(
        bindings.find((binding) =>
          bindingMatches(binding, {
            channel: "telegram",
            peer: { kind, id: "peer-1" },
          }),
        )?.agentId,
      ).toBe("eliza");
      expect(
        bindings.find((binding) =>
          bindingMatches(binding, {
            channel: "telegram",
            peer: { kind, id: "other" },
          }),
        ),
      ).toBeUndefined();
    }
  });

  it("removing a missing binding agentId leaves the queue unchanged", () => {
    const bindings = [
      bindingFor("eliza", "telegram"),
      bindingFor("helper", "discord"),
    ];
    const next = bindings.filter((binding) => binding.agentId !== "missing");
    expect(next.map((binding) => binding.agentId)).toEqual(["eliza", "helper"]);
  });

  it("has no capacity cap: overflow is just a longer insertion-ordered queue", () => {
    const bindings = Array.from({ length: 32 }, (_, index) =>
      bindingFor(`agent-${index}`, "telegram", { accountId: `acct-${index}` }),
    );
    expect(bindings).toHaveLength(32);
    expect(bindings[0]?.agentId).toBe("agent-0");
    expect(bindings[31]?.agentId).toBe("agent-31");
    const hit = bindings.find((binding) =>
      bindingMatches(binding, { channel: "telegram", accountId: "acct-7" }),
    );
    expect(hit?.agentId).toBe("agent-7");
  });
});
