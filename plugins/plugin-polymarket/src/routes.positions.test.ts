// Keyless tests for the positions surface that powers the view's positions
// section: the agent-address fallback in `/positions`, the `account` block in
// `/status`, and the account-health `summary` aggregate (total value / total
// cash PnL / implied return). All exercise the real `handlePolymarketRoute`
// with a fake fetch — no network, no credentials — so they run in every keyless
// lane. Mirrors the HL sibling's summary-parsing assertions.

import type http from "node:http";
import { describe, expect, it } from "vitest";

import { validatePositionsResponse } from "./__fixtures__/contract";
import type {
  PolymarketPositionsResponse,
  PolymarketStatusResponse,
} from "./polymarket-contracts";
import { handlePolymarketRoute } from "./routes";

const AGENT_ADDRESS = "0x1111111111111111111111111111111111111111";
const EXPLICIT_USER = "0x2222222222222222222222222222222222222222";

function createRequest(url: string): http.IncomingMessage {
  return { url } as http.IncomingMessage;
}

function createResponse() {
  const res = {
    headersSent: false,
    statusCode: 0,
    body: "",
    setHeader() {},
    end(body: string) {
      this.headersSent = true;
      this.body = body;
    },
    json<T = unknown>(): T {
      return JSON.parse(this.body) as T;
    },
  };
  return res as typeof res & http.ServerResponse;
}

