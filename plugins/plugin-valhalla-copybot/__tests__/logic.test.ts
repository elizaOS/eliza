import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { evaluateCoinAction, pnlAction, tradingControlAction } from "../src/actions.ts";
import { createBook, openPaper } from "../src/book.ts";
import { type CoinSnapshot, evaluateCoin } from "../src/evaluate.ts";
import { decideExit, type PositionView } from "../src/exits.ts";
import { classifyMcap, dailyLossTripped, stableRejectReason } from "../src/filters.ts";
import { geminiGenerateUrl, generateWithGemini } from "../src/gemini.ts";
import { executeLiveSwap } from "../src/live-swap.ts";
import { judgeEarlyBuyers } from "../src/manipulation.ts";
import { liveTradingEnabled, loadWalletSecret } from "../src/safety-gate.ts";
import { applyMultipliers, chooseSize } from "../src/sizing.ts";
import { recomputeSlots, splitWaveProfit } from "../src/slots.ts";
import { assertNoValueTransfer } from "../src/swap-guard.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "../src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

function baseCoin(now: number): CoinSnapshot {
  const holders = Array.from({ length: 10 }, (_, index) => ({
    address: `Holder${index}xxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
    pct: 0.02,
  }));
  holders[0] = { address: "Creatorxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", pct: 0.02 };
  return {
    mint: "Mintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    symbol: "MECH",
    name: "Mech Coin",
    lane: "main",
    creator: "Creatorxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    pairCreatedAt: now - 30 * 60 * 60 * 1000,
    marketCapUsd: 300_000,
    liquidityUsd: 40_000,
    volume24hUsd: 50_000,
    volume1hUsd: 8_000,
    volume5mUsd: 1_200,
    volume6hUsd: 30_000,
    change5mPct: 4,
    change1hPct: 12,
    change6hPct: 20,
    change24hPct: 30,
    buys5m: 20,
    sells5m: 10,
    bondingCurve: false,
    mintAuthority: null,
    freezeAuthority: null,
    transferHook: false,
    holders,
    rug: {
      score: 20,
      risks: [],
      topHolders: holders,
      creator: "Creatorxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    },
    mr: null,
    earlyTxs: [
      {
        signature: "sig1",
        slot: 10,
        feePayer: "Feepayerxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        increases: [{ owner: "Buyerxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", before: 0, after: 10 }],
      },
    ],
    buyImpactPct: 0,
    sellImpactPct: 0,
    quoteSol: 0.01,
    equitySol: 1,
    freeSol: 1,
    solUsd: 100,
    now,
  };
}

function position(
  partial: Partial<PositionView> & Pick<PositionView, "openedAt" | "markPriceUsd">
): PositionView {
  return {
    id: "p1",
    mint: "mint",
    lane: "main",
    status: "OPEN",
    costSol: 0.025,
    originalCostSol: 0.025,
    entryPriceUsd: 1,
    markAt: partial.openedAt,
    tpNet10Taken: false,
    tpNet10Armed: false,
    peakPriceUsd: partial.markPriceUsd,
    trailArmed: false,
    transferTaxBps: 0,
    entryMcapUsd: 500_000,
    hold: false,
    riskTp1Taken: false,
    riskTp2Taken: false,
    pairCreatedAt: partial.openedAt - 5 * 60 * 60 * 1000,
    ...partial,
  };
}

describe("sizing", () => {
  it("steps down when quoted impact would break the cap", () => {
    const choice = chooseSize({
      maxSol: 0.05,
      minSol: 0.0125,
      quoteSol: 0.01,
      impactCap: 0.05,
      buyImpactPct: 0.02,
      sellImpactPct: 0,
    });
    expect(choice.size).toBe(0.025);
    expect(choice.tried.length).toBeGreaterThan(0);
  });

  it("drops a ticket that multipliers push under the minimum", () => {
    const sized = applyMultipliers(0.02, [{ name: "early", frac: 0.5 }], 0.0125);
    expect(sized.size).toBe(0);
    expect(sized.skipped).toContain("min");
  });
});

describe("filters", () => {
  it("blocks stables, thin liquidity, and a bundled early slot", () => {
    expect(
      stableRejectReason("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC", "USD Coin")
    ).toMatch(/stable/);
    const now = Date.parse("2026-11-03T15:00:00Z");
    const thin = evaluateCoin({ ...baseCoin(now), liquidityUsd: 2_000 });
    expect(thin.ok).toBe(false);
    expect(thin.reason).toMatch(/liquidity/);
    const bundled = judgeEarlyBuyers({
      txs: [1, 2, 3].map((n) => ({
        signature: `sig${n}`,
        slot: 5,
        feePayer: `Funder${n}xxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
        increases: [{ owner: `Buyer${n}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`, before: 0, after: 1 }],
      })),
      topHolders: [],
    });
    expect(bundled.ok).toBe(false);
    expect(bundled.reason).toMatch(/bundlers/);
  });

  it("passes a liquid coin and keeps the market-cap ceiling", () => {
    const now = Date.parse("2026-11-03T15:00:00Z");
    const pass = evaluateCoin(baseCoin(now));
    expect(pass.ok).toBe(true);
    expect(pass.sizeSol).toBeGreaterThan(0);
    expect(pass.sizeSol).toBeLessThanOrEqual(0.025);
    expect(classifyMcap(3_000_000).ok).toBe(false);
    expect(dailyLossTripped(0.9, 1)).toBe(false);
  });

  it("uses the RPC early-buy feed when the caller supplies one", () => {
    const now = Date.parse("2026-11-03T15:00:00Z");
    const blocked = evaluateCoin({
      ...baseCoin(now),
      earlyTxs: [1, 2, 3].map((n) => ({
        signature: `sig${n}`,
        slot: 9,
        feePayer: "SameFunderxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        increases: [{ owner: `Wallet${n}xxxxxxxxxxxxxxxxxxxxxxxxxxxxx`, before: 0, after: 2 }],
      })),
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/same slot/);
  });
});

