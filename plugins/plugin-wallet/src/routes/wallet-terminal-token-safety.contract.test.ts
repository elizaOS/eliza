/**
 * Drives the real token safety route and the shared GoPlus parser with a recorded GoPlus
 * Solana payload and adversarial variants through an injected fetch.
 * Deterministic and keyless; it covers mint validation, each danger flag,
 * unreported fields, upstream errors, stale-cache recovery, and
 * concurrent-miss sharing.
 */
import { readFileSync } from "node:fs";
import type http from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseGoPlusSolanaTokenSecurity } from "../analytics/goplus/solana-token-security";
import type { WalletTerminalTokenSafetyResponse } from "../contracts";
import {
  __expireWalletTerminalTokenSafetyCacheForTests,
  __resetWalletTerminalTokenSafetyRouteForTests,
  __setWalletTerminalTokenSafetyFetchForTests,
  handleWalletTerminalTokenSafetyRoute,
} from "./wallet-terminal-token-safety-route";

const recorded = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "__fixtures__/goplus-solana-token-security.recorded.json",
    ),
    "utf8",
  ),
) as {
  mint: string;
  goplus: { code: number; result: Record<string, Record<string, unknown>> };
};
const MINT = recorded.mint;

function withReport(
  patch: Record<string, unknown>,
  omit: string[] = [],
): unknown {
  const report: Record<string, unknown> = {
    ...recorded.goplus.result[MINT],
    ...patch,
  };
  for (const key of omit) delete report[key];
  return { ...recorded.goplus, result: { [MINT]: report } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(
  handler: (href: string) => Response | Promise<Response>,
): string[] {
  const calls: string[] = [];
  __setWalletTerminalTokenSafetyFetchForTests(async (input) => {
    const href = String(input);
    calls.push(href);
    return handler(href);
  });
  return calls;
}

async function call(url: string, method = "GET") {
  const res = {
    statusCode: 0,
    body: "",
    headersSent: false,
    setHeader() {},
    end(body?: string) {
      if (typeof body === "string") this.body = body;
    },
    json<T>(): T {
      return JSON.parse(this.body) as T;
    },
  };
  const handled = await handleWalletTerminalTokenSafetyRoute(
    {
      method,
      url,
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage,
    res as unknown as http.ServerResponse,
  );
  return { handled, res };
}

const path = (mint: string) =>
  `/api/wallet/terminal/token-safety?mint=${encodeURIComponent(mint)}`;

function severityOf(report: WalletTerminalTokenSafetyResponse, id: string) {
  return report.checks.find((entry) => entry.id === id)?.severity;
}

afterEach(() => {
  __resetWalletTerminalTokenSafetyRouteForTests();
});

describe("parseGoPlusSolanaTokenSecurity", () => {
  it("reads the recorded report into checks and a caution verdict", () => {
    const report = parseGoPlusSolanaTokenSecurity(MINT, recorded.goplus);
    expect(report).toMatchObject({
      mint: MINT,
      name: "Bonk",
      symbol: "Bonk",
      holderCount: 1_024_564,
      trustedToken: false,
      verdict: "caution",
      stale: false,
    });
    expect(report.top10HolderPct).toBeCloseTo(38.41, 2);
    expect(report.liquidityUsd).toBeCloseTo(614_902.36, 2);
    expect(severityOf(report, "mint-authority")).toBe("ok");
    expect(severityOf(report, "freeze-authority")).toBe("ok");
    expect(severityOf(report, "metadata-mutable")).toBe("warn");
    expect(severityOf(report, "holder-concentration")).toBe("warn");
  });

  it.each([
    ["mint-authority", { mintable: { authority: [], status: "1" } }],
    ["freeze-authority", { freezable: { authority: [], status: "1" } }],
    [
      "balance-mutable",
      { balance_mutable_authority: { authority: [], status: "1" } },
    ],
    ["non-transferable", { non_transferable: "1" }],
    ["default-frozen", { default_account_state: "2" }],
    ["transfer-hook", { transfer_hook: [{ address: "hook" }] }],
  ])("marks %s as danger and the token as avoid", (id, patch) => {
    const report = parseGoPlusSolanaTokenSecurity(MINT, withReport(patch));
    expect(severityOf(report, id)).toBe("danger");
    expect(report.verdict).toBe("avoid");
  });

  it("flags a transfer fee and upgradable extensions as warnings", () => {
    const report = parseGoPlusSolanaTokenSecurity(
      MINT,
      withReport({
        transfer_fee: { fee_rate: "0.05" },
        transfer_hook_upgradable: { authority: [], status: "1" },
      }),
    );
    expect(severityOf(report, "transfer-fee")).toBe("warn");
    expect(severityOf(report, "upgradable-extensions")).toBe("warn");
  });

  it("reports unreported fields as unknown instead of passing them", () => {
    const report = parseGoPlusSolanaTokenSecurity(
      MINT,
      withReport({ metadata_mutable: { status: "0" }, holders: [] }, [
        "freezable",
        "transfer_hook",
      ]),
    );
    expect(severityOf(report, "freeze-authority")).toBe("unknown");
    expect(severityOf(report, "transfer-hook")).toBe("unknown");
    expect(severityOf(report, "holder-concentration")).toBe("unknown");
    expect(report.top10HolderPct).toBeNull();
    expect(report.verdict).toBe("caution");
  });

  it("gives no-major-flags only when every check is ok", () => {
    const report = parseGoPlusSolanaTokenSecurity(
      MINT,
      withReport({
        metadata_mutable: { status: "0" },
        holders: [{ percent: "0.05" }, { percent: "0.04" }],
      }),
    );
    expect(report.checks.every((entry) => entry.severity === "ok")).toBe(true);
    expect(report.verdict).toBe("no-major-flags");
  });

  it("rejects upstream error codes and malformed envelopes", () => {
    expect(() =>
      parseGoPlusSolanaTokenSecurity(MINT, {
        code: 4029,
        message: "too many requests",
      }),
    ).toThrow(/code 4029: too many requests/);
    expect(() => parseGoPlusSolanaTokenSecurity(MINT, [])).toThrow(
      /not an object/,
    );
    expect(() =>
      parseGoPlusSolanaTokenSecurity(MINT, { code: 1, result: null }),
    ).toThrow(/no result/);
  });
});

describe("GET /api/wallet/terminal/token-safety", () => {
  it("serves the report for a valid mint", async () => {
    const calls = installFetch(() => jsonResponse(recorded.goplus));
    const { handled, res } = await call(path(MINT));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = res.json<WalletTerminalTokenSafetyResponse>();
    expect(body.source).toMatchObject({
      providerId: "goplus",
      available: true,
      error: null,
    });
    expect(calls[0]).toContain("/api/v1/solana/token_security");
    expect(calls[0]).toContain(`contract_addresses=${MINT}`);
  });

  it.each([
    [""],
    ["not-a-mint"],
    ["0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl"],
    [`${MINT}&contract_addresses=x`],
  ])("rejects mint %j before any upstream call", async (mint) => {
    const calls = installFetch(() => jsonResponse(recorded.goplus));
    const { res } = await call(path(mint));
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("answers 404 when GoPlus has no report for the mint", async () => {
    installFetch(() => jsonResponse({ code: 1, message: "ok", result: {} }));
    const { res } = await call(path(MINT));
    expect(res.statusCode).toBe(404);
  });

  it("answers 502 when the provider fails and nothing is cached", async () => {
    installFetch(() => jsonResponse({}, 503));
    const { res } = await call(path(MINT));
    expect(res.statusCode).toBe(502);
  });

  it("serves the last good report marked stale when a refresh fails", async () => {
    let fail = false;
    installFetch(() =>
      fail ? jsonResponse({}, 500) : jsonResponse(recorded.goplus),
    );
    await call(path(MINT));
    fail = true;
    __expireWalletTerminalTokenSafetyCacheForTests();
    const { res } = await call(path(MINT));
    expect(res.statusCode).toBe(200);
    const body = res.json<WalletTerminalTokenSafetyResponse>();
    expect(body.stale).toBe(true);
    expect(body.source.error).toBe("GoPlus responded 500");
  });

  it("shares one upstream request across concurrent misses", async () => {
    const calls = installFetch(() => jsonResponse(recorded.goplus));
    await Promise.all([call(path(MINT)), call(path(MINT)), call(path(MINT))]);
    expect(calls).toHaveLength(1);
  });

  it("rejects non-GET methods and ignores foreign paths", async () => {
    installFetch(() => jsonResponse(recorded.goplus));
    expect((await call(path(MINT), "POST")).res.statusCode).toBe(405);
    expect((await call("/api/wallet/terminal/markets")).handled).toBe(false);
  });
});
