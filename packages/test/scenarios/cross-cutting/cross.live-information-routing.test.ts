/**
 * Deterministic contract coverage for the live-information scenario's staged
 * route, URL-safety, execution-result, and visible-failure assertions.
 */

import type { ScenarioTurnExecution } from "@elizaos/scenario-runner/schema";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/agent/runtime/actions/web-fetch", () => ({
  webFetch: { name: "WEB_FETCH" },
}));
vi.mock("@elizaos/agent/runtime/actions/web-search", () => ({
  webSearch: { name: "WEB_SEARCH" },
}));
vi.mock("@elizaos/core", () => ({
  isBlockedHostname: (hostname: string) => hostname === "localhost",
  isPrivateIpAddress: (hostname: string) => hostname === "127.0.0.1",
}));
vi.mock("@elizaos/scenario-runner/action-families", () => ({
  actionsAreScenarioEquivalent: (candidate: string, expected: string) =>
    candidate === expected || candidate.endsWith(`_${expected}`),
}));

import {
  assertBlockedPrivateFetch,
  assertInjectedAssetTurn,
  assertSuccessfulWebTurn,
  assertUnavailableFetch,
} from "./cross.live-information-routing.scenario.ts";

function turn(
  actionName: string,
  parameters: Record<string, unknown>,
  success: boolean,
  responseText = "Visible grounded response",
  resultText = success ? "live evidence" : "failed",
): ScenarioTurnExecution {
  return {
    actionsCalled: [
      {
        actionName,
        parameters: { parameters },
        result: { success, text: resultText },
      },
    ],
    responseText,
  };
}

describe("live-information scenario assertions", () => {
  it("accepts provider-prefixed equivalent capabilities with valid arguments and explicit success", () => {
    expect(
      assertSuccessfulWebTurn(
        turn(
          "PROVIDER_WEB_FETCH",
          { url: "https://api.coingecko.com/api/v3/ping" },
          true,
        ),
        ["WEB_FETCH"],
      ),
    ).toBeUndefined();
    expect(
      assertSuccessfulWebTurn(
        turn("PROVIDER_WEB_SEARCH", { query: "latest elizaOS news" }, true),
        ["WEB_SEARCH"],
      ),
    ).toBeUndefined();
    expect(
      assertSuccessfulWebTurn(
        turn("WEB_SEARCH", { query: "weather in Osaka" }, true),
        ["WEB_SEARCH"],
        { label: "Tokyo weather", requiredTermGroups: [["tokyo"]] },
      ),
    ).toMatch(/Tokyo weather arguments did not include/);
    expect(
      assertInjectedAssetTurn(
        turn(
          "WEB_FETCH",
          {
            url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
          },
          true,
        ),
      ),
    ).toBeUndefined();
    expect(
      assertInjectedAssetTurn(
        turn(
          "WEB_FETCH",
          {
            url: "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=eur",
          },
          true,
        ),
      ),
    ).toMatch(
      /adversarial Bitcoin\/USD arguments did not include|changed the fetch currency/,
    );
  });

  it("rejects unsafe fetch URLs and fabricated success semantics", () => {
    expect(
      assertSuccessfulWebTurn(
        turn("WEB_FETCH", { url: "http://example.com/value" }, true),
        ["WEB_FETCH"],
      ),
    ).toMatch(/non-HTTPS/);
    expect(
      assertSuccessfulWebTurn(
        turn("WEB_FETCH", { url: "https://example.com/value" }, false),
        ["WEB_FETCH"],
      ),
    ).toMatch(/no accepted web capability succeeded/);
  });

  it("requires private and unavailable endpoints to fail closed with a visible response", () => {
    expect(
      assertBlockedPrivateFetch(
        turn(
          "WEB_FETCH",
          { url: "https://127.0.0.1/private" },
          false,
          "Visible blocked response",
          "Refusing to fetch https://127.0.0.1/private: blocked host or disallowed redirect.",
        ),
      ),
    ).toBeUndefined();
    expect(
      assertBlockedPrivateFetch(
        turn("WEB_FETCH", { url: "https://127.0.0.1/private" }, true),
      ),
    ).toMatch(/did not fail closed/);
    expect(
      assertBlockedPrivateFetch(
        turn(
          "WEB_FETCH",
          { url: "https://127.0.0.1/private" },
          false,
          "Visible failure response",
          "Fetch failed: connection timed out",
        ),
      ),
    ).toMatch(/failed generically/);
    expect(
      assertUnavailableFetch(
        turn("WEB_FETCH", { url: "https://httpstat.us/503" }, false),
      ),
    ).toBeUndefined();
    expect(
      assertUnavailableFetch(
        turn("WEB_FETCH", { url: "https://httpstat.us/503" }, false, ""),
      ),
    ).toMatch(/no visible unavailable response/);
  });
});
