// External-API contract test for the Steward bridge parsers.
//
// These run the REAL parsers from ./routes/steward-bridge over responses shaped
// exactly per the live @stwd/sdk v0.10.1 d.ts (see __fixtures__/steward-sdk-fixtures
// for the verified shapes). The goal is to catch drift between what Steward
// actually returns and what the parsers/UI assume.
import type { GetBalanceResult, StewardClient } from "@stwd/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sdkAgentBalance,
  sdkPolicyResultPassed,
  sdkPolicyResultRejected,
  sdkTxRecordConfirmed,
  sdkTxRecordPending,
} from "./__fixtures__/steward-sdk-fixtures";
import {
  getStewardBalance,
  getStewardHistory,
  getStewardPendingApprovals,
  getStewardTokenBalances,
  signViaSteward,
} from "./routes/steward-bridge";

const BASE = "https://steward.test";
const ENV: NodeJS.ProcessEnv = {
  STEWARD_API_URL: BASE,
  STEWARD_API_KEY: "sk-test",
  STEWARD_TENANT_ID: "tenant-1",
  STEWARD_AGENT_ID: "agent-alpha",
  EVM_ADDRESS: "0xabc0000000000000000000000000000000000000",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("getStewardPendingApprovals (real @stwd/sdk TxRecord shape)", () => {
  it("unwraps a { data } envelope of real-shaped pending entries", async () => {
    // Real shape: TxRecord.createdAt is a Date; JSON-over-the-wire serializes
    // it to an ISO string. We emulate the serialized body the parser sees.
    const wireEntry = {
      queueId: "queue-1",
      status: "pending_approval",
      requestedAt: new Date("2026-05-18T13:00:00.000Z").toISOString(),
      transaction: {
        ...sdkTxRecordPending,
        createdAt: sdkTxRecordPending.createdAt.toISOString(),
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        expect(String(url)).toBe(`${BASE}/vault/agent-alpha/pending`);
        return jsonResponse({ data: [wireEntry] });
      }),
    );

    const result = await getStewardPendingApprovals("agent-alpha", ENV);
    expect(result).toHaveLength(1);
    expect(result[0].queueId).toBe("queue-1");
    expect(result[0].transaction.id).toBe("tx-pending");
    // Real PolicyResult uses passed/policyId, never `status`.
    expect(result[0].transaction.policyResults[0]).toMatchObject({
      policyId: "policy-spend-limit",
      passed: false,
      reason: "Exceeds per-tx spending limit",
    });
    expect(result[0].transaction.policyResults[0]).not.toHaveProperty("status");
  });

  it("accepts a bare array response (no envelope)", async () => {
    const wireEntry = {
      queueId: "queue-2",
      status: "pending_approval",
      requestedAt: "2026-05-18T13:00:00.000Z",
      transaction: {
        ...sdkTxRecordPending,
        createdAt: sdkTxRecordPending.createdAt.toISOString(),
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([wireEntry])));
    const result = await getStewardPendingApprovals("agent-alpha", ENV);
    expect(result).toHaveLength(1);
    expect(result[0].queueId).toBe("queue-2");
  });

  it("returns [] when the endpoint 404s", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "not found" }, { status: 404 })),
    );
    await expect(getStewardPendingApprovals("agent-alpha", ENV)).resolves.toEqual(
      [],
    );
  });

  it("throws on a non-404 error status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("boom", { status: 500 }),
      ),
    );
    await expect(
      getStewardPendingApprovals("agent-alpha", ENV),
    ).rejects.toThrow(/Steward pending approvals failed \(500\)/);
  });
});

describe("getStewardHistory (real TxRecord[])", () => {
  it("unwraps a { data } envelope and forwards limit/offset", async () => {
    const wireRecord = {
      ...sdkTxRecordConfirmed,
      createdAt: sdkTxRecordConfirmed.createdAt.toISOString(),
      signedAt: sdkTxRecordConfirmed.signedAt?.toISOString(),
      confirmedAt: sdkTxRecordConfirmed.confirmedAt?.toISOString(),
    };
    const fetchSpy = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe(
        `${BASE}/vault/agent-alpha/history?limit=25&offset=0`,
      );
      return jsonResponse({ data: [wireRecord] });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const records = await getStewardHistory(
      "agent-alpha",
      { limit: 25, offset: 0 },
      ENV,
    );
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe("tx-confirmed");
    expect(records[0].txHash).toMatch(/^0xconfirmedhash/);
    expect(records[0].status).toBe("confirmed");
  });

  it("accepts a bare array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([
          {
            ...sdkTxRecordConfirmed,
            createdAt: sdkTxRecordConfirmed.createdAt.toISOString(),
          },
        ]),
      ),
    );
    const records = await getStewardHistory("agent-alpha", undefined, ENV);
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe("tx-confirmed");
  });
});

