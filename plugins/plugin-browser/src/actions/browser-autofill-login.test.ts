/**
 * Production-boundary regression for browser login autofill when the live tab
 * evaluator finds no password input. Vault and workspace transports are mocked;
 * the real executeBrowserAutofillLogin result translation runs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  vault: {},
  getAutofillAllowed: vi.fn(),
  getSavedLogin: vi.fn(),
  listSavedLogins: vi.fn(),
  isBrowserWorkspaceBridgeConfigured: vi.fn(),
  listBrowserWorkspaceTabs: vi.fn(),
  evaluateBrowserWorkspaceTab: vi.fn(),
}));

vi.mock("@elizaos/vault", () => ({
  createManager: () => ({ vault: mocks.vault }),
  getAutofillAllowed: mocks.getAutofillAllowed,
  getSavedLogin: mocks.getSavedLogin,
  listSavedLogins: mocks.listSavedLogins,
}));

vi.mock("../workspace/browser-workspace.js", () => ({
  isBrowserWorkspaceBridgeConfigured: mocks.isBrowserWorkspaceBridgeConfigured,
  listBrowserWorkspaceTabs: mocks.listBrowserWorkspaceTabs,
  evaluateBrowserWorkspaceTab: mocks.evaluateBrowserWorkspaceTab,
}));

const { executeBrowserAutofillLogin } = await import(
  "./browser-autofill-login.js"
);

describe("executeBrowserAutofillLogin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isBrowserWorkspaceBridgeConfigured.mockReturnValue(true);
    mocks.getAutofillAllowed.mockResolvedValue(true);
    mocks.getSavedLogin.mockResolvedValue({
      username: "alice",
      password: "vault-password",
    });
    mocks.listSavedLogins.mockResolvedValue([]);
    mocks.listBrowserWorkspaceTabs.mockResolvedValue([
      { id: "tab-login", url: "https://example.com/login" },
    ]);
  });

  it("returns a failed action result when the evaluated tab has no password input", async () => {
    mocks.evaluateBrowserWorkspaceTab.mockResolvedValue({
      ok: false,
      reason: "no_password_input",
    });

    const result = await executeBrowserAutofillLogin({} as never, undefined, {
      parameters: {
        domain: "example.com",
        username: "alice",
      },
    } as never);

    expect(mocks.evaluateBrowserWorkspaceTab).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: false,
      values: {
        success: false,
        error: "AGENT_AUTOFILL_NO_INPUTS",
        domain: "example.com",
        tabId: "tab-login",
        filled: false,
        fillReason: "no_password_input",
        subaction: "autofill-login",
      },
      data: {
        actionName: "BROWSER",
        subaction: "autofill-login",
        domain: "example.com",
        tabId: "tab-login",
        filled: false,
        fillReason: "no_password_input",
      },
    });
    expect(result.text).toContain("No password input found");
    expect(JSON.stringify(result)).not.toContain("vault-password");
  });

  it("preserves a complete evaluated-tab failure reason", async () => {
    const reason = `browser-evaluation-failed:${"detail-".repeat(100)}`;
    mocks.evaluateBrowserWorkspaceTab.mockResolvedValue({
      ok: false,
      reason,
    });

    const result = await executeBrowserAutofillLogin({} as never, undefined, {
      parameters: {
        domain: "example.com",
        username: "alice",
      },
    } as never);

    expect(result.success).toBe(false);
    expect(result.values).toMatchObject({ fillReason: reason });
    expect(result.data).toMatchObject({ fillReason: reason });
    expect(result.text).toContain(reason);
  });

  it.each([
    undefined,
    {},
    { ok: true, filled: {} },
    { ok: false, filled: { password: true } },
  ])("fails closed for malformed evaluator result %#", async (rawResult) => {
    mocks.evaluateBrowserWorkspaceTab.mockResolvedValue(rawResult);

    const result = await executeBrowserAutofillLogin({} as never, undefined, {
      parameters: { domain: "example.com", username: "alice" },
    } as never);

    expect(result.success).toBe(false);
    expect(result.values).toMatchObject({
      success: false,
      error: "AGENT_AUTOFILL_NO_INPUTS",
      filled: false,
    });
    expect(JSON.stringify(result)).not.toContain("vault-password");
  });

  it("preserves a verified password-fill result as success", async () => {
    mocks.evaluateBrowserWorkspaceTab.mockResolvedValue({
      ok: true,
      filled: { username: true, password: true },
      submitted: false,
    });

    const result = await executeBrowserAutofillLogin({} as never, undefined, {
      parameters: { domain: "example.com", username: "alice" },
    } as never);

    expect(result).toMatchObject({
      success: true,
      values: { success: true, filled: true, submitted: false },
      data: { filled: true },
    });
    expect(result.text).toContain("Filled login on example.com");
    expect(JSON.stringify(result)).not.toContain("vault-password");
  });
});
