/**
 * Browser service helper tests cover confirmation policy at the session
 * creation boundary without replacing the domain object under test.
 */
import type { BrowserBridgeAction } from "@elizaos/plugin-browser";
import { describe, expect, it } from "vitest";
import { resolveAwaitingBrowserActionId } from "./service-helpers-browser.js";

function action(
  id: string,
  overrides: Partial<BrowserBridgeAction>,
): BrowserBridgeAction {
  return {
    id,
    kind: "click",
    label: id,
    url: "https://allowed.example/",
    selector: "button",
    text: null,
    accountAffecting: false,
    requiresConfirmation: false,
    metadata: {},
    ...overrides,
  };
}

describe("resolveAwaitingBrowserActionId", () => {
  it("honors the account-affecting confirmation setting", () => {
    const actions = [action("account", { accountAffecting: true })];
    expect(resolveAwaitingBrowserActionId(actions, true)).toBe("account");
    expect(resolveAwaitingBrowserActionId(actions, false)).toBeNull();
  });

  it("never bypasses an action's explicit confirmation requirement", () => {
    const actions = [action("explicit", { requiresConfirmation: true })];
    expect(resolveAwaitingBrowserActionId(actions, false)).toBe("explicit");
  });

  it("selects the first action requiring confirmation under the policy", () => {
    const actions = [
      action("safe", {}),
      action("account", { accountAffecting: true }),
      action("explicit", { requiresConfirmation: true }),
    ];
    expect(resolveAwaitingBrowserActionId(actions, true)).toBe("account");
    expect(resolveAwaitingBrowserActionId(actions, false)).toBe("explicit");
  });
});
