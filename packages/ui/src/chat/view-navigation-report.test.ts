/** Verifies the centralized rendered-view lifecycle transport. */
// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const { rawRequestMock } = vi.hoisted(() => ({
  rawRequestMock: vi.fn(),
}));

vi.mock("../api", () => ({
  client: { rawRequest: rawRequestMock },
}));

import {
  reportUserViewClosed,
  reportUserViewSwitch,
  shouldClearReportedView,
} from "./view-navigation-report";

beforeEach(() => {
  rawRequestMock.mockReset();
  rawRequestMock.mockResolvedValue(new Response("{}"));
});

describe("rendered view lifecycle reports", () => {
  it("clears only Home/catalog roots, not views rendered inside the generic shell tab", () => {
    expect(shouldClearReportedView("/")).toBe(true);
    expect(shouldClearReportedView("/chat")).toBe(true);
    expect(shouldClearReportedView("/views/")).toBe(true);
    expect(shouldClearReportedView("/views/legacy-launcher")).toBe(true);

    expect(shouldClearReportedView("/notes")).toBe(false);
    expect(shouldClearReportedView("/calendar")).toBe(false);
    expect(shouldClearReportedView("/apps")).toBe(false);
    expect(shouldClearReportedView("/apps/tasks")).toBe(false);
    expect(shouldClearReportedView("/apps/custom-plugin")).toBe(false);
  });

  it("publishes the rendered surface through the configured client transport", () => {
    reportUserViewSwitch("wallet.inventory", "/wallet");

    expect(rawRequestMock).toHaveBeenCalledWith(
      "/api/views/wallet.inventory/navigate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "user", path: "/wallet" }),
      },
      { allowNonOk: true, timeoutMs: 15_000 },
    );
  });

  it("clears all scoped capabilities on Home and launcher routes", () => {
    reportUserViewClosed();

    expect(rawRequestMock).toHaveBeenCalledWith(
      "/api/views/__all__/navigate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "user", action: "close-all" }),
      },
      { allowNonOk: true, timeoutMs: 15_000 },
    );
  });

  it("never throws when the runtime is unavailable", () => {
    rawRequestMock.mockRejectedValueOnce(new Error("offline"));
    expect(() => reportUserViewSwitch("notes", "/notes")).not.toThrow();
  });
});
