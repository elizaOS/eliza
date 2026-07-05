// @vitest-environment jsdom
//
// Real error-path coverage for the sidebar catalog load in AppsSection
// (issue #12267): a failed `loadMergedCatalogApps()` used to be swallowed by
// `.catch(() => undefined)`, leaving an empty catalog indistinguishable from a
// genuinely empty one (view-audit §6.D). The failure now logs at error while
// the section still degrades to running/favorited apps. State + catalog-loader
// mocked; logger spied.

import { logger } from "@elizaos/logger";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadMergedCatalogApps: vi.fn(),
  store: {
    favoriteApps: [] as unknown[],
    appRuns: [] as unknown[],
    setTab: vi.fn(),
    setState: vi.fn(),
    setActionNotice: vi.fn(),
    t: (s: string) => s,
  },
}));

vi.mock("../apps/catalog-loader", () => ({
  loadMergedCatalogApps: mocks.loadMergedCatalogApps,
}));
vi.mock("../../state", () => ({
  useAppSelectorShallow: (sel: (s: unknown) => unknown) => sel(mocks.store),
}));

import { AppsSection } from "./AppsSection";

const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

beforeEach(() => {
  mocks.loadMergedCatalogApps.mockReset();
  warnSpy.mockReset();
});

describe("AppsSection — catalog load failure surfaces", () => {
  it("logs when the catalog load rejects rather than silently emptying", async () => {
    mocks.loadMergedCatalogApps.mockRejectedValue(new Error("catalog 500"));

    render(<AppsSection />);

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
    expect(warnSpy.mock.calls[0]?.[1]).toContain("catalog load failed");
  });

  it("does not log when the catalog load succeeds", async () => {
    mocks.loadMergedCatalogApps.mockResolvedValue([]);

    render(<AppsSection />);

    // Give the effect a tick to settle.
    await waitFor(() => {
      expect(mocks.loadMergedCatalogApps).toHaveBeenCalled();
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