describe("exits", () => {
  const now = Date.parse("2026-11-03T15:00:00Z");

  it("fires the hard stop, the max hold, and the stale exit", () => {
    expect(decideExit(position({ openedAt: now - 60_000, markPriceUsd: 0.9 }), { now }).label).toBe(
      "hard_stop"
    );
    expect(
      decideExit(position({ openedAt: now - 21 * 60_000, markPriceUsd: 1.01 }), { now }).label
    ).toBe("max_hold");
    expect(
      decideExit(position({ openedAt: now - 9 * 60_000, markPriceUsd: 1.01 }), { now }).label
    ).toBe("stale");
  });

  it("sells the net take-profit only when a sell quote confirms it", () => {
    const pos = position({ openedAt: now - 60_000, markPriceUsd: 1.4, lane: "main" });
    expect(decideExit(pos, { now, quoteOk: false }).action).toBe("hold");
    const hit = decideExit(pos, { now, quoteOk: true, quoteOutSol: 0.04 });
    expect(hit.action).toBe("partial");
    expect(hit.fraction).toBe(0.75);
  });
});

describe("slots and safety", () => {
  it("caps slots and keeps a winning-wave split inside the book", () => {
    const plan = recomputeSlots({ equitySol: 0.3, freeSol: 0.3 });
    expect(plan.maxOpenSlots).toBeLessThanOrEqual(8);
    expect(plan.ticketSol).toBeLessThanOrEqual(0.025);
    const split = splitWaveProfit(0.1, 0.1);
    expect(split.reinvest + split.reserve + split.net).toBeCloseTo(0.1);
    expect(split.mode).toBe("below_principal");
  });

  it("does not read a wallet secret unless live trading is exactly true", () => {
    expect(liveTradingEnabled({})).toBe(false);
    expect(liveTradingEnabled({ VALHALLA_LIVE_TRADING: "false" })).toBe(false);
    expect(() =>
      loadWalletSecret({ VALHALLA_LIVE_TRADING: "false", VALHALLA_WALLET_SECRET_KEY: "abc" })
    ).toThrow(/not read/);
    expect(() =>
      loadWalletSecret({ VALHALLA_LIVE_TRADING: "true", VALHALLA_WALLET_SECRET_KEY: "wallet.json" })
    ).toThrow(/file path/);
  });

  it("has no transfer action", () => {
    const names = [evaluateCoinAction.name, tradingControlAction.name, pnlAction.name];
    expect(names.join(" ")).not.toMatch(/TRANSFER|SEND|WITHDRAW|SWEEP/);
    expect(() =>
      assertNoValueTransfer([
        { programId: "11111111111111111111111111111111", data: Uint8Array.of(2, 0, 0, 0) },
      ])
    ).toThrow(/transfer or withdraw/);
  });
});

