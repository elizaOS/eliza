/**
 * Window lines are `head|||title|||tail`. A window title may itself contain
 * "|||" (for example a document named "a ||| b"), so the parsers must split at
 * the first and last sentinel and keep the middle as the title.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => ({ output: "", os: "darwin" }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: vi.fn(() => shell.output),
    execFileSync: vi.fn(() => shell.output),
  };
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: () => shell.os };
});
vi.mock("../platform/helpers.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../platform/helpers.js")>();
  return { ...actual, currentPlatform: () => shell.os };
});

const { getActiveWindow, splitWindowFields } = await import(
  "../platform/windows-list.js"
);
const { listDesktopWindows } = await import("../services/desktop-control.js");

describe("window title containing |||", () => {
  beforeEach(() => {
    shell.os = "darwin";
  });

  it("splits only at the first and last sentinel", () => {
    expect(splitWindowFields("Preview|||a ||| b.pdf|||42")).toEqual([
      "Preview",
      "a ||| b.pdf",
      "42",
    ]);
    expect(splitWindowFields("Finder|||Downloads|||7")).toEqual([
      "Finder",
      "Downloads",
      "7",
    ]);
    expect(splitWindowFields("Finder|||Downloads")).toEqual([
      "Finder",
      "Downloads",
      "",
    ]);
  });

  it("keeps the whole title in listDesktopWindows on macOS", () => {
    shell.output = "Preview|||a ||| b.pdf|||42\nFinder|||Downloads|||7\n";
    expect(listDesktopWindows()).toEqual([
      { app: "Preview", title: "a ||| b.pdf", id: "42" },
      { app: "Finder", title: "Downloads", id: "7" },
    ]);
  });

  it("keeps the whole title of the active macOS window", async () => {
    shell.output = "TextEdit|||notes ||| draft.txt";
    expect(await getActiveWindow()).toEqual({
      app: "TextEdit",
      title: "notes ||| draft.txt",
      id: "notes ||| draft.txt",
    });
    shell.output = "Dock|||";
    expect(await getActiveWindow()).toEqual({
      app: "Dock",
      title: "",
      id: "Dock",
    });
  });
});