describe("getStewardBalance (AgentBalance nested under result.balances)", () => {
  it("maps result.balances.* into the flat StewardBalanceResult", async () => {
    // Inject a fake StewardClient via options.client so we exercise the exact
    // mapping the parser performs over a real AgentBalance shape.
    const fakeClient = {
      getBalance: vi.fn(
        async (
          agentId: string,
          chainId?: number,
        ): Promise<GetBalanceResult> => {
          expect(agentId).toBe("agent-alpha");
          expect(chainId).toBe(8453);
          return sdkAgentBalance;
        },
      ),
    } as unknown as StewardClient;

    const result = await getStewardBalance("agent-alpha", 8453, {
      env: ENV,
      client: fakeClient,
    });
    expect(result).toEqual({
      balance: "2500000000000000000",
      formatted: "2.5",
      symbol: "ETH",
      chainId: 8453,
    });
  });
});

describe("getStewardTokenBalances ({ ok, data } envelope)", () => {
  it("returns body.data when present", async () => {
    const payload = {
      native: {
        balance: "1000000000000000000",
        formatted: "1.0",
        symbol: "ETH",
        chainId: 8453,
      },
      tokens: [
        {
          address: "0xtoken",
          symbol: "USDC",
          name: "USD Coin",
          balance: "5000000",
          formatted: "5.0",
          decimals: 6,
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        expect(String(url)).toBe(`${BASE}/agents/agent-alpha/tokens?chainId=8453`);
        return jsonResponse({ ok: true, data: payload });
      }),
    );

    const result = await getStewardTokenBalances("agent-alpha", 8453, {
      env: ENV,
    });
    expect(result.native.symbol).toBe("ETH");
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0].symbol).toBe("USDC");
  });
});

describe("signViaSteward (HTTP-status -> typed outcome)", () => {
  it("maps HTTP 200 { ok:true, data:{txHash} } to { approved:true, txHash }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        expect(String(url)).toBe(`${BASE}/vault/agent-alpha/sign`);
        return jsonResponse({ ok: true, data: { txHash: "0xsigned" } });
      }),
    );
    const res = await signViaSteward(
      { to: "0xfeed", value: "1", chainId: 8453 },
      ENV,
    );
    expect(res).toEqual({ approved: true, txHash: "0xsigned" });
  });

  it("maps HTTP 202 to { approved:false, pending:true, txId, violations }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            data: {
              txId: "tx-202",
              violations: [{ policy: "spend-limit", reason: "too big" }],
            },
          },
          { status: 202 },
        ),
      ),
    );
    const res = await signViaSteward(
      { to: "0xfeed", value: "1", chainId: 8453 },
      ENV,
    );
    expect(res).toEqual({
      approved: false,
      pending: true,
      txId: "tx-202",
      violations: [{ policy: "spend-limit", reason: "too big" }],
    });
  });

  it("maps HTTP 403 to { approved:false, denied:true, normalized violations }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            data: {
              violations: [
                { policy: "approved-addresses", reason: "recipient blocked" },
                { policy: 42, reason: "dropped" }, // malformed -> filtered out
              ],
            },
          },
          { status: 403 },
        ),
      ),
    );
    const res = await signViaSteward(
      { to: "0xfeed", value: "1", chainId: 8453 },
      ENV,
    );
    expect(res.approved).toBe(false);
    expect(res.denied).toBe(true);
    expect(res.violations).toEqual([
      { policy: "approved-addresses", reason: "recipient blocked" },
    ]);
  });
});

// ── Drift lock: real PolicyResult shape vs ApprovalQueue.getPolicyReasons ─────
//
// ApprovalQueue.getPolicyReasons (src/ApprovalQueue.tsx) filters on
// `r.status === "rejected" | "pending"`. The app's local StewardPolicyResult
// (from @elizaos/contracts via @elizaos/core) carries `status`, but the REAL
// @stwd/sdk PolicyResult carries `{ passed, policyId, type, reason }` with NO
// `status`. Re-derive the exact filter here and prove that, fed real SDK
// PolicyResult[], it drops every reason. This locks the parser-vs-UI contract
// so the drift is caught if either side changes.
type StatusFilteredPolicyResult = { status?: string; reason?: string };

function getPolicyReasons(
  policyResults: StatusFilteredPolicyResult[],
): string[] {
  if (!Array.isArray(policyResults)) return [];
  return policyResults
    .filter((r) => r.reason && (r.status === "rejected" || r.status === "pending"))
    .map((r) => r.reason as string)
    .filter(Boolean);
}

describe("policyResults shape drift (SDK PolicyResult vs UI getPolicyReasons)", () => {
  it("drops all reasons when fed real @stwd/sdk PolicyResult[] (no status field)", () => {
    const sdkResults = [sdkPolicyResultRejected, sdkPolicyResultPassed];
    // The rejecting result DOES have a human-readable reason...
    expect(sdkResults[0].reason).toBe("Exceeds per-tx spending limit");
    // ...but the status-based filter silently drops it because SDK results
    // have no `status` field. This is the documented drift.
    expect(
      getPolicyReasons(sdkResults as StatusFilteredPolicyResult[]),
    ).toEqual([]);
  });

  it("surfaces reasons only for the app's status-shaped StewardPolicyResult", () => {
    const appShaped: StatusFilteredPolicyResult[] = [
      { status: "rejected", reason: "Recipient not allowlisted" },
      { status: "approved", reason: "ok (ignored)" },
    ];
    expect(getPolicyReasons(appShaped)).toEqual(["Recipient not allowlisted"]);
  });
});
