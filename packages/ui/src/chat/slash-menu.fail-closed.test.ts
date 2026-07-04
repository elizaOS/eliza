/**
 * Unit coverage asserting client shortcut execution fails closed for unknown/
 * unauthorized commands. Pure functions, no live agent.
 */
import { describe, expect, it } from "vitest";
import type { SlashCommandCatalogItem } from "./slash-menu";
import { resolveClientShortcutExecution } from "./slash-menu";

/**
 * Fail-closed elevation gating for the natural-language shortcut path (#12087
 * Item 20). `resolveClientShortcutExecution` used to default the sender's
 * authority to `true`, so a remote USER/GUEST could trigger `requiresElevated`
 * navigate/client shortcuts by typing the natural phrase. The defaults are now
 * `false`; the caller (`ContinuousChatOverlay`) threads the real tier from the
 * controller (`slash.isAuthorized` / `slash.isElevated`, derived from
 * `useRole()`).
 */

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

const resolveSection = (token: string): string => token;

const elevatedNav = cmd({
  key: "orchestrator",
  textAliases: ["/orchestrator"],
  description: "Open orchestrator",
  target: { kind: "navigate", viewId: "orchestrator", path: "/orchestrator" },
  requiresElevated: true,
});

const authedNav = cmd({
  key: "plugins",
  textAliases: ["/plugins"],
  description: "Open plugins",
  target: { kind: "navigate", tab: "plugins", path: "/apps/plugins" },
  requiresAuth: true,
});

const commands = [elevatedNav, authedNav];

describe("resolveClientShortcutExecution — fail-closed authority (#12087 Item 20)", () => {
  it("does NOT resolve a requiresElevated natural shortcut when elevation is omitted", () => {
    expect(
      resolveClientShortcutExecution(
        commands,
        "open orchestrator",
        resolveSection,
        { allowNatural: true },
      ),
    ).toBeNull();
  });

  it("resolves the requiresElevated shortcut once isElevated is passed", () => {
    expect(
      resolveClientShortcutExecution(
        commands,
        "open orchestrator",
        resolveSection,
        { allowNatural: true, isAuthorized: true, isElevated: true },
      ),
    ).toEqual({
      kind: "navigate-view",
      viewId: "orchestrator",
      viewPath: "/orchestrator",
    });
  });

  it("does NOT resolve a requiresAuth natural shortcut when authorization is omitted", () => {
    expect(
      resolveClientShortcutExecution(commands, "open plugins", resolveSection, {
        allowNatural: true,
      }),
    ).toBeNull();
  });

  it("resolves the requiresAuth shortcut once isAuthorized is passed", () => {
    expect(
      resolveClientShortcutExecution(commands, "open plugins", resolveSection, {
        allowNatural: true,
        isAuthorized: true,
      }),
    ).toEqual({ kind: "navigate-tab", tab: "plugins" });
  });
});
