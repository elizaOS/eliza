import { describe, expect, it } from "vitest";
import type { CommandSurface, SlashCommandCatalogItem } from "./slash-menu";
import { filterCommandsForSurface } from "./slash-menu";

function cmd(
  partial: Partial<SlashCommandCatalogItem> & { key: string },
): SlashCommandCatalogItem {
  return {
    nativeName: partial.nativeName ?? partial.key,
    description: partial.description ?? "",
    textAliases: partial.textAliases ?? [`/${partial.key}`],
    scope: partial.scope ?? "both",
    acceptsArgs: partial.acceptsArgs ?? (partial.args?.length ?? 0) > 0,
    args: partial.args ?? [],
    requiresAuth: partial.requiresAuth ?? false,
    requiresElevated: partial.requiresElevated ?? false,
    target: partial.target ?? { kind: "agent" },
    ...partial,
    source: partial.source ?? "builtin",
  };
}

const keys = (commands: SlashCommandCatalogItem[]): string[] =>
  commands.map((c) => c.key);

const GUI: CommandSurface = "gui";

describe("filterCommandsForSurface — surface gating", () => {
  it("keeps a command whose surfaces include the current surface", () => {
    const result = filterCommandsForSurface(
      [cmd({ key: "gui-only", surfaces: ["gui"] })],
      { surface: GUI, isAuthorized: true, isElevated: true },
    );
    expect(keys(result)).toEqual(["gui-only"]);
  });

  it("hides a command whose non-empty surfaces exclude the current surface", () => {
    const result = filterCommandsForSurface(
      [cmd({ key: "discord-only", surfaces: ["discord", "telegram"] })],
      { surface: GUI, isAuthorized: true, isElevated: true },
    );
    expect(keys(result)).toEqual([]);
  });

  it("shows a command with undefined surfaces everywhere (default)", () => {
    const result = filterCommandsForSurface([cmd({ key: "everywhere" })], {
      surface: GUI,
      isAuthorized: true,
      isElevated: true,
    });
    expect(keys(result)).toEqual(["everywhere"]);
  });

  it("shows a command with an empty surfaces array everywhere", () => {
    const result = filterCommandsForSurface(
      [cmd({ key: "empty", surfaces: [] })],
      { surface: GUI, isAuthorized: true, isElevated: true },
    );
    expect(keys(result)).toEqual(["empty"]);
  });

  it("filters a mixed catalog down to the current surface", () => {
    const result = filterCommandsForSurface(
      [
        cmd({ key: "agnostic" }),
        cmd({ key: "gui", surfaces: ["gui"] }),
        cmd({ key: "tui", surfaces: ["tui"] }),
        cmd({ key: "multi", surfaces: ["tui", "gui"] }),
      ],
      { surface: GUI, isAuthorized: true, isElevated: true },
    );
    expect(keys(result)).toEqual(["agnostic", "gui", "multi"]);
  });
});

describe("filterCommandsForSurface — requiresAuth gating", () => {
  it("hides a requiresAuth command when the sender is not authorized", () => {
    const result = filterCommandsForSurface(
      [cmd({ key: "secret", requiresAuth: true })],
      { surface: GUI, isAuthorized: false, isElevated: false },
    );
    expect(keys(result)).toEqual([]);
  });

  it("shows a requiresAuth command when the sender is authorized", () => {
    const result = filterCommandsForSurface(
      [cmd({ key: "secret", requiresAuth: true })],
      { surface: GUI, isAuthorized: true, isElevated: false },
    );
    expect(keys(result)).toEqual(["secret"]);
  });
});

describe("filterCommandsForSurface — requiresElevated gating", () => {
  it("hides a requiresElevated command when the sender is not elevated", () => {
    const result = filterCommandsForSurface(
      [cmd({ key: "admin", requiresElevated: true })],
      { surface: GUI, isAuthorized: true, isElevated: false },
    );
    expect(keys(result)).toEqual([]);
  });

  it("shows a requiresElevated command when the sender is elevated", () => {
    const result = filterCommandsForSurface(
      [cmd({ key: "admin", requiresElevated: true })],
      { surface: GUI, isAuthorized: true, isElevated: true },
    );
    expect(keys(result)).toEqual(["admin"]);
  });

  it("hides a requiresElevated command even when authorized but not elevated", () => {
    const result = filterCommandsForSurface(
      [cmd({ key: "plain" }), cmd({ key: "admin", requiresElevated: true })],
      { surface: GUI, isAuthorized: true, isElevated: false },
    );
    expect(keys(result)).toEqual(["plain"]);
  });
});

describe("filterCommandsForSurface — normal commands", () => {
  it("always shows a command with no surface/auth/elevation constraints", () => {
    for (const ctx of [
      { surface: GUI, isAuthorized: true, isElevated: true },
      { surface: GUI, isAuthorized: false, isElevated: false },
      { surface: GUI, isAuthorized: true, isElevated: false },
    ] as const) {
      const result = filterCommandsForSurface([cmd({ key: "normal" })], ctx);
      expect(keys(result)).toEqual(["normal"]);
    }
  });

  it("applies surface and auth gating together", () => {
    const result = filterCommandsForSurface(
      [
        cmd({ key: "ok" }),
        cmd({ key: "wrong-surface", surfaces: ["discord"] }),
        cmd({ key: "needs-auth", requiresAuth: true }),
        cmd({ key: "needs-elevated", requiresElevated: true }),
        cmd({ key: "gui-auth", surfaces: ["gui"], requiresAuth: true }),
      ],
      { surface: GUI, isAuthorized: false, isElevated: false },
    );
    // Only the unconstrained command survives an unauthorized GUI sender.
    expect(keys(result)).toEqual(["ok"]);
  });

  it("preserves catalog order of the surviving commands", () => {
    const result = filterCommandsForSurface(
      [
        cmd({ key: "a" }),
        cmd({ key: "b", surfaces: ["discord"] }),
        cmd({ key: "c" }),
        cmd({ key: "d", requiresAuth: true }),
        cmd({ key: "e" }),
      ],
      { surface: GUI, isAuthorized: false, isElevated: false },
    );
    expect(keys(result)).toEqual(["a", "c", "e"]);
  });
});
