import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserDispatchFailure,
  BrowserService,
  browserAction,
  nativeBrowserAction,
  nativeBrowserCommands,
} from "./mobile.ts";
import {
  observedNativeHistorySelection,
  parseNativeHistoryCommand,
  withheldPageReloadRefusal,
} from "./native-client-command.ts";

const browserTurn = (selectedObject: Record<string, unknown>) => ({
  content: {
    text: "go back",
    metadata: {
      viewClientId: "phone-client",
      clientDevice: {
        context: {
          view: "browser",
          revision: 7,
          sensitive: false,
          selectedObject,
        },
      },
    },
  },
});

describe("parseNativeHistoryCommand", () => {
  it("parses a history command without a selection as before", () => {
    expect(parseNativeHistoryCommand({ subaction: "back" })).toEqual({
      subaction: "back",
    });
    expect(() =>
      parseNativeHistoryCommand({ subaction: "back", id: "tab-1" }),
    ).toThrow("without server tab IDs");
    expect(() => parseNativeHistoryCommand({ subaction: "open" })).toThrow();
  });

  it("carries the observed selection and refuses unknown or malformed keys", () => {
    expect(
      parseNativeHistoryCommand(
        { subaction: "reload" },
        { id: "session-1:tab-2", revision: "4", navigation: "9" },
      ),
    ).toEqual({
      subaction: "reload",
      selection: { id: "session-1:tab-2", revision: "4", navigation: "9" },
    });
    expect(
      parseNativeHistoryCommand(
        { subaction: "forward" },
        { id: "session-1:tab-2", revision: "4" },
      ),
    ).toEqual({
      subaction: "forward",
      selection: { id: "session-1:tab-2", revision: "4" },
    });
    for (const selection of [
      null,
      [],
      { id: "session-1:tab-2" },
      { id: "session-1:tab-2", revision: 4 },
      { id: "session-1:tab-2", revision: "4", url: "https://example.com" },
      { id: "https://example.com/a b", revision: "4" },
    ])
      expect(() =>
        parseNativeHistoryCommand({ subaction: "back" }, selection),
      ).toThrow("Browser selection is invalid");
  });
});

describe("observedNativeHistorySelection", () => {
  it("copies the turn's browser tab only for history commands", () => {
    const turn = browserTurn({
      kind: "browser-tab",
      id: "session-1:tab-2",
      revision: "4",
    });
    expect(observedNativeHistorySelection(turn, "back")).toEqual({
      id: "session-1:tab-2",
      revision: "4",
    });
    expect(observedNativeHistorySelection(turn, "click")).toBeUndefined();
    // Ids follow the observation contract's 512-character bound.
    const longId = `tab-${"a".repeat(400)}`;
    expect(
      observedNativeHistorySelection(
        browserTurn({ kind: "browser-tab", id: longId, revision: "4" }),
        "back",
      ),
    ).toEqual({ id: longId, revision: "4" });
    expect(
      parseNativeHistoryCommand(
        { subaction: "back" },
        { id: longId, revision: "4" },
      ).selection,
    ).toEqual({ id: longId, revision: "4" });
    expect(
      observedNativeHistorySelection(
        browserTurn({ kind: "note", id: "n1", revision: "1" }),
        "back",
      ),
    ).toBeUndefined();
    expect(
      observedNativeHistorySelection({ content: { text: "back" } }, "back"),
    ).toBeUndefined();
  });

  it("forwards the observed tab from the BROWSER action to the native transport", async () => {
    const service = new BrowserService();
    const executeCommand = vi.fn(async () => ({
      targetId: "native-client",
      mode: "web" as const,
      subaction: "back" as const,
      value: { dispatched: true },
    }));
    service.setNativeClientTransport({
      readPage: async () => ({}),
      navigate: async () => undefined,
      executeCommand,
    });
    const runtime = {
      getService: () => service,
    } as unknown as IAgentRuntime;
    const result = await browserAction.handler?.(
      runtime,
      browserTurn({
        kind: "browser-tab",
        id: "session-1:tab-2",
        revision: "4",
      }) as never,
      undefined,
      { parameters: { action: "back" } } as never,
    );
    expect(result).toMatchObject({ success: true });
    expect(executeCommand).toHaveBeenCalledWith(
      "phone-client",
      { subaction: "back" },
      { id: "session-1:tab-2", revision: "4" },
    );
  });
});

