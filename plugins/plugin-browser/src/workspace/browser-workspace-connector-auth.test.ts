import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetBrowserWorkspaceStateForTests,
  acquireBrowserWorkspaceConnectorSession,
  executeBrowserWorkspaceCommand,
  listBrowserWorkspaceTabs,
  resolveBrowserWorkspaceConnectorPartition,
} from "./browser-workspace.js";

describe("browser workspace connector auth sessions", () => {
  const webEnv: NodeJS.ProcessEnv = {};

  beforeEach(async () => {
    await __resetBrowserWorkspaceStateForTests();
  });

  it("derives persistent per-provider account partitions", () => {
    expect(
      resolveBrowserWorkspaceConnectorPartition("Gmail", "Work Account"),
    ).toBe("persist:connector-gmail-work-account");
    expect(
      resolveBrowserWorkspaceConnectorPartition(
        "google/chat",
        "me@example.com",
      ),
    ).toBe("persist:connector-google-chat-me-example-com");
  });

  it("isolates named accounts into separate internal browser partitions", async () => {
    const first = await acquireBrowserWorkspaceConnectorSession(
      {
        provider: "gmail",
        accountId: "work",
        url: "https://mail.google.com/",
      },
      webEnv,
    );
    const second = await acquireBrowserWorkspaceConnectorSession(
      {
        provider: "gmail",
        accountId: "personal",
        url: "https://mail.google.com/",
      },
      webEnv,
    );

    expect(first.partition).toBe("persist:connector-gmail-work");
    expect(second.partition).toBe("persist:connector-gmail-personal");
    expect(first.tabId).not.toBe(second.tabId);
    expect(first.authState).toBe("auth_pending");
    expect(second.authState).toBe("auth_pending");

    const tabs = await listBrowserWorkspaceTabs(webEnv);
    expect(tabs.map((tab) => tab.partition).sort()).toEqual([
      "persist:connector-gmail-personal",
      "persist:connector-gmail-work",
    ]);
  });

  it("reuses the same provider account handle without sharing other accounts", async () => {
    const first = await acquireBrowserWorkspaceConnectorSession(
      {
        provider: "slack",
        accountId: "team-a",
        url: "https://app.slack.com/",
      },
      webEnv,
    );
    const second = await acquireBrowserWorkspaceConnectorSession(
      {
        provider: "slack",
        accountId: "team-a",
        url: "https://app.slack.com/",
      },
      webEnv,
    );

    expect(second.created).toBe(false);
    expect(second.partition).toBe(first.partition);
    expect(second.tabId).toBe(first.tabId);
    expect(second.authState).toBe("ready");
  });

  it("does not expose raw cookies or storage from connector partitions", async () => {
    const session = await acquireBrowserWorkspaceConnectorSession(
      {
        provider: "x",
        accountId: "owner",
        url: "about:blank",
      },
      webEnv,
    );

    await expect(
      executeBrowserWorkspaceCommand(
        {
          id: session.tabId ?? undefined,
          subaction: "cookies",
        },
        webEnv,
      ),
    ).rejects.toThrow(/raw cookie, token, storage, or state export/);

    await expect(
      executeBrowserWorkspaceCommand(
        {
          id: session.tabId ?? undefined,
          subaction: "state",
        },
        webEnv,
      ),
    ).rejects.toThrow(/raw cookie, token, storage, or state export/);
  });
});
