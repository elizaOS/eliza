import type { HandlerCallback } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { BROWSER_SERVICE_TYPE } from "../browser-service.js";
import { browserAction } from "./browser.js";

function runtimeWithService(service: unknown) {
  return {
    getService: vi.fn((type: string) =>
      type === BROWSER_SERVICE_TYPE ? service : null,
    ),
  };
}

function browserService(result: Record<string, unknown> = {}) {
  return {
    execute: vi.fn(async (command) => ({
      mode: "workspace",
      subaction: command.subaction,
      ...result,
    })),
  };
}

async function runBrowserAction(args: {
  parameters?: Record<string, unknown>;
  messageText?: string;
  service?: ReturnType<typeof browserService> | null;
  callback?: HandlerCallback;
}) {
  const service = args.service === undefined ? browserService() : args.service;
  const runtime = runtimeWithService(service);
  const result = await browserAction.handler?.(
    runtime as never,
    { content: { text: args.messageText ?? "" } } as never,
    undefined,
    { parameters: args.parameters ?? {} } as never,
    args.callback,
  );
  return { result, runtime, service };
}

describe("BROWSER action", () => {
  it("normalizes legacy action aliases and forwards target overrides", async () => {
    const service = browserService({
      tabs: [
        { title: "Docs", url: "https://docs.example" },
        { title: "App", url: "https://app.example" },
      ],
    });

    const { result } = await runBrowserAction({
      service,
      parameters: {
        action: "list_tabs",
        target: "bridge",
      },
    });

    expect(service.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        subaction: "tab",
        tabAction: "list",
      }),
      "bridge",
    );
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        text: "Browser tabs (workspace):\n- Docs (https://docs.example)\n- App (https://app.example)",
        values: {
          success: true,
          mode: "workspace",
          subaction: "tab",
        },
      }),
    );
  });

  it("infers open from URLs in message text", async () => {
    const service = browserService({
      tab: { title: "Example", url: "https://example.com/path" },
    });

    const { result } = await runBrowserAction({
      service,
      messageText: "Open https://example.com/path please",
    });

    expect(service.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        subaction: "open",
        url: "https://example.com/path",
      }),
      undefined,
    );
    expect(result?.data.command).toEqual(
      expect.objectContaining({
        subaction: "open",
        url: "https://example.com/path",
      }),
    );
    expect(result?.text).toBe(
      "open completed in workspace mode.\nExample\nhttps://example.com/path",
    );
  });

  it("emits compact progress when streamProgress is true", async () => {
    const service = browserService({
      tab: { title: "Example", url: "https://example.com" },
    });
    const callback = vi.fn(async () => []);

    await runBrowserAction({
      service,
      callback,
      parameters: {
        action: "open",
        url: "https://example.com",
        streamProgress: true,
        rationale: "checking example",
      },
    });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Step 1: open — checking example",
        source: "action_progress",
        merge: "replace",
        metadata: {
          transient: true,
          compactProgress: true,
          progress: {
            source: "browser",
            actionName: "BROWSER",
            step: 1,
            kind: "open",
            rationale: "checking example",
            success: true,
            error: undefined,
          },
        },
      }),
      "BROWSER",
    );
  });

  it("does not fail the browser action when compact progress delivery fails", async () => {
    const callback = vi.fn(async () => {
      throw new Error("telegram edit failed");
    });

    const { result } = await runBrowserAction({
      callback,
      parameters: {
        action: "state",
        streamProgress: true,
      },
    });

    expect(result.success).toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("keeps compact progress behind the streamProgress flag", async () => {
    const callback = vi.fn(async () => []);

    await runBrowserAction({
      callback,
      parameters: {
        action: "state",
      },
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it("uses navigate instead of open when a URL and tab id are present", async () => {
    const service = browserService({
      tab: { title: "Example", url: "https://example.com" },
    });

    await runBrowserAction({
      service,
      parameters: {
        id: "tab-1",
        url: "https://example.com",
      },
    });

    expect(service.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "tab-1",
        subaction: "navigate",
        url: "https://example.com",
      }),
      undefined,
    );
  });

  it("selects realistic click and fill commands in watch mode", async () => {
    const service = browserService({ value: { x: 10, y: 20 } });

    await runBrowserAction({
      service,
      parameters: {
        selector: "#submit",
        watchMode: true,
        cursorDurationMs: 120,
      },
    });
    await runBrowserAction({
      service,
      parameters: {
        selector: "#email",
        text: "owner@example.com",
        watchMode: true,
        perCharDelayMs: 10,
        replace: true,
      },
    });

    expect(service.execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        subaction: "realistic-click",
        selector: "#submit",
        cursorDurationMs: 120,
      }),
      undefined,
    );
    expect(service.execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        subaction: "realistic-fill",
        selector: "#email",
        text: "owner@example.com",
        value: "owner@example.com",
        perCharDelayMs: 10,
        replace: true,
      }),
      undefined,
    );
  });

  it("formats value, snapshot, cursor, and close results", async () => {
    const valueService = browserService({ value: { ok: true } });
    const snapshotService = browserService({ snapshot: { data: "base64" } });
    const closeService = browserService({ closed: true });
    const cursorService = browserService({ value: { x: 10.4, y: 20.6 } });

    await expect(
      runBrowserAction({
        service: valueService,
        parameters: { action: "state" },
      }),
    ).resolves.toMatchObject({
      result: {
        text: 'Browser state result (workspace):\n{\n  "ok": true\n}',
      },
    });
    await expect(
      runBrowserAction({
        service: snapshotService,
        parameters: { action: "screenshot" },
      }),
    ).resolves.toMatchObject({
      result: {
        text: "Browser screenshot captured a preview in workspace mode.",
      },
    });
    await expect(
      runBrowserAction({
        service: closeService,
        parameters: { action: "close" },
      }),
    ).resolves.toMatchObject({
      result: {
        text: "Browser closed (workspace).",
      },
    });
    await expect(
      runBrowserAction({
        service: cursorService,
        parameters: { action: "cursor_move", x: 10.4, y: 20.6 },
      }),
    ).resolves.toMatchObject({
      result: {
        text: "Cursor moved to (10, 21) in workspace mode.",
      },
    });
  });

  it("wait_for_url opens the url, streams a watch status, and resolves on match", async () => {
    // open → tab; get url → matching url on the first poll.
    const service = {
      execute: vi.fn(async (command: { subaction: string }) => {
        if (command.subaction === "open") {
          return {
            mode: "workspace",
            subaction: "open",
            tab: {
              id: "tab-9",
              title: "OAuth",
              url: "https://gh.example/oauth",
            },
          };
        }
        if (command.subaction === "get") {
          return {
            mode: "workspace",
            subaction: "get",
            value: "https://gh.example/callback?code=abc",
          };
        }
        return { mode: "workspace", subaction: command.subaction };
      }),
    };
    const runtime = runtimeWithService(service);
    const callback = vi.fn(async () => []);

    const result = await browserAction.handler?.(
      runtime as never,
      { content: { text: "" } } as never,
      undefined,
      {
        parameters: {
          action: "wait_for_url",
          url: "https://gh.example/oauth",
          pattern: "callback?code=",
          timeoutMs: 5_000,
          pollIntervalMs: 100,
        },
      } as never,
      callback as never,
    );

    // Opened the starting url, then polled the current url.
    expect(service.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        subaction: "open",
        url: "https://gh.example/oauth",
      }),
      undefined,
    );
    // First callback is the "I opened X, watching" message.
    expect(callback.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("watching"),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        values: expect.objectContaining({
          success: true,
          subaction: "wait_for_url",
          status: "matched",
          matched: true,
        }),
      }),
    );
    expect(result?.text).toContain("callback?code=abc");
  });

  it("wait_for_url falls back to tab-list URLs when get/state cannot read an unloaded page", async () => {
    let listPolls = 0;
    const service = {
      execute: vi.fn(async (command: { id?: string; subaction: string }) => {
        if (command.subaction === "open") {
          return {
            mode: "workspace",
            subaction: "open",
            tab: {
              id: "tab-10",
              title: "OAuth",
              url: "https://gh.example/oauth",
            },
          };
        }
        if (command.subaction === "get") {
          throw new Error("page is still loading");
        }
        if (command.subaction === "state") {
          return { mode: "workspace", subaction: "state" };
        }
        if (command.subaction === "list") {
          listPolls += 1;
          return {
            mode: "workspace",
            subaction: "list",
            tabs: [
              {
                id: "tab-10",
                title: "OAuth",
                url:
                  listPolls >= 2
                    ? "https://gh.example/callback?code=abc"
                    : "https://gh.example/oauth",
              },
            ],
          };
        }
        return { mode: "workspace", subaction: command.subaction };
      }),
    };
    const runtime = runtimeWithService(service);
    const callback = vi.fn(async () => []);

    const result = await browserAction.handler?.(
      runtime as never,
      { content: { text: "" } } as never,
      undefined,
      {
        parameters: {
          action: "wait_for_url",
          url: "https://gh.example/oauth",
          pattern: "callback?code=",
          timeoutMs: 1_000,
          pollIntervalMs: 50,
        },
      } as never,
      callback as never,
    );

    expect(service.execute).toHaveBeenCalledWith(
      expect.objectContaining({ subaction: "list" }),
      undefined,
    );
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("still waiting"),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          outcome: expect.objectContaining({
            lastUrl: "https://gh.example/callback?code=abc",
            matched: true,
          }),
        }),
      }),
    );
  });

  it("wait_for_url fails fast when no pattern is supplied", async () => {
    const service = browserService();
    const runtime = runtimeWithService(service);

    const result = await browserAction.handler?.(
      runtime as never,
      { content: { text: "" } } as never,
      undefined,
      { parameters: { action: "wait_for_url" } } as never,
      (async () => []) as never,
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        values: expect.objectContaining({
          error: "BROWSER_WAIT_FOR_URL_NO_PATTERN",
        }),
      }),
    );
    expect(service.execute).not.toHaveBeenCalled();
  });

  it("returns a structured failure when no service or workspace backend can execute", async () => {
    const { result } = await runBrowserAction({
      service: null,
      parameters: { action: "state" },
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        values: {
          success: false,
          error: "BROWSER_FAILED",
        },
        data: expect.objectContaining({
          actionName: "BROWSER",
          command: expect.objectContaining({ subaction: "state" }),
        }),
      }),
    );
    expect(result?.text).toMatch(/^Browser action failed:/);
  });
});

describe("BROWSER routing hint (#12209)", () => {
  it("states its planner boundary versus WEB_FETCH, WEB_SEARCH, and COMPUTER_USE", () => {
    const hint = browserAction.routingHint ?? "";
    expect(hint).toContain("BROWSER");
    expect(hint).toContain("WEB_FETCH");
    expect(hint).toContain("WEB_SEARCH");
    expect(hint).toContain("COMPUTER_USE");
  });
});