describe("gemini and live swap gate", () => {
  it("calls Google AI Studio and not Vertex", async () => {
    const url = geminiGenerateUrl("gemini-2.5-flash", "test-key");
    expect(new URL(url).hostname).toBe("generativelanguage.googleapis.com");
    expect(url).not.toContain("aiplatform.googleapis.com");
    let seen = "";
    const text = await generateWithGemini({
      apiKey: "test-key",
      model: "gemini-2.5-flash",
      prompt: "status",
      fetchImpl: async (input) => {
        seen = String(input);
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
          {
            status: 200,
          }
        );
      },
    });
    expect(text).toBe("ok");
    expect(new URL(seen).hostname).toBe("generativelanguage.googleapis.com");
  });

  it("does not send a swap while live trading is off, and refuses a SOL transfer", async () => {
    let calls = 0;
    await expect(
      executeLiveSwap({
        env: { VALHALLA_LIVE_TRADING: "false" },
        side: "buy",
        mint: "Mintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        sol: 0.02,
        fetchImpl: async () => {
          calls += 1;
          return new Response("{}", { status: 200 });
        },
        sendRaw: async () => {
          calls += 1;
          return "sig";
        },
      })
    ).rejects.toThrow(/off/);
    expect(calls).toBe(0);

    const payer = Keypair.generate();
    const ix = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: PublicKey.unique(),
      lamports: 1,
    });
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [ix],
    }).compileToV0Message();
    const bad = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
    let sent = 0;
    await expect(
      executeLiveSwap({
        env: {
          VALHALLA_LIVE_TRADING: "true",
          VALHALLA_WALLET_SECRET_KEY: bs58.encode(payer.secretKey),
          VALHALLA_PUBKEY: payer.publicKey.toBase58(),
        },
        side: "buy",
        mint: "Mintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        sol: 0.02,
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("/quote"))
            return new Response(JSON.stringify({ outAmount: "1" }), { status: 200 });
          return new Response(JSON.stringify({ swapTransaction: bad }), { status: 200 });
        },
        sendRaw: async () => {
          sent += 1;
          return "sig";
        },
      })
    ).rejects.toThrow(/transfer or withdraw/);
    expect(sent).toBe(0);
  });

  it("can submit a swap that has no system transfer", async () => {
    const payer = Keypair.generate();
    const ix = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [ix],
    }).compileToV0Message();
    const ok = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
    let sent = "";
    const result = await executeLiveSwap({
      env: {
        VALHALLA_LIVE_TRADING: "true",
        VALHALLA_WALLET_SECRET_KEY: bs58.encode(payer.secretKey),
        VALHALLA_PUBKEY: payer.publicKey.toBase58(),
      },
      side: "buy",
      mint: "Mintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      sol: 0.02,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/quote"))
          return new Response(JSON.stringify({ outAmount: "10" }), { status: 200 });
        return new Response(JSON.stringify({ swapTransaction: ok }), { status: 200 });
      },
      sendRaw: async (raw) => {
        sent = raw;
        return "paper-sig";
      },
    });
    expect(result.signature).toBe("paper-sig");
    expect(sent.length).toBeGreaterThan(10);
  });
});

describe("source scan", () => {
  it("does not commit the sweep address, a wallet file read, or a private key", () => {
    const text = walk(srcDir)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const dummySweepPubkey = Keypair.generate().publicKey.toBase58();
    expect(text).not.toContain(dummySweepPubkey);
    expect(text).not.toContain("eyJhbGci");
    expect(text).not.toContain("wallet.json");
    expect(text).not.toContain("readFileSync");
    expect(text).not.toContain("SystemProgram.transfer");
    expect(text).not.toMatch(/api-key=[A-Za-z0-9]{8,}/);
  });
});

describe("paper book", () => {
  it("opens a paper position and does not require a signature", () => {
    const now = Date.parse("2026-11-03T15:00:00Z");
    const book = createBook({ equitySol: 1, now });
    book.running = true;
    const evaluation = evaluateCoin(baseCoin(now));
    expect(evaluation.ok).toBe(true);
    const position = openPaper(book, baseCoin(now), evaluation, now);
    expect(position.paper).toBe(true);
    expect(position.signature).toBeNull();
    expect(book.freeSol).toBeCloseTo(1 - evaluation.sizeSol);
  });
});