describe("host-declared native browser commands", () => {
  it("offers every command when the host declares none", () => {
    expect(nativeBrowserCommands(undefined)).toContain("snapshot");
    // A variable cleared to blank is unset, never an empty command list.
    for (const blank of ["", "  ", " , "])
      expect(nativeBrowserCommands(blank)).toEqual(
        nativeBrowserCommands(undefined),
      );
    expect(
      browserAction.parameters?.map((parameter) => parameter.name),
    ).toEqual(["id", "action", "url", "selector", "text", "direction"]);
  });

  it("offers the model only the commands the host's renderer runs", async () => {
    const commands = nativeBrowserCommands(" back, forward ,reload");
    expect(commands).toEqual(["back", "forward", "reload"]);
    const action = nativeBrowserAction(commands);
    expect(action.parameters).toEqual([
      {
        name: "action",
        required: true,
        description: "Native browser command",
        schema: { type: "string", enum: ["back", "forward", "reload"] },
      },
    ]);
    expect(action.description).toContain("back, forward, reload");
    for (const absent of ["snapshot", "click", "Chromium"])
      expect(action.description).not.toContain(absent);
    const execute = vi.fn();
    const result = await action.handler?.(
      { getService: () => ({ execute }) } as unknown as IAgentRuntime,
      browserTurn({ kind: "browser-tab", id: "t", revision: "1" }) as never,
      undefined,
      { parameters: { action: "close" } } as never,
    );
    expect(result).toMatchObject({ success: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a command name it does not know", () => {
    expect(() => nativeBrowserCommands("back,teleport")).toThrow("teleport");
  });
});

describe("dispatch-only native command results", () => {
  const dispatchOnly = (
    subaction: "reload" | "back" | "click" | "fill" | "scroll" | "close",
  ) => ({
    targetId: "native-client",
    mode: "web" as const,
    subaction,
    value: { dispatched: true, completed: false, requiresReadback: true },
  });
  const runWith = async (
    commands: ReturnType<typeof nativeBrowserCommands>,
    parameters: Record<string, unknown>,
    execute: (...args: unknown[]) => Promise<unknown>,
  ) =>
    nativeBrowserAction(commands).handler?.(
      { getService: () => ({ execute }) } as unknown as IAgentRuntime,
      browserTurn({ kind: "browser-tab", id: "t", revision: "1" }) as never,
      undefined,
      { parameters } as never,
    );

  it("owns an honest reply and a typed dispatch marker without asking for an impossible readback", async () => {
    const result = await runWith(
      nativeBrowserCommands("back,forward,reload"),
      { action: "reload" },
      async () => dispatchOnly("reload"),
    );
    const expected = {
      ...dispatchOnly("reload"),
      value: { dispatched: true, completed: false, requiresReadback: false },
    };
    expect(result).toEqual({
      success: true,
      text: JSON.stringify(expected),
      userFacingText:
        "I asked the browser to reload the page. It may still be loading.",
      verifiedUserFacing: true,
      turnComplete: true,
      data: {
        actionName: "BROWSER",
        executionStatus: "dispatched",
        result: expected,
      },
    });
    expect(result).not.toHaveProperty("effectReceipts");
  });

  it("keeps the readback request when the host can read the page", async () => {
    const result = await runWith(
      nativeBrowserCommands(undefined),
      { action: "back" },
      async () => dispatchOnly("back"),
    );
    expect(result).toMatchObject({
      success: true,
      userFacingText:
        "I asked the browser to go back. The previous page may still be loading.",
      data: {
        executionStatus: "dispatched",
        result: dispatchOnly("back"),
      },
    });
  });

  it.each(["click", "fill", "scroll", "close"] as const)(
    "returns a dispatched %s exactly as an ordinary result",
    async (subaction) => {
      // A page interaction can submit or change something on the site, so its
      // dispatch receipt keeps the receipt guard instead of a tool-owned finish.
      const dispatched = dispatchOnly(subaction);
      const result = await runWith(
        nativeBrowserCommands("back,forward,reload,click,fill,scroll,close"),
        { action: subaction },
        async () => dispatched,
      );
      expect(result).toEqual({
        success: true,
        text: JSON.stringify(dispatched),
        data: { actionName: "BROWSER", result: dispatched },
      });
    },
  );

  it("leaves completed and read results unchanged", async () => {
    const read = {
      targetId: "native-client",
      mode: "web" as const,
      subaction: "get" as const,
      value: { url: "https://example.com", title: "Example", text: "hi" },
    };
    const result = await runWith(
      nativeBrowserCommands(undefined),
      { action: "get" },
      async () => read,
    );
    expect(result).toEqual({
      success: true,
      text: JSON.stringify(read),
      data: { actionName: "BROWSER", result: read },
    });
  });

  it("still reports a failed native command as a failure", async () => {
    const result = await runWith(
      nativeBrowserCommands("back,forward,reload"),
      { action: "reload" },
      async () => {
        throw new BrowserDispatchFailure(
          "UNAVAILABLE",
          "Connect the requesting native browser client.",
        );
      },
    );
    expect(result).toMatchObject({
      success: false,
      text: "Connect the requesting native browser client.",
      data: {
        actionName: "BROWSER",
        dispatchFailure: { kind: "UNAVAILABLE" },
      },
    });
    expect(result).not.toHaveProperty("userFacingText");
    expect(result?.data).not.toHaveProperty("executionStatus");
  });
});

// Pixel, 2026-11-23: the WebView could not read the page, and "summarize this
// page in two sentences" was answered "I asked the browser to reload the
// page." A reload never makes the page readable and can resubmit a form.
describe("a reload on a page the phone withheld", () => {
  const page = {
    tabId: "session-1:tab-2",
    revision: "4",
    url: "https://news.example.com/story?id=42",
    title: "Octopus study",
    capturedAt: 1,
  };
  const turn = (text: string, browserPage: Record<string, unknown>) => {
    const message = browserTurn({
      kind: "browser-tab",
      id: "session-1:tab-2",
      revision: "4",
    });
    message.content.text = text;
    Object.assign(message.content.metadata.clientDevice, { browserPage });
    return message;
  };
  const unreadable = { ...page, withheld: "unreadable" };
  const reloaded = {
    targetId: "native-client",
    mode: "web" as const,
    subaction: "reload" as const,
    value: { dispatched: true, completed: false, requiresReadback: true },
  };
  const run = async (
    message: ReturnType<typeof turn>,
    parameters: Record<string, unknown>,
  ) => {
    const execute = vi.fn(async () => reloaded);
    const result = await nativeBrowserAction(
      nativeBrowserCommands(undefined),
    ).handler?.(
      {
        character: { name: "Alpha" },
        getService: () => ({ execute }),
      } as unknown as IAgentRuntime,
      message as never,
      undefined,
      { parameters } as never,
    );
    return { result, execute };
  };

  it("refuses a reload the owner did not ask for, before dispatch, saying why", async () => {
    for (const withheld of [
      unreadable,
      { ...page, withheld: "sensitive-page" },
    ]) {
      const { result, execute } = await run(
        turn("summarize this page in two sentences", withheld),
        { action: "reload" },
      );
      expect(result).toMatchObject({
        success: false,
        data: {
          actionName: "BROWSER",
          code: "BROWSER_PAGE_WITHHELD",
          executed: false,
        },
      });
      expect(result?.text).toContain("Not reloaded");
      expect(result?.text).toContain("does not change that");
      expect(result?.text).toContain("Answer the owner instead");
      expect(result).not.toHaveProperty("userFacingText");
      expect(execute).not.toHaveBeenCalled();
    }
    expect(
      (
        await run(turn("summarize this page", unreadable), {
          action: "reload",
        })
      ).result?.text,
    ).toContain("the phone cannot read this page's text");
  });

  it.each([
    "Reload this page. Actually, don't reload it.",
    "Reload this page. Actually, don't.",
    "Reload this page. Never mind.",
    "Reload this page. Actually, don't. Tell me the time.",
  ])("honors the owner's retraction before dispatching: %s", async (text) => {
    const { result, execute } = await run(turn(text, unreadable), {
      action: "reload",
    });
    expect(result).toMatchObject({
      success: false,
      data: { code: "BROWSER_PAGE_WITHHELD", executed: false },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses reopening the same page the owner did not ask for", async () => {
    for (const url of [
      "https://news.example.com/story?id=42",
      "https://news.example.com/story?id=42#top",
    ]) {
      const { result, execute } = await run(
        turn("what does this page say?", unreadable),
        { action: "navigate", url },
      );
      expect(result).toMatchObject({
        success: false,
        data: { code: "BROWSER_PAGE_WITHHELD" },
      });
      expect(execute).not.toHaveBeenCalled();
    }
    // Another address is not this policy's business.
    expect(
      withheldPageReloadRefusal(turn("what does this page say?", unreadable), {
        subaction: "navigate",
        url: "https://other.example/",
      }),
    ).toBeUndefined();
    for (const text of [
      `Please summarize ${page.url} in two sentences.`,
      "reload this page",
      `open ${page.url}#details`,
      `Alpha, can you open ${page.url}?`,
    ]) {
      const { result, execute } = await run(turn(text, unreadable), {
        action: "navigate",
        url: page.url,
      });
      expect(result).toMatchObject({
        success: false,
        data: { code: "BROWSER_PAGE_WITHHELD", executed: false },
      });
      expect(execute).not.toHaveBeenCalled();
    }
    for (const text of [
      `open ${page.url}`,
      `Alpha, can you open ${page.url}`,
    ]) {
      const { result, execute } = await run(turn(text, unreadable), {
        action: "navigate",
        url: page.url,
      });
      expect(result).toMatchObject({ success: true });
      expect(execute).toHaveBeenCalledTimes(1);
    }
  });

  it("opens the matching withheld page when the owner dictates its address", async () => {
    const dictatedPage = { ...unreadable, url: "https://alphacompute.ai/" };
    const { result, execute } = await run(
      turn(
        "Can you open alphacompute. AI in the browser, please?",
        dictatedPage,
      ),
      { action: "navigate", url: dictatedPage.url },
    );
    expect(result).toMatchObject({ success: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("still reloads when the owner asks for it", async () => {
    for (const text of ["reload this page", "Refresh", "can you refresh it?"]) {
      const { result, execute } = await run(turn(text, unreadable), {
        action: "reload",
      });
      expect(result).toMatchObject({
        success: true,
        userFacingText:
          "I asked the browser to reload the page. It may still be loading.",
      });
      expect(execute).toHaveBeenCalledTimes(1);
    }
  });

  it("changes nothing on a readable page", async () => {
    const { result, execute } = await run(
      turn("summarize this page in two sentences", {
        ...page,
        text: "Octopuses can taste with their arms.",
      }),
      { action: "reload" },
    );
    expect(result).toMatchObject({ success: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
