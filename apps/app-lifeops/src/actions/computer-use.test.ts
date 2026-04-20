import type { Action, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const desktopHandler = vi.fn(async () => ({ success: true, surface: "desktop" }));
const browserHandler = vi.fn(async () => ({ success: true, surface: "browser" }));
const windowHandler = vi.fn(async () => ({ success: true, surface: "window" }));
const fileHandler = vi.fn(async () => ({ success: true, surface: "file" }));
const terminalHandler = vi.fn(async () => ({ success: true, surface: "terminal" }));

const pluginActions: Action[] = [
  {
    name: "USE_COMPUTER",
    similes: [],
    description: "",
    validate: vi.fn(async () => true),
    handler: desktopHandler,
  },
  {
    name: "BROWSER_ACTION",
    similes: [],
    description: "",
    validate: vi.fn(async () => true),
    handler: browserHandler,
  },
  {
    name: "MANAGE_WINDOW",
    similes: [],
    description: "",
    validate: vi.fn(async () => true),
    handler: windowHandler,
  },
  {
    name: "FILE_ACTION",
    similes: [],
    description: "",
    validate: vi.fn(async () => true),
    handler: fileHandler,
  },
  {
    name: "TERMINAL_ACTION",
    similes: [],
    description: "",
    validate: vi.fn(async () => true),
    handler: terminalHandler,
  },
] as Action[];

vi.mock("@elizaos/agent/security", () => ({
  hasOwnerAccess: vi.fn(async () => true),
}));

vi.mock("@elizaos/plugin-computeruse", () => ({
  default: { actions: pluginActions },
  computerUsePlugin: { actions: pluginActions },
}));

describe("lifeOpsComputerUseAction", () => {
  beforeEach(() => {
    desktopHandler.mockClear();
    browserHandler.mockClear();
    windowHandler.mockClear();
    fileHandler.mockClear();
    terminalHandler.mockClear();
  });

  it("routes browser-shaped requests to the browser action", async () => {
    const { lifeOpsComputerUseAction } = await import("./computer-use.js");

    const result = await lifeOpsComputerUseAction.handler(
      {} as never,
      {
        content: {
          action: "navigate",
          url: "https://example.com",
        },
      } as Memory,
      undefined,
      undefined,
      undefined,
    );

    expect(browserHandler).toHaveBeenCalledTimes(1);
    expect(desktopHandler).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, surface: "browser" });
  });

  it("routes file-shaped requests to the file action", async () => {
    const { lifeOpsComputerUseAction } = await import("./computer-use.js");

    const result = await lifeOpsComputerUseAction.handler(
      {} as never,
      {
        content: {
          action: "read",
          path: "/tmp/example.txt",
        },
      } as Memory,
      undefined,
      undefined,
      undefined,
    );

    expect(fileHandler).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, surface: "file" });
  });

  it("routes terminal-shaped requests to the terminal action", async () => {
    const { lifeOpsComputerUseAction } = await import("./computer-use.js");

    const result = await lifeOpsComputerUseAction.handler(
      {} as never,
      {
        content: {
          action: "execute",
          command: "pwd",
        },
      } as Memory,
      undefined,
      undefined,
      undefined,
    );

    expect(terminalHandler).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, surface: "terminal" });
  });

  it("falls back to the desktop action when the request is ambiguous", async () => {
    const { lifeOpsComputerUseAction } = await import("./computer-use.js");

    const result = await lifeOpsComputerUseAction.handler(
      {} as never,
      {
        content: {
          text: "Take a screenshot of my desktop",
        },
      } as Memory,
      undefined,
      undefined,
      undefined,
    );

    expect(desktopHandler).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, surface: "desktop" });
  });

  it("routes Finder aliases to the desktop action", async () => {
    const { lifeOpsComputerUseAction } = await import("./computer-use.js");

    const result = await lifeOpsComputerUseAction.handler(
      {} as never,
      {
        content: {
          command: "open_finder",
        },
      } as Memory,
      undefined,
      undefined,
      undefined,
    );

    expect(desktopHandler).toHaveBeenCalledTimes(1);
    expect(terminalHandler).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, surface: "desktop" });
  });

  it("advertises Finder as a planner alias", async () => {
    const { lifeOpsComputerUseAction } = await import("./computer-use.js");

    expect(lifeOpsComputerUseAction.similes).toContain("FINDER");
    expect(lifeOpsComputerUseAction.similes).toContain("OPEN_FINDER");
  });
});
