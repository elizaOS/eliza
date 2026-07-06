// @vitest-environment jsdom

/**
 * The add-credits URL builder + opener. `openExternalUrl` is stubbed (no
 * platform browser under jsdom); the boot config is driven through the real
 * store so the default-vs-configured cloud base resolution is exercised for real.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { openExternalUrlMock } = vi.hoisted(() => ({
  openExternalUrlMock: vi.fn(async () => {}),
}));

vi.mock("../utils/openExternalUrl", () => ({
  openExternalUrl: openExternalUrlMock,
}));

import { setBootConfig } from "../config/boot-config";
import {
  cloudBillingConsoleUrl,
  openCloudBillingConsole,
} from "./billing-console";

afterEach(() => {
  openExternalUrlMock.mockClear();
});

describe("cloudBillingConsoleUrl", () => {
  it("builds the console URL from an explicit cloud base", () => {
    expect(cloudBillingConsoleUrl("https://elizacloud.ai")).toBe(
      "https://elizacloud.ai/dashboard/billing",
    );
  });

  it("trims a trailing slash so the path never doubles up", () => {
    expect(cloudBillingConsoleUrl("https://api.elizacloud.ai/")).toBe(
      "https://api.elizacloud.ai/dashboard/billing",
    );
  });

  it("falls back to the configured cloud base from boot config", () => {
    setBootConfig({
      branding: {},
      cloudApiBase: "https://staging.elizacloud.ai",
    });
    expect(cloudBillingConsoleUrl()).toBe(
      "https://staging.elizacloud.ai/dashboard/billing",
    );
  });

  it("defaults to elizacloud.ai when no base is configured", () => {
    setBootConfig({ branding: {}, cloudApiBase: undefined });
    expect(cloudBillingConsoleUrl()).toBe(
      "https://elizacloud.ai/dashboard/billing",
    );
  });
});

describe("openCloudBillingConsole", () => {
  it("opens the resolved console URL via the platform opener", async () => {
    await openCloudBillingConsole("https://elizacloud.ai");
    expect(openExternalUrlMock).toHaveBeenCalledWith(
      "https://elizacloud.ai/dashboard/billing",
    );
  });
});
