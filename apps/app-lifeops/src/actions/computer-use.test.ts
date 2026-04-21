/**
 * MOCK-HEAVY ROUTING TEST — this file does NOT execute any real computer-use
 * action. It verifies only the LifeOps-side routing logic that decides which
 * underlying plugin-computeruse Action to delegate to.
 *
 * Scope verified:
 *   - Request-shape heuristics route browser/file/terminal/desktop surfaces to
 *     the corresponding mock handler.
 *   - Finder aliases (`open_finder`) resolve to the desktop action.
 *   - `lifeOpsComputerUseAction.similes` advertises `FINDER` and `OPEN_FINDER`.
 *
 * How the mocking works (LARP caveat):
 *   - `@elizaos/plugin-computeruse` is mocked with five fake Actions
 *     (`USE_COMPUTER`, `BROWSER_ACTION`, `MANAGE_WINDOW`, `FILE_ACTION`,
 *     `TERMINAL_ACTION`). Every action's handler is a `vi.fn()` that returns
 *     `{ success: true, surface: ... }`.
 *   - `@elizaos/agent/security.hasOwnerAccess` is mocked to always return true.
 *   - The similes-presence assertion (line ~166) verifies the STRING
 *     `"FINDER"` exists in the array; it does NOT verify the planner/LLM
 *     actually treats that simile as an alias.
 *
 * Regressions that would slip past this file:
 *   - A real computer-use handler crashing on a valid browser request.
 *   - A permission regression where a non-owner can invoke the action.
 *   - The planner failing to pick this action for "open Finder" because of
 *     description drift (only the simile array is asserted here, not the
 *     routing prompt).
 */
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
