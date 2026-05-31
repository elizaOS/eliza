import { beforeEach, describe, expect, it } from "vitest";
import {
  BROWSER_WORKSPACE_JSDOM_SCRIPT_FORBIDDEN,
  createBrowserWorkspaceJsdomScriptExecutionError,
} from "../browser-workspace-helpers.js";
import {
  __resetBrowserWorkspaceStateForTests,
  executeBrowserWorkspaceCommand,
  openBrowserWorkspaceTab,
} from "../browser-workspace.js";

describe("browser workspace JSDOM script execution (GHSA-mhhr-9ph9-64j7)", () => {
  const webEnv: NodeJS.ProcessEnv = {};

  beforeEach(async () => {
    await __resetBrowserWorkspaceStateForTests();
  });

  it("rejects eval on the web (JSDOM) backend", async () => {
    const tab = await openBrowserWorkspaceTab({ url: "about:blank" }, webEnv);

    await expect(
      executeBrowserWorkspaceCommand(
        {
          subaction: "eval",
          tabId: tab.id,
          script: "1 + 1",
        },
        webEnv,
      ),
    ).rejects.toThrow(BROWSER_WORKSPACE_JSDOM_SCRIPT_FORBIDDEN);
  });

  it("rejects wait conditions that use script on the web backend", async () => {
    const tab = await openBrowserWorkspaceTab({ url: "about:blank" }, webEnv);

    await expect(
      executeBrowserWorkspaceCommand(
        {
          subaction: "wait",
          tabId: tab.id,
          script: "document.title",
          timeoutMs: 200,
        },
        webEnv,
      ),
    ).rejects.toThrow(/Wait conditions with `script`/);
  });

  it("does not expose a prototype-chain escape payload via eval", async () => {
    const tab = await openBrowserWorkspaceTab({ url: "about:blank" }, webEnv);
    const escapePayload =
      '({}).constructor.constructor("return process")().env';

    await expect(
      executeBrowserWorkspaceCommand(
        {
          subaction: "eval",
          tabId: tab.id,
          script: escapePayload,
        },
        webEnv,
      ),
    ).rejects.toThrow(createBrowserWorkspaceJsdomScriptExecutionError("eval")
      .message);
  });
});
