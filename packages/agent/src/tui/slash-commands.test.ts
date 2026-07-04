import { describe, expect, it } from "vitest";
import {
  commandName,
  matchSlashInput,
  resolveSlashDispatch,
  type SerializedCommand,
  toSlashCommand,
  toSlashCommands,
} from "./slash-commands";

function makeCommand(
  overrides: Partial<SerializedCommand> & Pick<SerializedCommand, "key">,
): SerializedCommand {
  return {
    key: overrides.key,
    nativeName: overrides.nativeName ?? overrides.key,
    description: overrides.description ?? `desc for ${overrides.key}`,
    textAliases: overrides.textAliases ?? [`/${overrides.key}`],
    scope: overrides.scope ?? "both",
    category: overrides.category,
    acceptsArgs: overrides.acceptsArgs ?? false,
    args: overrides.args ?? [],
    requiresAuth: overrides.requiresAuth ?? false,
    requiresElevated: overrides.requiresElevated ?? false,
    surfaces: overrides.surfaces,
    target: overrides.target ?? { kind: "agent" },
    icon: overrides.icon,
    source: overrides.source ?? "builtin",
    views: overrides.views,
  };
}

describe("commandName", () => {
  it("prefers the first text alias without its slash", () => {
    const command = makeCommand({
      key: "help",
      nativeName: "help",
      textAliases: ["/help", "/h", "/?"],
    });
    expect(commandName(command)).toBe("help");
  });

  it("falls back to the native name when there is no alias", () => {
    const command = makeCommand({
      key: "status",
      nativeName: "status",
      textAliases: [],
    });
    expect(commandName(command)).toBe("status");
  });
});

describe("toSlashCommand", () => {
  it("maps name + description and omits arg completion when there are no choices", () => {
    const command = makeCommand({
      key: "status",
      nativeName: "status",
      description: "Show agent status",
      textAliases: ["/status", "/s"],
    });
    const slash = toSlashCommand(command);
    expect(slash.name).toBe("status");
    expect(slash.description).toBe("Show agent status");
    expect(slash.getArgumentCompletions).toBeUndefined();
  });

  it("wires static choices into getArgumentCompletions, filtering by prefix", () => {
    const command = makeCommand({
      key: "model",
      nativeName: "model",
      textAliases: ["/model", "/m"],
      acceptsArgs: true,
      args: [
        {
          name: "model",
          description: "Model to use",
          choices: ["gpt-5.5", "gpt-5.5-mini", "claude-opus-4-8"],
        },
      ],
    });
    const slash = toSlashCommand(command);
    expect(slash.getArgumentCompletions).toBeTypeOf("function");

    const all = slash.getArgumentCompletions?.("");
    expect(all?.map((item) => item.value)).toEqual([
      "gpt-5.5",
      "gpt-5.5-mini",
      "claude-opus-4-8",
    ]);

    const filtered = slash.getArgumentCompletions?.("gpt");
    expect(filtered?.map((item) => item.value)).toEqual([
      "gpt-5.5",
      "gpt-5.5-mini",
    ]);

    expect(slash.getArgumentCompletions?.("nomatch")).toBeNull();
  });

  it("does not wire arg completions for dynamic-only args (no static choices)", () => {
    const command = makeCommand({
      key: "views",
      nativeName: "views",
      textAliases: ["/views"],
      acceptsArgs: true,
      args: [{ name: "view", description: "View", dynamicChoices: "views" }],
    });
    expect(toSlashCommand(command).getArgumentCompletions).toBeUndefined();
  });
});

describe("toSlashCommands", () => {
  it("preserves catalog order", () => {
    const commands = [
      makeCommand({ key: "help" }),
      makeCommand({ key: "status" }),
      makeCommand({ key: "model" }),
    ];
    expect(toSlashCommands(commands).map((c) => c.name)).toEqual([
      "help",
      "status",
      "model",
    ]);
  });
});

