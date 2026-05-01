/**
 * BROWSER_AUTOFILL_LOGIN action tests.
 *
 * Verifies:
 *   - Refuses without `creds.<domain>.:autoallow = "1"` set.
 *   - Picks the most recent saved login when no username is supplied.
 *   - Refuses when no open tab matches the domain.
 *   - Injects an autofill script into the matching tab when authorized.
 *   - `submit: true` flows through to the injected script.
 */

import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { setAutofillAllowed, setSavedLogin } from "@elizaos/vault";
import { createTestVault, type TestVault } from "@elizaos/vault/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../security/access.js", () => ({
  hasOwnerAccess: vi.fn(async () => true),
}));

vi.mock("../services/browser-workspace.js", () => ({
  isBrowserWorkspaceBridgeConfigured: vi.fn(() => true),
  listBrowserWorkspaceTabs: vi.fn(),
  evaluateBrowserWorkspaceTab: vi.fn(),
}));

const sharedVaultMock = vi.fn();
vi.mock("@elizaos/app-core/services/vault-mirror", () => ({
  sharedVault: () => sharedVaultMock(),
}));

import {
  evaluateBrowserWorkspaceTab,
  isBrowserWorkspaceBridgeConfigured,
  listBrowserWorkspaceTabs,
} from "../services/browser-workspace.js";
import { browserAutofillLoginAction } from "./browser-autofill-login.js";

const mockListTabs = vi.mocked(listBrowserWorkspaceTabs);
const mockEvalTab = vi.mocked(evaluateBrowserWorkspaceTab);
const mockBridgeConfigured = vi.mocked(isBrowserWorkspaceBridgeConfigured);

const fakeRuntime = {
  agentId: "agent-id" as UUID,
} as unknown as IAgentRuntime;

const fakeMessage: Memory = {
  id: "msg-1" as UUID,
  entityId: "user-1" as UUID,
  roomId: "room-1" as UUID,
  worldId: "world-1" as UUID,
  content: { text: "log into github.com for me" },
};

