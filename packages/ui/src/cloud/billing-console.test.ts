/** Verifies cloudBillingConsoleUrl through the package's configured test harness. */
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
  openCloudAgentConsole,
  openCloudBillingConsole,
} from "./billing-console";

afterEach(() => {
  openExternalUrlMock.mockClear();
});

describe("cloudBillingConsoleUrl", () => {
  it("builds the console URL from an explicit cloud base", () => {
    expect(cloudBillingConsoleUrl("https://elizacloud.ai")).toBe(
      "https://cloud.eliza.app/cloud/billing",
    );
  });

  it("trims a trailing slash so the path never doubles up", () => {
    expect(cloudBillingConsoleUrl("https://api.elizacloud.ai/")).toBe(
      "https://cloud.eliza.app/cloud/billing",
    );
  });

  it("falls back to the configured cloud base from boot config", () => {
    setBootConfig({
      branding: {},
      cloudApiBase: "https://staging.elizacloud.ai",
    });
    expect(cloudBillingConsoleUrl()).toBe(
      "https://cloud-staging.eliza.app/cloud/billing",
    );
  });

  it("defaults to the canonical production Cloud app", () => {
    setBootConfig({ branding: {}, cloudApiBase: undefined });
    expect(cloudBillingConsoleUrl()).toBe(
      "https://cloud.eliza.app/cloud/billing",
    );
  });
});

describe("openCloudBillingConsole", () => {
  it("opens the existing agent's management page through the platform browser", async () => {
    await openCloudAgentConsole("agent-123", "https://staging.elizacloud.ai");
    expect(openExternalUrlMock).toHaveBeenCalledWith(
      "https://cloud-staging.eliza.app/cloud/agents/agent-123",
    );
  });
  it("opens the personal card instead of a rowless identity's unsupported detail route", async () => {
    await openCloudAgentConsole(
      "personal:00000000-0000-5000-8000-000000000001",
      "https://staging.elizacloud.ai",
    );
    expect(openExternalUrlMock).toHaveBeenCalledWith(
      "https://cloud-staging.eliza.app/cloud/agents",
    );
  });
  it("opens the resolved console URL via the platform opener", async () => {
    await openCloudBillingConsole("https://elizacloud.ai");
    expect(openExternalUrlMock).toHaveBeenCalledWith(
      "https://cloud.eliza.app/cloud/billing",
    );
  });
});
