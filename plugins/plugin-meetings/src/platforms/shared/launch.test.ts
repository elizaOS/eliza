import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright-core";
import { launchMeetingBrowser } from "./launch.js";

vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true) }));

/** Minimal Browser/context/page stubs so launch can run without a real browser. */
function stubBrowser(): Browser {
  const page = {
    on: vi.fn(),
  };
  const context = {
    addInitScript: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    version: () => "141.0.7340.0",
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Browser;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(existsSync).mockReturnValue(true);
  delete process.env.ELIZA_MEETINGS_HEADLESS;
  delete process.env.ELIZA_MEETINGS_CHROMIUM_PATH;
});

describe("launchMeetingBrowser headless + executable wiring", () => {
  it("passes an explicit headless option straight through to chromium.launch", async () => {
    const launch = vi.spyOn(chromium, "launch").mockResolvedValue(stubBrowser());
    vi.spyOn(chromium, "executablePath").mockReturnValue("/pw/chromium");

    await launchMeetingBrowser({ headless: true });

    expect(launch).toHaveBeenCalledTimes(1);
    const arg = launch.mock.calls[0][0];
    expect(arg?.headless).toBe(true);
    expect(arg?.executablePath).toBe("/pw/chromium");
  });

  it("resolves headless from ELIZA_MEETINGS_HEADLESS when no option is given", async () => {
    process.env.ELIZA_MEETINGS_HEADLESS = "true";
    const launch = vi.spyOn(chromium, "launch").mockResolvedValue(stubBrowser());
    vi.spyOn(chromium, "executablePath").mockReturnValue("/pw/chromium");

    await launchMeetingBrowser({});

    expect(launch.mock.calls[0][0]?.headless).toBe(true);
  });

  it("honors the chromium path override and the requested channel", async () => {
    process.env.ELIZA_MEETINGS_CHROMIUM_PATH = "/opt/edge";
    const launch = vi.spyOn(chromium, "launch").mockResolvedValue(stubBrowser());

    await launchMeetingBrowser({ channel: "msedge", headless: false });

    const arg = launch.mock.calls[0][0];
    expect(arg?.executablePath).toBe("/opt/edge");
    // Override wins over channel: no channel is passed when a binary is known.
    expect(arg?.channel).toBeUndefined();
    expect(arg?.headless).toBe(false);
  });
});
