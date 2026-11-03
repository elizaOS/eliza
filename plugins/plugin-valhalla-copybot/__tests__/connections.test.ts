import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { connectLink, disconnectLink, testLink, vaultFor } from "../src/connection-routes.ts";
import { engineForTests } from "../src/engine.ts";
import { evaluateCoin } from "../src/evaluate.ts";
import {
  alertAllowed,
  alertLine,
  mintsAndTags,
  pnlCsv,
  rejectTradePermission,
  signalsThatPass,
} from "../src/outside-read.ts";
import { fetchTokenPrice, priceOrder } from "../src/price-feed.ts";
import { extraSafetyGate, safetyScore } from "../src/safety-score.ts";

describe("connections", () => {
  it("encrypts a key and does not write it in the clear", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "valhalla-conn-"));
    const engine = engineForTests(dir);
    await connectLink(engine, "helius", "helius-key-value", "correct horse");
    const raw = await readFile(path.join(dir, "connections.vault.json"), "utf8");
    expect(raw).not.toContain("helius-key-value");
    expect(
      vaultFor(dir)
        .status()
        .find((row) => row.id === "helius")?.state
    ).toBe("ready");
    expect(JSON.stringify(vaultFor(dir).status())).not.toContain("helius-key-value");
    await disconnectLink(engine, "helius");
    expect(vaultFor(dir).secret("helius")).toBeNull();
  });

  it("falls through a rate limit to the next price source", async () => {
    expect(priceOrder(true, true)[0]).toBe("birdeye");
    const hit = await fetchTokenPrice(
      "Mint",
      ["birdeye", "dexscreener"],
      { birdeye: "k" },
      async (input) => {
        const url = String(input);
        if (url.includes("birdeye")) return new Response("{}", { status: 429 });
        return new Response(JSON.stringify({ pairs: [{ priceUsd: "1.25" }] }), { status: 200 });
      }
    );
    expect(hit.source).toBe("dexscreener");
    expect(hit.price).toBe(1.25);
    expect(hit.limited).toContain("birdeye");
  });

  it("keeps X mints behind the safety filters", () => {
    const found = mintsAndTags("watching $MECH Mintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(found.tags).toContain("MECH");
    const judged = signalsThatPass(
      [
        {
          mint: "Mintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          snapshot: {
            mint: "Mintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            symbol: "MECH",
            name: "Mech",
            liquidityUsd: 40_000,
            volume24hUsd: 50_000,
            volume5mUsd: 1_200,
            mintAuthority: "still-on",
            rug: { mintAuthority: "still-on", risks: [], topHolders: [] },
          },
        },
      ],
      evaluateCoin
    );
    expect(judged[0]?.ok).toBe(false);
  });

  it("toggles alerts and hides secrets in the text", () => {
    expect(
      alertAllowed({ buy: true, sell: false, freeze: true, stall: true, pnl: true }, "sell")
    ).toBe(false);
    expect(alertLine("freeze", "bearer abcdefghijklmnop token=supersecretvalue")).not.toMatch(
      /supersecretvalue|abcdefghijklmnop/
    );
    expect(pnlCsv([{ t: "2026-11-03T00:00:00Z", symbol: "MECH", pnlSol: 0.1 }])).toContain("MECH");
  });

  it("scores a token and refuses a withdraw-capable exchange key", () => {
    const bad = safetyScore({ mintAuthority: "yes", risks: [], topHolders: [] });
    expect(bad.score).toBe(0);
    expect(extraSafetyGate({ mintAuthority: "yes", risks: [], topHolders: [] }).ok).toBe(false);
    expect(extraSafetyGate({ risks: [], topHolders: [{ pct: 0.02 }] }).ok).toBe(true);
    expect(rejectTradePermission({ withdraw: true })).toMatch(/view-only/);
    expect(rejectTradePermission({ trade: false, withdraw: false })).toBeNull();
  });

  it("does not place an exchange order while testing Binance", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "valhalla-ex-"));
    const engine = engineForTests(dir);
    const seen: string[] = [];
    await connectLink(
      engine,
      "binance",
      JSON.stringify({ key: "view-only-key", secret: "view-only-secret" }),
      "correct horse"
    );
    const result = await testLink(engine, "binance", async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("apiRestrictions")) {
        return new Response(
          JSON.stringify({ enableWithdrawals: true, enableSpotAndMarginTrading: false }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/view-only/);
    expect(seen.some((url) => url.includes("/api/v3/order"))).toBe(false);
  });
});
