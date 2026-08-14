/**
 * Mounts the authenticated join page at the canonical production auth origin
 * and proves its app-host handoff preserves /join before any provisioning.
 */
// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://eliza.app/join"}

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appModeNavigation } from "../app-mode/app-mode";

const { runJoinFlowMock } = vi.hoisted(() => ({
  runJoinFlowMock: vi.fn(),
}));

vi.mock("./lib/use-join-session", () => ({
  useJoinSessionAuth: () => ({ ready: true, authenticated: true }),
}));

vi.mock("./lib/run-join-flow", () => ({
  runJoinFlow: runJoinFlowMock,
}));

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? "",
}));

import JoinPage from "./JoinPage";

const realReplace = appModeNavigation.replace;
let replacedUrls: string[];

beforeEach(() => {
  runJoinFlowMock.mockReset();
  replacedUrls = [];
  appModeNavigation.replace = (url: string) => {
    replacedUrls.push(url);
  };
});

afterEach(() => {
  cleanup();
  appModeNavigation.replace = realReplace;
});

describe("JoinPage apex app handoff", () => {
  it("replaces to the paired app origin before provisioning", async () => {
    render(<JoinPage />);

    await waitFor(() => {
      expect(replacedUrls).toEqual(["https://cloud.eliza.app/join"]);
    });
    expect(window.location.hostname).toBe("eliza.app");
    expect(runJoinFlowMock).not.toHaveBeenCalled();
  });
});
