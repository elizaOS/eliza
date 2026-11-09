import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { BrowserService, browserAction } from "./mobile.ts";
import {
  observedNativeHistorySelection,
  parseNativeHistoryCommand,
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