/** A fetch that records the URL it was called with and returns `body`. */
function recordingFetch(body: unknown): {
  fetchImpl: typeof fetch;
  lastUrl: () => string | null;
} {
  let seen: string | null = null;
  const fetchImpl = (async (input: URL | RequestInfo) => {
    seen = String(input);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, lastUrl: () => seen };
}

const RECORDED_POSITIONS = [
  {
    conditionId: "0xcond1",
    question: "Will it rain tomorrow?",
    outcome: "Yes",
    size: "120",
    currentValue: "84.50",
    cashPnl: "12.50",
    percentPnl: "0.173",
    slug: "rain-tomorrow",
  },
  {
    conditionId: "0xcond2",
    question: "Will BTC close above 100k?",
    outcome: "No",
    size: "40",
    currentValue: "15.50",
    cashPnl: "-9.00",
    percentPnl: "-0.367",
    slug: "btc-100k",
  },
  // A zero-size / unreadable row that must not break the aggregate.
  {
    conditionId: "0xcond3",
    question: "Closed market",
    outcome: "Yes",
    size: "0",
    currentValue: null,
    cashPnl: null,
    percentPnl: null,
    slug: "closed",
  },
];

describe("polymarket /status account block", () => {
  it("reports account ready with the resolved address when configured", async () => {
    const res = createResponse();
    await handlePolymarketRoute(
      createRequest("/api/polymarket/status"),
      res,
      "/api/polymarket/status",
      "GET",
      { env: { POLYMARKET_WALLET_ADDRESS: AGENT_ADDRESS } },
    );
    const body = res.json<PolymarketStatusResponse>();
    expect(body.account.ready).toBe(true);
    expect(body.account.address).toBe(AGENT_ADDRESS);
    expect(body.account.reason).toBeNull();
  });

  it("reports account not-ready with guidance when no address is set", async () => {
    const res = createResponse();
    await handlePolymarketRoute(
      createRequest("/api/polymarket/status"),
      res,
      "/api/polymarket/status",
      "GET",
      { env: {} },
    );
    const body = res.json<PolymarketStatusResponse>();
    expect(body.account.ready).toBe(false);
    expect(body.account.address).toBeNull();
    expect(body.account.reason).toMatch(/wallet address/i);
  });

  it("ignores a malformed (non-hex) address", async () => {
    const res = createResponse();
    await handlePolymarketRoute(
      createRequest("/api/polymarket/status"),
      res,
      "/api/polymarket/status",
      "GET",
      { env: { POLYMARKET_WALLET_ADDRESS: "not-an-address" } },
    );
    const body = res.json<PolymarketStatusResponse>();
    expect(body.account.ready).toBe(false);
    expect(body.account.address).toBeNull();
  });
});

describe("polymarket /positions address fallback + summary", () => {
  it("falls back to the agent address when no user query is supplied", async () => {
    const res = createResponse();
    const { fetchImpl, lastUrl } = recordingFetch(RECORDED_POSITIONS);
    await handlePolymarketRoute(
      createRequest("/api/polymarket/positions"),
      res,
      "/api/polymarket/positions",
      "GET",
      { fetchImpl, env: { STEWARD_EVM_ADDRESS: AGENT_ADDRESS } },
    );
    expect(res.statusCode).toBe(200);
    // The upstream Data API call used the resolved agent address.
    expect(lastUrl()).toContain(`user=${AGENT_ADDRESS}`);
    const body = res.json<PolymarketPositionsResponse>();
    expect(body.user).toBe(AGENT_ADDRESS);
    expect(validatePositionsResponse(body)).toEqual([]);
  });

  it("prefers an explicit user query over the agent address", async () => {
    const res = createResponse();
    const { fetchImpl, lastUrl } = recordingFetch(RECORDED_POSITIONS);
    await handlePolymarketRoute(
      createRequest(`/api/polymarket/positions?user=${EXPLICIT_USER}`),
      res,
      "/api/polymarket/positions",
      "GET",
      { fetchImpl, env: { POLYMARKET_WALLET_ADDRESS: AGENT_ADDRESS } },
    );
    expect(lastUrl()).toContain(`user=${EXPLICIT_USER}`);
    expect(res.json<PolymarketPositionsResponse>().user).toBe(EXPLICIT_USER);
  });

  it("400s when neither a user query nor an agent address is available", async () => {
    const res = createResponse();
    const { fetchImpl } = recordingFetch([]);
    await handlePolymarketRoute(
      createRequest("/api/polymarket/positions"),
      res,
      "/api/polymarket/positions",
      "GET",
      { fetchImpl, env: {} },
    );
    expect(res.statusCode).toBe(400);
  });

  it("aggregates value, cash PnL, and implied return across positions", async () => {
    const res = createResponse();
    const { fetchImpl } = recordingFetch(RECORDED_POSITIONS);
    await handlePolymarketRoute(
      createRequest("/api/polymarket/positions"),
      res,
      "/api/polymarket/positions",
      "GET",
      { fetchImpl, env: { POLYMARKET_WALLET_ADDRESS: AGENT_ADDRESS } },
    );
    const body = res.json<PolymarketPositionsResponse>();
    expect(body.summary).not.toBeNull();
    const summary = body.summary;
    if (!summary) throw new Error("summary missing");
    // 84.50 + 15.50 = 100.00 ; 12.50 + (-9.00) = 3.50
    expect(Number(summary.totalValue)).toBeCloseTo(100, 6);
    expect(Number(summary.totalCashPnl)).toBeCloseTo(3.5, 6);
    // cost basis = 100 - 3.5 = 96.5 ; return = 3.5 / 96.5
    expect(Number(summary.totalPercentPnl)).toBeCloseTo(3.5 / 96.5, 6);
    // openPositions counts only size-bearing rows (the zero-size third row is
    // excluded), matching the table's Math.abs(size) > 1e-9 filter in the view.
    const sizeBearing = RECORDED_POSITIONS.filter(
      (p) => Math.abs(Number(p.size)) > 1e-9,
    ).length;
    expect(sizeBearing).toBe(2);
    expect(summary.openPositions).toBe(sizeBearing);
  });

  it("returns a null summary for an empty wallet", async () => {
    const res = createResponse();
    const { fetchImpl } = recordingFetch([]);
    await handlePolymarketRoute(
      createRequest("/api/polymarket/positions"),
      res,
      "/api/polymarket/positions",
      "GET",
      { fetchImpl, env: { POLYMARKET_WALLET_ADDRESS: AGENT_ADDRESS } },
    );
    const body = res.json<PolymarketPositionsResponse>();
    expect(body.summary).toBeNull();
    expect(body.positions).toEqual([]);
    expect(validatePositionsResponse(body)).toEqual([]);
  });
});
