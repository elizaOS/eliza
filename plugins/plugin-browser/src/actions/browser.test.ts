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
}) {
  const service = args.service === undefined ? browserService() : args.service;
  const runtime = runtimeWithService(service);
  const result = await browserAction.handler?.(
    runtime as never,
    { content: { text: args.messageText ?? "" } } as never,
    undefined,
    { parameters: args.parameters ?? {} } as never,
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
