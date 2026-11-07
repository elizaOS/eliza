/**
 * `tab` (tabAction "new") and `window` load their `url` in a fresh tab, so the
 * domain allowlist must gate them like `open` and `navigate`.
 */
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  browserDomainPolicyRequestForCommand,
  createBrowserDomainAllowlistPolicy,
  registerBrowserDomainPolicy,
  unregisterBrowserDomainPolicy,
} from "./browser-domain-policy.js";
import { BrowserService, type BrowserTarget } from "./browser-service.js";
import type { BrowserWorkspaceCommand } from "./workspace/browser-workspace-types.js";

const POLICY_ID = "test-new-tab-allowlist";

afterEach(() => {
  unregisterBrowserDomainPolicy(POLICY_ID);
});

describe("browserDomainPolicyRequestForCommand", () => {
  it("classifies a tab or window opened at a URL as navigation", () => {
    for (const command of [
      { subaction: "tab", tabAction: "new", url: "https://evil.example/" },
      { subaction: "window", url: "https://evil.example/" },
    ] satisfies BrowserWorkspaceCommand[]) {
      expect(browserDomainPolicyRequestForCommand(command, null)).toMatchObject(
        { effect: "navigate", domain: "evil.example" },
      );
    }
  });

  it("keeps blank tabs and tab bookkeeping out of navigation", () => {
    for (const command of [
      { subaction: "tab", tabAction: "new" },
      { subaction: "tab", tabAction: "new", url: "  " },
      { subaction: "window" },
      // The BROWSER action copies a URL from the message into every command.
      { subaction: "tab", tabAction: "close", url: "https://evil.example/" },
      { subaction: "tab", tabAction: "switch", url: "https://evil.example/" },
      { subaction: "tab", url: "https://evil.example/" },
    ] satisfies BrowserWorkspaceCommand[]) {
      expect(browserDomainPolicyRequestForCommand(command, null).effect).toBe(
        "interact",
      );
    }
  });
});

describe("BrowserService domain allowlist", () => {
  function serviceWithRecordingTarget(): {
    service: BrowserService;
    dispatched: string[];
  } {
    const runtime = createSQLiteTestRuntime({
      character: { name: "DomainPolicyTest", bio: [] },
    });
    const service = new BrowserService(runtime);
    const dispatched: string[] = [];
    const target: BrowserTarget = {
      id: "recording",
      name: "Recording target",
      description: "Records dispatched commands.",
      kind: "app",
      priority: 1,
      available: async () => true,
      execute: async (command) => {
        dispatched.push(`${command.subaction}:${command.url ?? ""}`);
        return { mode: "web", subaction: command.subaction };
      },
    };
    service.registerTarget(target);
    return { service, dispatched };
  }

  it("blocks a new tab or window at a domain outside the allowlist", async () => {
    registerBrowserDomainPolicy(
      createBrowserDomainAllowlistPolicy({
        id: POLICY_ID,
        allowedDomains: ["example.com"],
      }),
    );
    const { service, dispatched } = serviceWithRecordingTarget();

    // The planner's `action: "open_tab"` with a url becomes the tab command.
    for (const command of [
      { subaction: "open", url: "https://evil.example/" },
      { subaction: "tab", tabAction: "new", url: "https://evil.example/" },
      { subaction: "window", url: "https://evil.example/" },
      {
        subaction: "batch",
        steps: [
          { subaction: "tab", tabAction: "new", url: "https://evil.example/" },
        ],
      },
    ] satisfies BrowserWorkspaceCommand[]) {
      await expect(service.execute(command, "recording")).rejects.toMatchObject(
        { kind: "POLICY_BLOCKED" },
      );
    }
    expect(dispatched).toEqual([]);

    await service.execute(
      { subaction: "tab", tabAction: "new", url: "https://shop.example.com/" },
      "recording",
    );
    await service.execute({ subaction: "tab", tabAction: "new" }, "recording");
    expect(dispatched).toEqual(["tab:https://shop.example.com/", "tab:"]);
  });
});
