/**
 * Behavioral contract for the browser-workspace provider (plugin-browser).
 *
 * The provider surfaces live browser-workspace state (dispatch mode + open
 * tab list) into agent context. Two properties are worth pinning:
 *
 * 1. The role/context gates travel WITH the provider (owner-operator context,
 *    issue #12094): a rename or refactor cannot silently drop them.
 * 2. The degrade contract: any failure reading workspace state must turn into
 *    a structured `available: false` payload — never a thrown error that
 *    breaks the whole provider composition.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as workspaceBridge from "../workspace/browser-workspace";

interface ParsedWorkspacePayload {
  browser_workspace?: {
    mode?: string;
    tabCount?: number;
    tabs?: Array<Record<string, unknown>>;
    available?: boolean;
    error?: string;
  };
}

import { browserWorkspaceProvider } from "./workspace";

describe("browserWorkspaceProvider — gates and degrade contract", () => {
  beforeEach(() => {
    vi.spyOn(workspaceBridge, "getBrowserWorkspaceMode").mockReturnValue(
      "desktop",
    );
    vi.spyOn(workspaceBridge, "listBrowserWorkspaceTabs").mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pins the owner-only role gate and browser/web context gates on the provider", () => {
    // The comment on the provider states the gate must travel with it so a
    // rename can't silently drop owner-operator context protection.
    expect(browserWorkspaceProvider.roleGate).toEqual({ minRole: "OWNER" });
    expect(browserWorkspaceProvider.contextGate).toEqual({
      anyOf: ["browser", "web"],
    });
    expect(browserWorkspaceProvider.contexts).toEqual(["browser", "web"]);
    expect(browserWorkspaceProvider.cacheStable).toBe(false);
    expect(browserWorkspaceProvider.cacheScope).toBe("turn");
  });

  it("renders mode, tab count, and tab details into context on the happy path", async () => {
    vi.mocked(workspaceBridge.listBrowserWorkspaceTabs).mockResolvedValue([
      { id: "t1", visible: true, url: "https://example.com", title: "Example" },
      { id: "t2", visible: false, url: "https://elizaos.ai", title: "Eliza" },
    ]);

    const out = await browserWorkspaceProvider.get?.();

    expect(out.data).toEqual({
      available: true,
      mode: "desktop",
      tabs: [
        {
          id: "t1",
          visible: true,
          url: "https://example.com",
          title: "Example",
        },
        { id: "t2", visible: false, url: "https://elizaos.ai", title: "Eliza" },
      ],
    });
    const parsed = JSON.parse(out.text) as ParsedWorkspacePayload;
    expect(parsed.browser_workspace.mode).toBe("desktop");
    expect(parsed.browser_workspace.tabCount).toBe(2);
    expect(parsed.browser_workspace.tabs[1].url).toBe("https://elizaos.ai");
  });

  it("degrades to available:false with the error message when tab listing throws", async () => {
    vi.mocked(workspaceBridge.listBrowserWorkspaceTabs).mockRejectedValue(
      new Error("workspace unreachable"),
    );

    const out = await browserWorkspaceProvider.get?.();

    expect(out.data).toEqual({
      available: false,
      error: "workspace unreachable",
    });
    const parsed = JSON.parse(out.text) as ParsedWorkspacePayload;
    expect(parsed.browser_workspace.available).toBe(false);
    expect(parsed.browser_workspace.error).toBe("workspace unreachable");
  });

  it("degrades to available:false when the mode probe throws", async () => {
    vi.mocked(workspaceBridge.getBrowserWorkspaceMode).mockImplementation(
      () => {
        throw new Error("bridge dead");
      },
    );

    const out = await browserWorkspaceProvider.get?.();

    expect(out.data).toEqual({ available: false, error: "bridge dead" });
    const parsed = JSON.parse(out.text) as ParsedWorkspacePayload;
    expect(parsed.browser_workspace.available).toBe(false);
  });

  it("stringifies non-Error failures without crashing", async () => {
    vi.mocked(workspaceBridge.listBrowserWorkspaceTabs).mockRejectedValue(
      "raw string failure",
    );

    const out = await browserWorkspaceProvider.get?.();

    expect(out.data).toEqual({ available: false, error: "raw string failure" });
  });
});