describe("matchSlashInput", () => {
  const commands = [
    makeCommand({
      key: "help",
      nativeName: "help",
      textAliases: ["/help", "/h", "/?"],
    }),
    makeCommand({
      key: "model",
      nativeName: "model",
      textAliases: ["/model", "/m"],
    }),
  ];

  it("returns null for non-slash text", () => {
    expect(matchSlashInput(commands, "hello there")).toBeNull();
  });

  it("returns null for an unknown command", () => {
    expect(matchSlashInput(commands, "/nope")).toBeNull();
  });

  it("matches by native name with no args", () => {
    const result = matchSlashInput(commands, "/help");
    expect(result?.command.key).toBe("help");
    expect(result?.args).toBe("");
  });

  it("matches by short alias and captures args", () => {
    const result = matchSlashInput(commands, "/m gpt-5.5");
    expect(result?.command.key).toBe("model");
    expect(result?.args).toBe("gpt-5.5");
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    const result = matchSlashInput(commands, "  /HELP  ");
    expect(result?.command.key).toBe("help");
  });

  it("returns null for a bare slash", () => {
    expect(matchSlashInput(commands, "/")).toBeNull();
  });
});

describe("resolveSlashDispatch", () => {
  it("sends agent-target commands as literal slash text", () => {
    const command = makeCommand({ key: "help", target: { kind: "agent" } });
    const dispatch = resolveSlashDispatch({ command, args: "" }, "/help");
    expect(dispatch).toEqual({ kind: "send", text: "/help" });
  });

  it("maps clear-chat client target to a local clear", () => {
    const command = makeCommand({
      key: "clear",
      target: { kind: "client", clientAction: "clear-chat" },
    });
    expect(resolveSlashDispatch({ command, args: "" }, "/clear")).toEqual({
      kind: "clear",
    });
  });

  it("maps new-conversation client target to a local new", () => {
    const command = makeCommand({
      key: "new",
      target: { kind: "client", clientAction: "new-conversation" },
    });
    expect(resolveSlashDispatch({ command, args: "" }, "/new")).toEqual({
      kind: "new",
    });
  });

  it("falls back to send for client actions with no terminal behavior", () => {
    const command = makeCommand({
      key: "palette",
      target: { kind: "client", clientAction: "open-command-palette" },
    });
    expect(resolveSlashDispatch({ command, args: "" }, "/palette")).toEqual({
      kind: "send",
      text: "/palette",
    });
  });

  it("sends toggle-transcription to the agent (shared client action, no TUI behavior)", () => {
    // toggle-transcription was missing from the old hand-synced TUI union; it is
    // now part of the shared ClientCommandAction and must route like any other
    // client action the terminal can't run locally (#12411).
    const command = makeCommand({
      key: "transcription",
      target: { kind: "client", clientAction: "toggle-transcription" },
    });
    expect(
      resolveSlashDispatch({ command, args: "" }, "/transcription"),
    ).toEqual({ kind: "send", text: "/transcription" });
  });

  it("carries source and views through the shared wire contract", () => {
    // source and views are shared-contract fields the old TUI copy dropped; the
    // TUI must accept them without a type error (#12411).
    const command = makeCommand({
      key: "calendar",
      source: "custom-action",
      views: ["calendar"],
    });
    expect(command.source).toBe("custom-action");
    expect(command.views).toEqual(["calendar"]);
  });

  it("navigates to a pinned view id", () => {
    const command = makeCommand({
      key: "orchestrator",
      target: {
        kind: "navigate",
        path: "/orchestrator",
        viewId: "orchestrator",
      },
    });
    expect(
      resolveSlashDispatch({ command, args: "" }, "/orchestrator"),
    ).toEqual({ kind: "navigate-view", viewId: "orchestrator" });
  });

  it("navigates to a view id resolved from a /views <id> argument", () => {
    const command = makeCommand({
      key: "views",
      target: { kind: "navigate", path: "/views" },
      acceptsArgs: true,
      args: [{ name: "view", description: "View", dynamicChoices: "views" }],
    });
    expect(
      resolveSlashDispatch({ command, args: "tasks" }, "/views tasks"),
    ).toEqual({ kind: "navigate-view", viewId: "tasks" });
  });

  it("sends tab/settings navigation to the agent (no terminal equivalent)", () => {
    const command = makeCommand({
      key: "settings",
      target: {
        kind: "navigate",
        path: "/settings",
        tab: "settings",
        section: "ai-model",
      },
    });
    expect(resolveSlashDispatch({ command, args: "" }, "/settings")).toEqual({
      kind: "send",
      text: "/settings",
    });
  });
});
