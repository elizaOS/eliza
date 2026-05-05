import type { HandlerOptions, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/agent", () => ({
  executeBrowserWorkspaceCommand: vi.fn(),
}));

const {
  parseBrowserWorkspaceActionRequest,
  manageElizaBrowserWorkspaceAction,
} = await import("../action");

function message(text: string): Memory {
  return { content: { text } } as Memory;
}

function options(parameters: Record<string, unknown>): HandlerOptions {
  return { parameters } as HandlerOptions;
}

describe("browser workspace action router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes legacy operation aliases from explicit parameters", () => {
    const parsed = parseBrowserWorkspaceActionRequest(
      message("go to the docs"),
      options({ operation: "goto", url: "https://example.com/docs" }),
    );

    expect(parsed).toMatchObject({
      subaction: "navigate",
      url: "https://example.com/docs",
    });
  });

  it("keeps locator text separate from write values", () => {
    const parsed = parseBrowserWorkspaceActionRequest(
      message("fill the email field"),
      options({
        subaction: "fill",
        by: "label",
        value: "Email",
        text: "ada@example.com",
      }),
    );

    expect(parsed).toMatchObject({
      subaction: "fill",
      findBy: "label",
      text: "Email",
      value: "ada@example.com",
    });
  });

  it("requires an explicit subaction and rejects message-text inference", () => {
    expect(
      parseBrowserWorkspaceActionRequest(
        message("open https://example.com in the browser"),
      ),
    ).toBeNull();

    const parsed = parseBrowserWorkspaceActionRequest(
      message("open https://example.com in the browser"),
      options({ subaction: "open" }),
    );

    expect(parsed).toMatchObject({
      subaction: "open",
      url: "https://example.com",
    });
  });

  it("leaves passive tab state to the provider unless refresh is explicit", async () => {
    expect(
      parseBrowserWorkspaceActionRequest(message("list the browser tabs")),
    ).toBeNull();

    await expect(
      manageElizaBrowserWorkspaceAction.validate?.(
        {} as never,
        message("list the browser tabs"),
      ),
    ).resolves.toBe(false);

    expect(
      parseBrowserWorkspaceActionRequest(
        message("list the browser tabs"),
        options({ subaction: "list" }),
      ),
    ).toMatchObject({ subaction: "list" });
  });

  it("parses batch steps from stepsJson", () => {
    const parsed = parseBrowserWorkspaceActionRequest(
      message("run these browser steps"),
      options({
        stepsJson: JSON.stringify([
          { subaction: "open", url: "https://example.com", show: true },
          { subaction: "inspect" },
        ]),
      }),
    );

    expect(parsed).toMatchObject({
      subaction: "batch",
      steps: [
        { subaction: "open", url: "https://example.com", show: true },
        { subaction: "inspect" },
      ],
    });
  });
});
