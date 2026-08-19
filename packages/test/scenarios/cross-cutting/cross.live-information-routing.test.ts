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
  assertBitcoinHistoryTurn,
  assertBitcoinSpotTurn,
  assertBlockedPrivateFetch,
  assertElizaNewsTurn,
  assertInjectedAssetTurn,
  assertSuccessfulWebTurn,
  assertTokyoRamenTurn,
  assertTokyoWeatherTurn,
  assertUnavailableFetch,
} from "./cross.live-information-routing.scenario.ts";

function turn(
  actionName: string,
  parameters: Record<string, unknown>,
  success: boolean,
  responseText = "Visible grounded response",
  resultText = success ? "live evidence" : "failed",
  resultData?: Record<string, unknown>,
): ScenarioTurnExecution {
  return {
    actionsCalled: [
      {
        actionName,
        parameters: { parameters },
        result: { success, text: resultText, data: resultData },
      },
    ],
    responseText,
  };
}

function multiActionTurn(
  actionsCalled: ScenarioTurnExecution["actionsCalled"],
): ScenarioTurnExecution {
  return { actionsCalled, responseText: "Visible grounded response" };
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
    ).toMatch(/no successful action satisfying its complete argument contract/);
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
    ).toMatch(/no successful action satisfying its complete argument contract/);
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

  it("binds the complete argument contract and success to the same action", () => {
    const failedCorrectThenSuccessfulWrong = multiActionTurn([
      {
        actionName: "WEB_SEARCH",
        parameters: { parameters: { query: "bitcoin usd spot price" } },
        result: { success: false, text: "search failed" },
      },
      {
        actionName: "WEB_FETCH",
        parameters: {
          parameters: { url: "https://example.com/healthy-status" },
        },
        result: { success: true, text: "unrelated live evidence" },
      },
    ]);
    expect(assertInjectedAssetTurn(failedCorrectThenSuccessfulWrong)).toMatch(
      /no successful action satisfying its complete argument contract/,
    );

    const failedTokyoThenSuccessfulOsaka = multiActionTurn([
      {
        actionName: "WEB_SEARCH",
        parameters: { parameters: { query: "current Tokyo weather" } },
        result: { success: false, text: "search failed" },
      },
      {
        actionName: "WEB_SEARCH",
        parameters: { parameters: { query: "current Osaka weather" } },
        result: { success: true, text: "Osaka weather" },
      },
    ]);
    expect(assertTokyoWeatherTurn(failedTokyoThenSuccessfulOsaka)).toMatch(
      /no successful action satisfying its complete argument contract/,
    );
  });

  it("requires exact CoinGecko host, path, asset, and currency for Bitcoin fetches", () => {
    const decoyUrls = [
      "https://example.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
      "https://api.coingecko.com/api/v3/ping?ids=bitcoin&vs_currencies=usd",
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&note=bitcoin",
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur&note=usd",
    ];
    for (const url of decoyUrls) {
      expect(assertInjectedAssetTurn(turn("WEB_FETCH", { url }, true))).toMatch(
        /no successful action satisfying its complete argument contract/,
      );
      expect(assertBitcoinSpotTurn(turn("WEB_FETCH", { url }, true))).toMatch(
        /no successful action satisfying its complete argument contract/,
      );
    }
  });

  it("binds news, ramen, and 30-day history dimensions per successful action", () => {
    expect(
      assertTokyoWeatherTurn(
        turn("WEB_SEARCH", { query: "current Tokyo weather" }, true),
      ),
    ).toBeUndefined();
    expect(
      assertBitcoinSpotTurn(
        turn("WEB_SEARCH", { query: "Bitcoin USD spot price" }, true),
      ),
    ).toBeUndefined();
    expect(
      assertElizaNewsTurn(
        turn(
          "WEB_SEARCH",
          { query: "latest elizaOS project updates" },
          true,
          "Source: https://elizaos.ai/news/release",
          "Release notes: https://elizaos.ai/news/release",
        ),
      ),
    ).toBeUndefined();
    expect(
      assertTokyoRamenTurn(
        turn(
          "WEB_SEARCH",
          { query: "best reviewed ramen in Tokyo" },
          true,
          "Source: https://example.com/tokyo-ramen",
          "Tokyo guide: https://example.com/tokyo-ramen",
        ),
      ),
    ).toBeUndefined();
    expect(
      assertBitcoinHistoryTurn(
        turn("WEB_SEARCH", { query: "Bitcoin historical 30 day range" }, true),
      ),
    ).toBeUndefined();
    expect(
      assertBitcoinHistoryTurn(
        turn(
          "WEB_FETCH",
          {
            url: "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=30",
          },
          true,
        ),
      ),
    ).toBeUndefined();
    expect(
      assertElizaNewsTurn(
        turn(
          "WEB_SEARCH",
          { query: "latest news about a different project" },
          true,
        ),
      ),
    ).toMatch(/no successful action satisfying its complete argument contract/);
    expect(
      assertTokyoRamenTurn(
        turn("WEB_SEARCH", { query: "best reviewed sushi in Tokyo" }, true),
      ),
    ).toMatch(/no successful action satisfying its complete argument contract/);
    expect(
      assertBitcoinHistoryTurn(
        turn("WEB_SEARCH", { query: "Bitcoin price today in USD" }, true),
      ),
    ).toMatch(/no successful action satisfying its complete argument contract/);
    expect(
      assertBitcoinHistoryTurn(
        turn(
          "WEB_FETCH",
          {
            url: "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=7&note=30",
          },
          true,
        ),
      ),
    ).toMatch(/no successful action satisfying its complete argument contract/);
  });

  it("binds citations to public HTTPS URLs returned by the successful search", () => {
    expect(
      assertElizaNewsTurn(
        turn(
          "WEB_SEARCH",
          { query: "latest elizaOS news" },
          true,
          "A release shipped, according to https://invented.example/news",
          "Result: https://elizaos.ai/news/release",
        ),
      ),
    ).toMatch(/did not cite any URL returned/);
    expect(
      assertTokyoRamenTurn(
        turn(
          "WEB_SEARCH",
          { query: "best reviewed ramen in Tokyo" },
          true,
          "Source: https://example.com/tokyo-ramen",
          "Search backend returned an unlinked summary",
        ),
      ),
    ).toMatch(/returned no public HTTPS source URL/);
    expect(
      assertElizaNewsTurn(
        turn(
          "WEB_SEARCH",
          { query: "latest elizaOS news" },
          true,
          "Source: https://127.0.0.1/decoy",
          "Result: https://127.0.0.1/decoy",
        ),
      ),
    ).toMatch(/returned no public HTTPS source URL/);
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
        turn(
          "WEB_FETCH",
          { url: "https://httpstat.us/503" },
          false,
          "Visible grounded response",
          "Fetch failed for https://httpstat.us/503: HTTP 503.",
          { status: 503 },
        ),
      ),
    ).toBeUndefined();
    expect(
      assertUnavailableFetch(
        turn(
          "WEB_FETCH",
          { url: "https://httpstat.us/503" },
          false,
          "Visible failure response",
          "Fetch failed: TLS handshake failed",
        ),
      ),
    ).toMatch(/did not return the typed HTTP 503 result/);
    expect(
      assertUnavailableFetch(
        turn(
          "WEB_FETCH",
          { url: "https://httpstat.us/503" },
          false,
          "",
          "Fetch failed for https://httpstat.us/503: HTTP 503.",
          { status: 503 },
        ),
      ),
    ).toMatch(/no visible unavailable response/);
  });
});