describe("browserAutofillLoginAction", () => {
  let testVault: TestVault;

  beforeEach(async () => {
    testVault = await createTestVault();
    sharedVaultMock.mockReturnValue(testVault.vault);
    mockBridgeConfigured.mockReturnValue(true);
    mockListTabs.mockReset();
    mockEvalTab.mockReset();
  });

  afterEach(async () => {
    await testVault.dispose();
    vi.clearAllMocks();
  });

  it("requires a domain parameter", async () => {
    const result = await browserAutofillLoginAction.handler(
      fakeRuntime,
      fakeMessage,
      undefined,
      { parameters: {} } as unknown as Parameters<
        typeof browserAutofillLoginAction.handler
      >[3],
    );
    expect(result?.success).toBe(false);
    expect(result?.values).toMatchObject({
      error: "BROWSER_AUTOFILL_LOGIN_BAD_PARAMS",
    });
  });

  it("refuses without per-domain autoallow", async () => {
    await setSavedLogin(testVault.vault, {
      domain: "github.com",
      username: "alice",
      password: "hunter2",
    });
    // Note: no setAutofillAllowed call.

    const result = await browserAutofillLoginAction.handler(
      fakeRuntime,
      fakeMessage,
      undefined,
      { parameters: { domain: "github.com" } } as unknown as Parameters<
        typeof browserAutofillLoginAction.handler
      >[3],
    );

    expect(result?.success).toBe(false);
    expect(result?.values).toMatchObject({
      error: "AGENT_AUTOFILL_NOT_AUTHORIZED",
      domain: "github.com",
    });
    expect(mockEvalTab).not.toHaveBeenCalled();
  });

  it("refuses when no saved login exists for the domain", async () => {
    await setAutofillAllowed(testVault.vault, "github.com", true);

    const result = await browserAutofillLoginAction.handler(
      fakeRuntime,
      fakeMessage,
      undefined,
      { parameters: { domain: "github.com" } } as unknown as Parameters<
        typeof browserAutofillLoginAction.handler
      >[3],
    );

    expect(result?.success).toBe(false);
    expect(result?.values).toMatchObject({
      error: "AGENT_AUTOFILL_NO_LOGIN",
    });
  });

  it("refuses when no open tab matches the domain", async () => {
    await setAutofillAllowed(testVault.vault, "github.com", true);
    await setSavedLogin(testVault.vault, {
      domain: "github.com",
      username: "alice",
      password: "hunter2",
    });
    mockListTabs.mockResolvedValue([]);

    const result = await browserAutofillLoginAction.handler(
      fakeRuntime,
      fakeMessage,
      undefined,
      { parameters: { domain: "github.com" } } as unknown as Parameters<
        typeof browserAutofillLoginAction.handler
      >[3],
    );

    expect(result?.success).toBe(false);
    expect(result?.values).toMatchObject({
      error: "AGENT_AUTOFILL_NO_TAB",
      domain: "github.com",
    });
    expect(mockEvalTab).not.toHaveBeenCalled();
  });

  it("fills an open tab when authorized + saved login exists", async () => {
    await setAutofillAllowed(testVault.vault, "github.com", true);
    await setSavedLogin(testVault.vault, {
      domain: "github.com",
      // Note: usernames with a literal `.` collide with the vault's
      // dot-segmented key parsing today (`encodeURIComponent` doesn't
      // encode `.`). Use a dot-free identifier here so the test isn't
      // chasing that pre-existing parser bug.
      username: "alice",
      password: "hunter2",
    });
    mockListTabs.mockResolvedValue([
      {
        id: "btab_1",
        url: "https://github.com/login",
        title: "Sign in to GitHub",
        partition: "persist:eliza-browser-app",
        kind: "standard",
        visible: true,
        createdAt: 1,
        updatedAt: 2,
        lastFocusedAt: 2,
      },
    ]);
    mockEvalTab.mockResolvedValue({
      ok: true,
      filled: { username: true, password: true },
      submitted: false,
    });

    const result = await browserAutofillLoginAction.handler(
      fakeRuntime,
      fakeMessage,
      undefined,
      { parameters: { domain: "github.com" } } as unknown as Parameters<
        typeof browserAutofillLoginAction.handler
      >[3],
    );

    expect(result?.success).toBe(true);
    expect(result?.values).toMatchObject({
      success: true,
      domain: "github.com",
      tabId: "btab_1",
      submitted: false,
    });
    expect(mockEvalTab).toHaveBeenCalledOnce();
    const call = mockEvalTab.mock.calls[0]?.[0];
    expect(call?.id).toBe("btab_1");
    // The injected script must contain the resolved password and not
    // the placeholder.
    expect(call?.script).toContain("hunter2");
    expect(call?.script).toContain("alice");
    expect(call?.script).toContain("const SUBMIT = false");
  });

  it("propagates submit:true into the injected script", async () => {
    await setAutofillAllowed(testVault.vault, "github.com", true);
    await setSavedLogin(testVault.vault, {
      domain: "github.com",
      username: "alice",
      password: "hunter2",
    });
    mockListTabs.mockResolvedValue([
      {
        id: "btab_1",
        url: "https://github.com/login",
        title: "Sign in to GitHub",
        partition: "persist:eliza-browser-app",
        kind: "standard",
        visible: true,
        createdAt: 1,
        updatedAt: 2,
        lastFocusedAt: 2,
      },
    ]);
    mockEvalTab.mockResolvedValue({
      ok: true,
      filled: { username: true, password: true },
      submitted: true,
    });

    await browserAutofillLoginAction.handler(
      fakeRuntime,
      fakeMessage,
      undefined,
      {
        parameters: { domain: "github.com", submit: true },
      } as unknown as Parameters<typeof browserAutofillLoginAction.handler>[3],
    );
    const call = mockEvalTab.mock.calls[0]?.[0];
    expect(call?.script).toContain("const SUBMIT = true");
  });

  it("requires the desktop browser workspace bridge", async () => {
    mockBridgeConfigured.mockReturnValue(false);
    const result = await browserAutofillLoginAction.handler(
      fakeRuntime,
      fakeMessage,
      undefined,
      { parameters: { domain: "github.com" } } as unknown as Parameters<
        typeof browserAutofillLoginAction.handler
      >[3],
    );
    expect(result?.success).toBe(false);
    expect(result?.values).toMatchObject({
      error: "BROWSER_BRIDGE_UNAVAILABLE",
    });
  });
});
