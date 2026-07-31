/**
 * Wallet balance-delta producer: pure materiality math plus a real-path
 * integration run — the REAL ScheduledTaskRunnerService (in-memory store), the
 * REAL contributed-channel routing, and the REAL NotificationService inbox.
 * Only the network boundary (the balance sample source) is injected; nothing
 * stands in for the producer or the notification store hook under test.
 */

import {
  type AgentRuntime,
  NotificationService,
  ServiceType,
} from "@elizaos/core";
import {
  getScheduledTaskChannelDispatcher,
  ScheduledTaskRunnerService,
} from "@elizaos/plugin-scheduling";
import type { WalletBalancesResponse } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import {
  buildWalletBalanceDeltaTaskInput,
  DEFAULT_MIN_DELTA_USD,
  DEFAULT_THRESHOLD_PCT,
  evaluateWalletBalanceDelta,
  pricedCoverageFlips,
  registerWalletBalanceDeltaProducer,
  resolveThresholds,
  sumWalletBalancesUsd,
  WALLET_BALANCE_DELTA_BASELINE_CACHE_KEY,
  WALLET_BALANCE_DELTA_GROUP_KEY,
  WALLET_BALANCE_DELTA_TASK_IDEMPOTENCY_KEY,
  type WalletBalanceBaseline,
  walletIdentityKey,
  walletIdentitySwitched,
  walletPositionPricing,
  walletSampleLegs,
} from "./wallet-balance-delta.ts";

const AGENT_ID = "00000000-0000-0000-0000-00000000a11e";

function solanaBalances(totalUsd: number): WalletBalancesResponse {
  return {
    evm: null,
    solana: {
      address: "So11111111111111111111111111111111111111112",
      solBalance: "1",
      solValueUsd: String(totalUsd),
      tokens: [],
    },
  };
}

function solanaPlusEvmBalances(
  solUsd: number,
  evmUsd: number,
): WalletBalancesResponse {
  return {
    evm: {
      address: "0xabc",
      chains: [
        {
          chain: "ethereum",
          chainId: 1,
          nativeBalance: "1",
          nativeSymbol: "ETH",
          nativeValueUsd: String(evmUsd),
          tokens: [],
          error: null,
        },
      ],
    },
    solana: {
      address: "So11111111111111111111111111111111111111112",
      solBalance: "1",
      solValueUsd: String(solUsd),
      tokens: [],
    },
  };
}

interface Harness {
  runtime: AgentRuntime;
  cache: Map<string, unknown>;
  notifications: NotificationService;
  runnerService: ScheduledTaskRunnerService;
  reported: unknown[];
  setNow(iso: string): void;
  fire(
    taskId: string,
    args?: { allowTerminalRefire?: boolean },
  ): ReturnType<
    ReturnType<ScheduledTaskRunnerService["getRunner"]>["fireWithResult"]
  >;
}

/**
 * Minimal runtime double hosting the two REAL services under test. The cache
 * map is the durable store both the producer baseline and the notification
 * inbox persist into.
 */
async function makeHarness(initialIso: string): Promise<Harness> {
  const cache = new Map<string, unknown>();
  const reported: unknown[] = [];
  let now = new Date(initialIso);
  const services = new Map<string, unknown>();
  const runtime = {
    agentId: AGENT_ID,
    initPromise: Promise.resolve(),
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
    getService: (type: string) => services.get(type) ?? null,
    hasService: (type: string) => services.has(type),
    getServiceLoadPromise: async (type: string) => {
      const service = services.get(type);
      if (!service) throw new Error(`service ${type} not registered`);
      return service;
    },
    reportError: (scope: string, error: unknown) => {
      reported.push({ scope, error });
    },
  } as unknown as AgentRuntime;

  const notifications = (await NotificationService.start(
    runtime,
  )) as NotificationService;
  services.set(ServiceType.NOTIFICATION, notifications);
  const runnerService = await ScheduledTaskRunnerService.start(runtime);
  services.set(ScheduledTaskRunnerService.serviceType, runnerService);

  return {
    runtime,
    cache,
    notifications,
    runnerService,
    reported,
    setNow(iso: string) {
      now = new Date(iso);
    },
    fire(taskId, args) {
      // Re-fetch per fire: getRunner rebinds the cached runner's clock.
      const runner = runnerService.getRunner({
        agentId: AGENT_ID,
        now: () => now,
      });
      return runner.fireWithResult(taskId, args);
    },
  };
}

describe("materiality math (pure)", () => {
  it("sums only samplable legs and never counts an errored chain as zero", () => {
    const balances: WalletBalancesResponse = {
      evm: {
        address: "0xabc",
        chains: [
          {
            chain: "ethereum",
            chainId: 1,
            nativeBalance: "1",
            nativeSymbol: "ETH",
            nativeValueUsd: "100",
            tokens: [
              {
                symbol: "USDC",
                name: "USD Coin",
                balance: "50",
                decimals: 6,
                valueUsd: "50",
                logoUrl: "",
                contractAddress: "0xusdc",
              },
            ],
            error: null,
          },
          {
            chain: "base",
            chainId: 8453,
            nativeBalance: "9",
            nativeSymbol: "ETH",
            nativeValueUsd: "9000",
            tokens: [],
            error: "rpc unreachable",
          },
        ],
      },
      solana: {
        address: "sol1",
        solBalance: "2",
        solValueUsd: "300",
        tokens: [
          {
            symbol: "JUP",
            name: "Jupiter",
            balance: "10",
            decimals: 6,
            valueUsd: "not-a-number",
            logoUrl: "",
            mint: "jup",
          },
        ],
      },
    };
    // 100 + 50 + 300; the errored base chain ($9000) is excluded, and the
    // unparseable token contributes nothing rather than poisoning the total.
    expect(sumWalletBalancesUsd(balances)).toBe(450);
    // Identity is the sampled addresses; legs exclude the errored base chain.
    expect(walletIdentityKey(balances)).toBe("evm:0xabc|sol:sol1");
    expect(walletSampleLegs(balances)).toEqual(["evm:ethereum", "sol"]);
    // The JUP position holds units but its USD value is unknown, so its
    // coverage reads unpriced; the errored base chain's positions are
    // excluded entirely along with the leg.
    expect(walletPositionPricing(balances)).toEqual({
      "evm:ethereum:native": true,
      "evm:ethereum:token:0xusdc": true,
      "sol:native": true,
      "sol:token:jup": false,
    });
  });

  it("a wallet switch flips the identity; adding or dropping a leg family does not", () => {
    // Same sol address, EVM leg added → composition change, not a switch.
    expect(walletIdentitySwitched("sol:abc", "evm:0x1|sol:abc")).toBe(false);
    // EVM leg removed, sol retained → not a switch either.
    expect(walletIdentitySwitched("evm:0x1|sol:abc", "sol:abc")).toBe(false);
    // A retained family's address changed → switch, on either family.
    expect(walletIdentitySwitched("sol:abc", "sol:xyz")).toBe(true);
    expect(walletIdentitySwitched("evm:0x1|sol:abc", "evm:0x2|sol:abc")).toBe(
      true,
    );
  });

  it("price coverage is tracked per position: flips on held positions register, pure value moves and new positions do not", () => {
    const priced: WalletBalancesResponse = {
      evm: {
        address: "0xabc",
        chains: [
          {
            chain: "ethereum",
            chainId: 1,
            nativeBalance: "1",
            nativeSymbol: "ETH",
            nativeValueUsd: "100",
            tokens: [
              {
                symbol: "USDC",
                name: "USD Coin",
                balance: "50",
                decimals: 6,
                valueUsd: "50",
                logoUrl: "",
                contractAddress: "0xUSDC",
              },
              {
                // Zero-unit position: valueUsd "0" is legitimately zero, not
                // "price unknown" — it must NOT read as an unpriced position.
                symbol: "DUST",
                name: "Dust",
                balance: "0",
                decimals: 18,
                valueUsd: "0",
                logoUrl: "",
                contractAddress: "0xdust",
              },
            ],
            error: null,
          },
        ],
      },
      solana: null,
    };
    const pricedCoverage = walletPositionPricing(priced);
    // The zero-unit DUST position carries no pricing signal and is absent.
    expect(pricedCoverage).toEqual({
      "evm:ethereum:native": true,
      "evm:ethereum:token:0xusdc": true,
    });

    // Price outage: same units, values collapse to the upstream "0"-means-
    // unknown encoding — both held positions flip to unpriced, so the
    // dispatcher re-baselines instead of reading a ~100% balance drop.
    const outage: WalletBalancesResponse = structuredClone(priced);
    if (!outage.evm) throw new Error("evm leg missing");
    const chain = outage.evm.chains[0];
    if (!chain) throw new Error("chain missing");
    chain.nativeValueUsd = "0";
    const usdc = chain.tokens[0];
    if (!usdc) throw new Error("usdc missing");
    usdc.valueUsd = "0";
    expect(walletPositionPricing(outage)).toEqual({
      "evm:ethereum:native": false,
      "evm:ethereum:token:0xusdc": false,
    });
    expect(
      pricedCoverageFlips(pricedCoverage, walletPositionPricing(outage)),
    ).toEqual(["evm:ethereum:native", "evm:ethereum:token:0xusdc"]);

    // A pure value move (units and coverage unchanged) flips nothing —
    // genuine deltas still flow to the notify path.
    const moved: WalletBalancesResponse = structuredClone(priced);
    if (!moved.evm?.chains[0]) throw new Error("chain missing");
    moved.evm.chains[0].nativeValueUsd = "40";
    expect(
      pricedCoverageFlips(pricedCoverage, walletPositionPricing(moved)),
    ).toEqual([]);

    // A position only one sample holds (new arrival / sold out) is a real
    // balance event, never a coverage flip.
    expect(
      pricedCoverageFlips(pricedCoverage, {
        ...pricedCoverage,
        "evm:ethereum:token:0xspam": false,
      }),
    ).toEqual([]);
    expect(
      pricedCoverageFlips(
        { ...pricedCoverage, "evm:ethereum:token:0xgone": true },
        pricedCoverage,
      ),
    ).toEqual([]);
  });

  it("requires BOTH the USD floor and the percent threshold", () => {
    const thresholds = { minDeltaUsd: 10, thresholdPct: 10 };
    // $9 move on $50: fails the floor.
    expect(
      evaluateWalletBalanceDelta({
        baselineUsd: 50,
        currentUsd: 59,
        thresholds,
      }).material,
    ).toBe(false);
    // $50 move on $10k: clears the floor, fails 10%.
    expect(
      evaluateWalletBalanceDelta({
        baselineUsd: 10_000,
        currentUsd: 10_050,
        thresholds,
      }).material,
    ).toBe(false);
    // $1500 move on $10k: clears both.
    const material = evaluateWalletBalanceDelta({
      baselineUsd: 10_000,
      currentUsd: 8_500,
      thresholds,
    });
    expect(material.material).toBe(true);
    expect(material.deltaUsd).toBe(-1500);
    expect(material.deltaPct).toBe(-15);
    // Empty wallet funded: percent clause is vacuous, floor decides.
    expect(
      evaluateWalletBalanceDelta({
        baselineUsd: 0,
        currentUsd: 25,
        thresholds,
      }).material,
    ).toBe(true);
    expect(
      evaluateWalletBalanceDelta({
        baselineUsd: 0,
        currentUsd: 5,
        thresholds,
      }).material,
    ).toBe(false);
  });

  it("falls back to defaults on missing or garbage threshold metadata", () => {
    expect(resolveThresholds(undefined)).toEqual({
      minDeltaUsd: DEFAULT_MIN_DELTA_USD,
      thresholdPct: DEFAULT_THRESHOLD_PCT,
    });
    expect(
      resolveThresholds({
        walletBalanceDelta: { minDeltaUsd: -5, thresholdPct: "loud" },
      }),
    ).toEqual({
      minDeltaUsd: DEFAULT_MIN_DELTA_USD,
      thresholdPct: DEFAULT_THRESHOLD_PCT,
    });
    expect(
      resolveThresholds({
        walletBalanceDelta: { minDeltaUsd: 2, thresholdPct: 25 },
      }),
    ).toEqual({ minDeltaUsd: 2, thresholdPct: 25 });
  });
});

describe("balance-delta watcher — real runner + real notification inbox", () => {
  it("stands down without partial registration when the scheduling runtime is inactive", async () => {
    const reportError = vi.fn();
    const source = vi.fn(async () => solanaBalances(100));
    const runtime = {
      agentId: AGENT_ID,
      hasService: () => false,
      reportError,
    } as unknown as AgentRuntime;

    await expect(
      registerWalletBalanceDeltaProducer(runtime, { source }),
    ).resolves.toBeUndefined();

    expect(
      getScheduledTaskChannelDispatcher(runtime, "wallet_balance_delta"),
    ).toBeNull();
    expect(source).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("records a baseline, notifies on a material move, coalesces repeats, and keeps failures honest", async () => {
    const h = await makeHarness("2026-07-23T10:00:00.000Z");

    let sample: (() => WalletBalancesResponse | null) | (() => never) = () =>
      solanaBalances(100);
    await registerWalletBalanceDeltaProducer(h.runtime, {
      source: async () => sample(),
    });

    // Seeded exactly once; re-scheduling the same input is idempotent.
    const runner = h.runnerService.getRunner({ agentId: AGENT_ID });
    const tasks = await runner.list();
    const watcher = tasks.find(
      (t) => t.idempotencyKey === WALLET_BALANCE_DELTA_TASK_IDEMPOTENCY_KEY,
    );
    expect(watcher).toBeDefined();
    if (!watcher) throw new Error("watcher not scheduled");
    expect(watcher.kind).toBe("watcher");
    expect(watcher.trigger).toEqual({ kind: "interval", everyMinutes: 30 });
    const again = await runner.schedule(
      buildWalletBalanceDeltaTaskInput(AGENT_ID),
    );
    expect(again.taskId).toBe(watcher.taskId);

    // Fire 1: first observation records the baseline, no notification.
    const first = await h.fire(watcher.taskId);
    expect(first.kind).toBe("fired");
    expect(h.notifications.list()).toHaveLength(0);
    const baseline1 = h.cache.get(
      WALLET_BALANCE_DELTA_BASELINE_CACHE_KEY,
    ) as WalletBalanceBaseline;
    expect(baseline1).toMatchObject({
      walletKey: "sol:So11111111111111111111111111111111111111112",
      totalUsd: 100,
      sampleLegs: ["sol"],
    });

    // Fire 2 (+31m): a $5 move fails the $10 floor — silent.
    sample = () => solanaBalances(95);
    h.setNow("2026-07-23T10:31:00.000Z");
    const second = await h.fire(watcher.taskId, { allowTerminalRefire: true });
    expect(second.kind).toBe("fired");
    expect(h.notifications.list()).toHaveLength(0);
    // Baseline is anchored to the last NOTIFIED total, not the last sample —
    // slow drift cannot creep under the threshold forever.
    expect(
      (
        h.cache.get(
          WALLET_BALANCE_DELTA_BASELINE_CACHE_KEY,
        ) as WalletBalanceBaseline
      ).totalUsd,
    ).toBe(100);

    // Fire 3 (+62m): +$50 on $100 clears both thresholds → REAL notification
    // lands in the REAL inbox.
    sample = () => solanaBalances(150);
    h.setNow("2026-07-23T11:02:00.000Z");
    const third = await h.fire(watcher.taskId, { allowTerminalRefire: true });
    expect(third.kind).toBe("fired");
    const inbox = h.notifications.list();
    expect(inbox).toHaveLength(1);
    const note = inbox[0];
    if (!note) throw new Error("notification missing");
    expect(note.title).toBe("Wallet balance up");
    expect(note.category).toBe("general");
    expect(note.priority).toBe("normal");
    expect(note.source).toBe("wallet");
    expect(note.deepLink).toBe("/wallet");
    expect(note.groupKey).toBe(WALLET_BALANCE_DELTA_GROUP_KEY);
    // Lock-screen-safe copy: percent only, no dollar figures.
    expect(note.body).toContain("50.0%");
    expect(note.body ?? "").not.toContain("$");
    expect(note.title).not.toContain("$");
    // The dollar detail travels in data for in-app consumers.
    expect(note.data).toMatchObject({
      previousTotalUsd: 100,
      currentTotalUsd: 150,
      deltaUsd: 50,
      deltaPct: 50,
    });
    expect(
      (
        h.cache.get(
          WALLET_BALANCE_DELTA_BASELINE_CACHE_KEY,
        ) as WalletBalanceBaseline
      ).totalUsd,
    ).toBe(150);

    // Fire 4 (+93m): the sample source fails — typed retryable dispatch
    // failure, baseline untouched, NO fabricated "wallet is empty" delta.
    sample = () => {
      throw new Error("rpc down");
    };
    h.setNow("2026-07-23T11:33:00.000Z");
    const fourth = await h.fire(watcher.taskId, { allowTerminalRefire: true });
    expect(fourth.kind).toBe("dispatch_deferred");
    expect(h.notifications.list()).toHaveLength(1);
    expect(
      (
        h.cache.get(
          WALLET_BALANCE_DELTA_BASELINE_CACHE_KEY,
        ) as WalletBalanceBaseline
      ).totalUsd,
    ).toBe(150);
    expect(h.reported.length).toBeGreaterThan(0);

    // Fire 5: a NEW samplable leg appears with a huge total — that is a
    // sampling-composition change, so re-baseline silently, never notify.
    sample = () => solanaPlusEvmBalances(150, 350);
    h.setNow("2026-07-23T11:50:00.000Z");
    const fifth = await h.fire(watcher.taskId);
    expect(fifth.kind).toBe("fired");
    expect(h.notifications.list()).toHaveLength(1);
    if (fifth.kind === "fired") {
      // The sol address is retained, so this is a leg-composition change —
      // NOT a wallet switch.
      expect(fifth.task.metadata?.lastDispatchResult).toMatchObject({
        ok: true,
        target: "rebaselined_leg_change",
      });
    }
    const rebased = h.cache.get(
      WALLET_BALANCE_DELTA_BASELINE_CACHE_KEY,
    ) as WalletBalanceBaseline;
    expect(rebased.totalUsd).toBe(500);
    expect(rebased.sampleLegs).toEqual(["evm:ethereum", "sol"]);
    expect(rebased.walletKey).toBe(
      "evm:0xabc|sol:So11111111111111111111111111111111111111112",
    );

    // Fire 6 (+later): a second material move coalesces onto the same
    // groupKey — one inbox row carrying the supersede count (§C.3).
    sample = () => solanaPlusEvmBalances(100, 300);
    h.setNow("2026-07-23T12:21:00.000Z");
    const sixth = await h.fire(watcher.taskId, { allowTerminalRefire: true });
    expect(sixth.kind).toBe("fired");
    const coalesced = h.notifications.list();
    expect(coalesced).toHaveLength(1);
    expect(coalesced[0]?.title).toBe("Wallet balance down");
    expect(coalesced[0]?.data).toMatchObject({
      previousTotalUsd: 500,
      currentTotalUsd: 400,
      deltaUsd: -100,
      deltaPct: -20,
      count: 2,
    });
  });

  it("a price-feed outage (values collapse, units unchanged) re-baselines silently — and a later genuine unit drop still notifies", async () => {
    const solanaPricedToken = (args: {
      solUnits: string;
      solUsd: string;
      tokenUsd: string;
    }): WalletBalancesResponse => ({
      evm: null,
      solana: {
        address: "So11111111111111111111111111111111111111112",
        solBalance: args.solUnits,
        solValueUsd: args.solUsd,
        tokens: [
          {
            symbol: "JUP",
            name: "Jupiter",
            balance: "10",
            decimals: 6,
            valueUsd: args.tokenUsd,
            logoUrl: "",
            mint: "jup",
          },
        ],
      },
    });
    const h = await makeHarness("2026-07-23T10:00:00.000Z");
    let sample: () => WalletBalancesResponse = () =>
      solanaPricedToken({ solUnits: "2", solUsd: "200", tokenUsd: "50" });
    await registerWalletBalanceDeltaProducer(h.runtime, {
      source: async () => sample(),
    });
    const runner = h.runnerService.getRunner({ agentId: AGENT_ID });
    const watcher = (await runner.list()).find(
      (t) => t.idempotencyKey === WALLET_BALANCE_DELTA_TASK_IDEMPOTENCY_KEY,
    );
    if (!watcher) throw new Error("watcher not scheduled");

    // Baseline at $250, all positions priced.
    const first = await h.fire(watcher.taskId);
    expect(first.kind).toBe("fired");
    expect(h.notifications.list()).toHaveLength(0);

    // Price outage: dexscreener/geckoterminal down — upstream reports the
    // SAME units with valueUsd "0" and no error, a ~100% USD collapse. The
    // coverage entries change the fingerprint, so the watcher re-baselines
    // silently instead of emitting "Wallet balance down ~100%".
    sample = () =>
      solanaPricedToken({ solUnits: "2", solUsd: "0", tokenUsd: "0" });
    h.setNow("2026-07-23T10:31:00.000Z");
    const outage = await h.fire(watcher.taskId, { allowTerminalRefire: true });
    expect(outage.kind).toBe("fired");
    expect(h.notifications.list()).toHaveLength(0);
    if (outage.kind === "fired") {
      expect(outage.task.metadata?.lastDispatchResult).toMatchObject({
        ok: true,
        target: "rebaselined_price_coverage_change",
      });
    }
    const collapsed = h.cache.get(
      WALLET_BALANCE_DELTA_BASELINE_CACHE_KEY,
    ) as WalletBalanceBaseline;
    expect(collapsed.totalUsd).toBe(0);
    expect(collapsed.positionPricing).toEqual({
      "sol:native": false,
      "sol:token:jup": false,
    });

    // Recovery: prices return at the old level — again a coverage change, so
    // no matching "Wallet balance up" flap either.
    sample = () =>
      solanaPricedToken({ solUnits: "2", solUsd: "200", tokenUsd: "50" });
    h.setNow("2026-07-23T11:02:00.000Z");
    const recovery = await h.fire(watcher.taskId, {
      allowTerminalRefire: true,
    });
    expect(recovery.kind).toBe("fired");
    expect(h.notifications.list()).toHaveLength(0);
    if (recovery.kind === "fired") {
      expect(recovery.task.metadata?.lastDispatchResult).toMatchObject({
        ok: true,
        target: "rebaselined_price_coverage_change",
      });
    }
    expect(
      (
        h.cache.get(
          WALLET_BALANCE_DELTA_BASELINE_CACHE_KEY,
        ) as WalletBalanceBaseline
      ).totalUsd,
    ).toBe(250);

    // Genuine drop: the UNITS move (2 SOL → 1 SOL) with prices intact —
    // coverage unchanged, so the material delta still notifies.
    sample = () =>
      solanaPricedToken({ solUnits: "1", solUsd: "100", tokenUsd: "50" });
    h.setNow("2026-07-23T11:33:00.000Z");
    const drop = await h.fire(watcher.taskId, { allowTerminalRefire: true });
    expect(drop.kind).toBe("fired");
    const inbox = h.notifications.list();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.title).toBe("Wallet balance down");
    expect(inbox[0]?.data).toMatchObject({
      previousTotalUsd: 250,
      currentTotalUsd: 150,
      deltaUsd: -100,
      deltaPct: -40,
    });
  });

  it("a NEW unpriced position (spam airdrop) never swallows a concurrent material drop in priced holdings", async () => {
    const wallet = (args: {
      solBalance: string;
      solValueUsd: string;
      tokens?: Array<{ mint: string; balance: string; valueUsd: string }>;
    }): WalletBalancesResponse => ({
      evm: null,
      solana: {
        address: "So11111111111111111111111111111111111111112",
        solBalance: args.solBalance,
        solValueUsd: args.solValueUsd,
        tokens: (args.tokens ?? []).map((t) => ({
          symbol: "SPAM",
          name: "Spam Coin",
          balance: t.balance,
          decimals: 6,
          valueUsd: t.valueUsd,
          logoUrl: "",
          mint: t.mint,
        })),
      },
    });
    const h = await makeHarness("2026-07-23T10:00:00.000Z");
    // Baseline: 10 SOL, fully priced at $100, no tokens.
    let sample: () => WalletBalancesResponse = () =>
      wallet({ solBalance: "10", solValueUsd: "100" });
    await registerWalletBalanceDeltaProducer(h.runtime, {
      source: async () => sample(),
    });
    const runner = h.runnerService.getRunner({ agentId: AGENT_ID });
    const watcher = (await runner.list()).find(
      (t) => t.idempotencyKey === WALLET_BALANCE_DELTA_TASK_IDEMPOTENCY_KEY,
    );
    if (!watcher) throw new Error("watcher not scheduled");
    const first = await h.fire(watcher.taskId);
    expect(first.kind).toBe("fired");
    expect(h.notifications.list()).toHaveLength(0);

    // Next poll: a spam airdrop (99999 units, price unknown) appeared AND the
    // SOL leg dropped 10 → 2 units ($100 → $20). The airdrop contributes $0
    // to the priced total, so the totals stay apples-to-apples — the material
    // priced-holdings drop MUST notify, never re-baseline away.
    sample = () =>
      wallet({
        solBalance: "2",
        solValueUsd: "20",
        tokens: [{ mint: "spamcoin", balance: "99999", valueUsd: "0" }],
      });
    h.setNow("2026-07-23T10:31:00.000Z");
    const second = await h.fire(watcher.taskId, { allowTerminalRefire: true });
    expect(second.kind).toBe("fired");
    const inbox = h.notifications.list();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.title).toBe("Wallet balance down");
    expect(inbox[0]?.data).toMatchObject({
      previousTotalUsd: 100,
      currentTotalUsd: 20,
      deltaUsd: -80,
      deltaPct: -80,
    });

    // The spam position is absorbed into the new baseline: if its price feed
    // later lists it (fake liquidity pump), that priced↔unpriced flip is a
    // coverage change on a known position — re-baseline, not a "+4000%" flap.
    sample = () =>
      wallet({
        solBalance: "2",
        solValueUsd: "20",
        tokens: [{ mint: "spamcoin", balance: "99999", valueUsd: "820" }],
      });
    h.setNow("2026-07-23T11:02:00.000Z");
    const third = await h.fire(watcher.taskId, { allowTerminalRefire: true });
    expect(third.kind).toBe("fired");
    expect(h.notifications.list()).toHaveLength(1);
    if (third.kind === "fired") {
      expect(third.task.metadata?.lastDispatchResult).toMatchObject({
        ok: true,
        target: "rebaselined_price_coverage_change",
      });
    }
  });

  it("absorbs a new position's coverage on a below-threshold tick, so a later price listing reads as a flip, not a pump notification", async () => {
    const wallet = (
      solValueUsd: string,
      spamValueUsd: string | null,
    ): WalletBalancesResponse => ({
      evm: null,
      solana: {
        address: "So11111111111111111111111111111111111111112",
        solBalance: "10",
        solValueUsd,
        tokens:
          spamValueUsd === null
            ? []
            : [
                {
                  symbol: "SPAM",
                  name: "Spam Coin",
                  balance: "99999",
                  decimals: 6,
                  valueUsd: spamValueUsd,
                  logoUrl: "",
                  mint: "spamcoin",
                },
              ],
      },
    });
    const h = await makeHarness("2026-07-23T10:00:00.000Z");
    let sample: () => WalletBalancesResponse = () => wallet("100", null);
    await registerWalletBalanceDeltaProducer(h.runtime, {
      source: async () => sample(),
    });
    const runner = h.runnerService.getRunner({ agentId: AGENT_ID });
    const watcher = (await runner.list()).find(
      (t) => t.idempotencyKey === WALLET_BALANCE_DELTA_TASK_IDEMPOTENCY_KEY,
    );
    if (!watcher) throw new Error("watcher not scheduled");
    const first = await h.fire(watcher.taskId);
    expect(first.kind).toBe("fired");

    // Spam arrives unpriced alongside an immaterial $5 drift: no notification,
    // the anchor total stays at $100 (drift must accumulate), but the
    // coverage map absorbs the new position.
    sample = () => wallet("95", "0");
    h.setNow("2026-07-23T10:31:00.000Z");
    const second = await h.fire(watcher.taskId, { allowTerminalRefire: true });
    expect(second.kind).toBe("fired");
    if (second.kind === "fired") {
      expect(second.task.metadata?.lastDispatchResult).toMatchObject({
        ok: true,
        target: "below_threshold",
      });
    }
    expect(h.notifications.list()).toHaveLength(0);
    const absorbed = h.cache.get(
      WALLET_BALANCE_DELTA_BASELINE_CACHE_KEY,
    ) as WalletBalanceBaseline;
    expect(absorbed.totalUsd).toBe(100);
    expect(absorbed.positionPricing).toEqual({
      "sol:native": true,
      "sol:token:spamcoin": false,
    });

    // A price feed later lists the spam token at a fake-liquidity $800: that
    // is a coverage flip on a known position — silent re-baseline of the
    // flipped contribution only, not a "wallet up 800%" notification. The
    // residual anchor is preserved: SOL's immaterial $5 drift is NOT
    // re-anchored away, so the new baseline is anchor $100 + spam $800 =
    // $900, not the raw $895 sample.
    sample = () => wallet("95", "800");
    h.setNow("2026-07-23T11:02:00.000Z");
    const third = await h.fire(watcher.taskId, { allowTerminalRefire: true });
    expect(third.kind).toBe("fired");
    if (third.kind === "fired") {
      expect(third.task.metadata?.lastDispatchResult).toMatchObject({
        ok: true,
        target: "rebaselined_price_coverage_change",
      });
    }
    expect(h.notifications.list()).toHaveLength(0);
    expect(
      (
        h.cache.get(
          WALLET_BALANCE_DELTA_BASELINE_CACHE_KEY,
        ) as WalletBalanceBaseline
      ).totalUsd,
    ).toBe(900);
  });

  it("an attacker-timed price listing on a spam token cannot rebaseline away a concurrent material crash in priced holdings", async () => {
    const wallet = (args: {
      solValueUsd: string;
      spamValueUsd: string;
    }): WalletBalancesResponse => ({
      evm: null,
      solana: {
        address: "So11111111111111111111111111111111111111112",
        solBalance: "10",
        solValueUsd: args.solValueUsd,
        tokens: [
          {
            symbol: "SPAM",
            name: "Spam Coin",
            balance: "99999",
            decimals: 6,
            valueUsd: args.spamValueUsd,
            logoUrl: "",
            mint: "spamcoin",
          },
        ],
      },
    });
    const h = await makeHarness("2026-07-23T10:00:00.000Z");
    // Baseline: 10 SOL priced at $100 plus an already-held unpriced spam
    // airdrop (contributes $0).
    let sample: () => WalletBalancesResponse = () =>
      wallet({ solValueUsd: "100", spamValueUsd: "0" });
    await registerWalletBalanceDeltaProducer(h.runtime, {
      source: async () => sample(),
    });
    const runner = h.runnerService.getRunner({ agentId: AGENT_ID });
    const watcher = (await runner.list()).find(
      (t) => t.idempotencyKey === WALLET_BALANCE_DELTA_TASK_IDEMPOTENCY_KEY,
    );
    if (!watcher) throw new Error("watcher not scheduled");
    const first = await h.fire(watcher.taskId);
    expect(first.kind).toBe("fired");
    expect(h.notifications.list()).toHaveLength(0);

    // Attacker-timed coverage flip: the spam token gets a dexscreener listing
    // (fake liquidity, $500) on the SAME tick SOL crashes $100 → $20. The
    // flip makes only the spam position incomparable — the residual priced
    // holdings moved materially and MUST notify; a whole-total re-baseline
    // here would let anyone with a spam token mute real crashes at will.
    sample = () => wallet({ solValueUsd: "20", spamValueUsd: "500" });
    h.setNow("2026-07-23T10:31:00.000Z");
    const second = await h.fire(watcher.taskId, { allowTerminalRefire: true });
    expect(second.kind).toBe("fired");
    const inbox = h.notifications.list();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.title).toBe("Wallet balance down");
    // The comparison excludes the flipped spam position from BOTH sides:
    // $100 residual baseline vs $20 residual current.
    expect(inbox[0]?.data).toMatchObject({
      previousTotalUsd: 100,
      currentTotalUsd: 20,
      deltaUsd: -80,
      deltaPct: -80,
    });
  });

  it("a flapping coverage bit on one dust position cannot permanently mute the watcher, and the flap surfaces via reportError", async () => {
    const wallet = (args: {
      solValueUsd: string;
      dustValueUsd: string;
    }): WalletBalancesResponse => ({
      evm: null,
      solana: {
        address: "So11111111111111111111111111111111111111112",
        solBalance: "10",
        solValueUsd: args.solValueUsd,
        tokens: [
          {
            symbol: "DUST",
            name: "Dust Coin",
            balance: "5",
            decimals: 6,
            valueUsd: args.dustValueUsd,
            logoUrl: "",
            mint: "dusty",
          },
        ],
      },
    });
    const h = await makeHarness("2026-07-23T10:00:00.000Z");
    const coverageFlapReports = () =>
      h.reported.filter(
        (r) =>
          (r as { scope?: string }).scope === "WalletBalanceDelta.coverageFlap",
      );
    // Baseline: SOL $100 plus a dust token priced at $1.
    let sample: () => WalletBalancesResponse = () =>
      wallet({ solValueUsd: "100", dustValueUsd: "1" });
    await registerWalletBalanceDeltaProducer(h.runtime, {
      source: async () => sample(),
    });
    const runner = h.runnerService.getRunner({ agentId: AGENT_ID });
    const watcher = (await runner.list()).find(
      (t) => t.idempotencyKey === WALLET_BALANCE_DELTA_TASK_IDEMPOTENCY_KEY,
    );
    if (!watcher) throw new Error("watcher not scheduled");
    const first = await h.fire(watcher.taskId);
    expect(first.kind).toBe("fired");
    expect(h.notifications.list()).toHaveLength(0);

    // The dust token's price feed flaps priced↔unpriced on EVERY tick while
    // SOL drifts down $3/tick. Each flap tick may re-baseline only the dust
    // position's own contribution — the SOL drift must keep accumulating
    // toward the thresholds instead of being re-anchored away every 30 min.
    sample = () => wallet({ solValueUsd: "97", dustValueUsd: "0" });
    h.setNow("2026-07-23T10:31:00.000Z");
    const flap1 = await h.fire(watcher.taskId, { allowTerminalRefire: true });
    expect(flap1.kind).toBe("fired");
    expect(h.notifications.list()).toHaveLength(0);
    expect(coverageFlapReports()).toHaveLength(0);

    sample = () => wallet({ solValueUsd: "94", dustValueUsd: "1" });
    h.setNow("2026-07-23T11:02:00.000Z");
    const flap2 = await h.fire(watcher.taskId, { allowTerminalRefire: true });
    expect(flap2.kind).toBe("fired");
    expect(h.notifications.list()).toHaveLength(0);
    expect(coverageFlapReports()).toHaveLength(0);

    // Third silent coverage re-baseline inside the flap window: the repeated
    // flap is a systemic price-feed problem and must surface observably
    // (runtime.reportError → RECENT_ERRORS), not sit at debug forever.
    sample = () => wallet({ solValueUsd: "91", dustValueUsd: "0" });
    h.setNow("2026-07-23T11:33:00.000Z");
    const flap3 = await h.fire(watcher.taskId, { allowTerminalRefire: true });
    expect(flap3.kind).toBe("fired");
    expect(h.notifications.list()).toHaveLength(0);
    expect(coverageFlapReports().length).toBeGreaterThan(0);

    // The accumulated SOL drift ($100 → $85) is now material against the
    // preserved anchor even though THIS tick also flips the dust bit — the
    // watcher is not muted by the flap.
    sample = () => wallet({ solValueUsd: "85", dustValueUsd: "1" });
    h.setNow("2026-07-23T12:04:00.000Z");
    const fifth = await h.fire(watcher.taskId, { allowTerminalRefire: true });
    expect(fifth.kind).toBe("fired");
    const inbox = h.notifications.list();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.title).toBe("Wallet balance down");
    expect(inbox[0]?.data).toMatchObject({
      previousTotalUsd: 100,
      currentTotalUsd: 85,
      deltaUsd: -15,
      deltaPct: -15,
    });
  });

  it("a legacy pre-wallet-scoped baseline row is discarded, never compared against", async () => {
    const h = await makeHarness("2026-07-23T10:00:00.000Z");
    // Shape written by the original producer (no walletKey/positionPricing).
    h.cache.set(WALLET_BALANCE_DELTA_BASELINE_CACHE_KEY, {
      totalUsd: 100,
      sampleFingerprint: ["sol"],
      observedAtIso: "2026-07-22T10:00:00.000Z",
    });
    await registerWalletBalanceDeltaProducer(h.runtime, {
      source: async () => solanaBalances(5000),
    });
    const runner = h.runnerService.getRunner({ agentId: AGENT_ID });
    const watcher = (await runner.list()).find(
      (t) => t.idempotencyKey === WALLET_BALANCE_DELTA_TASK_IDEMPOTENCY_KEY,
    );
    if (!watcher) throw new Error("watcher not scheduled");
    const outcome = await h.fire(watcher.taskId);
    expect(outcome.kind).toBe("fired");
    if (outcome.kind === "fired") {
      expect(outcome.task.metadata?.lastDispatchResult).toMatchObject({
        ok: true,
        target: "baseline_recorded",
      });
    }
    expect(h.notifications.list()).toHaveLength(0);
    const migrated = h.cache.get(
      WALLET_BALANCE_DELTA_BASELINE_CACHE_KEY,
    ) as WalletBalanceBaseline;
    expect(migrated.totalUsd).toBe(5000);
    expect(migrated.walletKey).toBe(
      "sol:So11111111111111111111111111111111111111112",
    );
  });

  it("a coverage-bits-only baseline row (#17039 shape) is discarded, never compared against", async () => {
    const h = await makeHarness("2026-07-23T10:00:00.000Z");
    // Shape written before per-position values existed: coverage booleans
    // only. Without positionValuesUsd the residual math cannot excise a
    // flipped position, so the row must be treated as no-baseline (one
    // designed silent re-baseline on upgrade), never compared against.
    h.cache.set(WALLET_BALANCE_DELTA_BASELINE_CACHE_KEY, {
      walletKey: "sol:So11111111111111111111111111111111111111112",
      totalUsd: 100,
      sampleLegs: ["sol"],
      positionPricing: { "sol:native": true },
      observedAtIso: "2026-07-22T10:00:00.000Z",
    });
    await registerWalletBalanceDeltaProducer(h.runtime, {
      source: async () => solanaBalances(5000),
    });
    const runner = h.runnerService.getRunner({ agentId: AGENT_ID });
    const watcher = (await runner.list()).find(
      (t) => t.idempotencyKey === WALLET_BALANCE_DELTA_TASK_IDEMPOTENCY_KEY,
    );
    if (!watcher) throw new Error("watcher not scheduled");
    const outcome = await h.fire(watcher.taskId);
    expect(outcome.kind).toBe("fired");
    if (outcome.kind === "fired") {
      expect(outcome.task.metadata?.lastDispatchResult).toMatchObject({
        ok: true,
        target: "baseline_recorded",
      });
    }
    expect(h.notifications.list()).toHaveLength(0);
    const migrated = h.cache.get(
      WALLET_BALANCE_DELTA_BASELINE_CACHE_KEY,
    ) as WalletBalanceBaseline;
    expect(migrated.totalUsd).toBe(5000);
    expect(migrated.positionValuesUsd).toEqual({ "sol:native": 5000 });
    expect(migrated.coverageFlapCount).toBe(0);
  });

  it("switching to a different wallet resets the baseline — never a fabricated cross-wallet delta", async () => {
    const solanaAt = (
      address: string,
      usd: number,
    ): WalletBalancesResponse => ({
      evm: null,
      solana: {
        address,
        solBalance: "1",
        solValueUsd: String(usd),
        tokens: [],
      },
    });
    const h = await makeHarness("2026-07-23T10:00:00.000Z");
    let sample: () => WalletBalancesResponse = () =>
      solanaAt("WaLLetAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 100);
    await registerWalletBalanceDeltaProducer(h.runtime, {
      source: async () => sample(),
    });
    const runner = h.runnerService.getRunner({ agentId: AGENT_ID });
    const watcher = (await runner.list()).find(
      (t) => t.idempotencyKey === WALLET_BALANCE_DELTA_TASK_IDEMPOTENCY_KEY,
    );
    if (!watcher) throw new Error("watcher not scheduled");
    const first = await h.fire(watcher.taskId);
    expect(first.kind).toBe("fired");
    expect(h.notifications.list()).toHaveLength(0);

    // Owner imports a different wallet. Same leg shape, wildly different
    // total — comparing wallet B's balance against wallet A's baseline would
    // fabricate a "+4900%" notification. The fingerprint is wallet-scoped, so
    // the switch resets the baseline cleanly and silently.
    sample = () =>
      solanaAt("WaLLetBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", 5000);
    h.setNow("2026-07-23T10:31:00.000Z");
    const switched = await h.fire(watcher.taskId, {
      allowTerminalRefire: true,
    });
    expect(switched.kind).toBe("fired");
    expect(h.notifications.list()).toHaveLength(0);
    if (switched.kind === "fired") {
      expect(switched.task.metadata?.lastDispatchResult).toMatchObject({
        ok: true,
        target: "rebaselined_wallet_changed",
      });
    }
    const rebased = h.cache.get(
      WALLET_BALANCE_DELTA_BASELINE_CACHE_KEY,
    ) as WalletBalanceBaseline;
    expect(rebased.totalUsd).toBe(5000);

    // The reset is a clean first read for wallet B: a genuine material move
    // on B still notifies against B's OWN baseline.
    sample = () =>
      solanaAt("WaLLetBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", 4000);
    h.setNow("2026-07-23T11:02:00.000Z");
    const move = await h.fire(watcher.taskId, { allowTerminalRefire: true });
    expect(move.kind).toBe("fired");
    const inbox = h.notifications.list();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.title).toBe("Wallet balance down");
    expect(inbox[0]?.data).toMatchObject({
      previousTotalUsd: 5000,
      currentTotalUsd: 4000,
      deltaUsd: -1000,
      deltaPct: -20,
    });
  });

  it("reports a designed no-op when no wallet is configured — never an empty-wallet baseline", async () => {
    const h = await makeHarness("2026-07-23T09:00:00.000Z");
    await registerWalletBalanceDeltaProducer(h.runtime, {
      source: async () => null,
    });
    const runner = h.runnerService.getRunner({ agentId: AGENT_ID });
    const watcher = (await runner.list()).find(
      (t) => t.idempotencyKey === WALLET_BALANCE_DELTA_TASK_IDEMPOTENCY_KEY,
    );
    if (!watcher) throw new Error("watcher not scheduled");
    const outcome = await h.fire(watcher.taskId);
    expect(outcome.kind).toBe("fired");
    expect(h.notifications.list()).toHaveLength(0);
    expect(h.cache.has(WALLET_BALANCE_DELTA_BASELINE_CACHE_KEY)).toBe(false);
    if (outcome.kind === "fired") {
      expect(outcome.task.metadata?.lastDispatchResult).toMatchObject({
        ok: true,
        target: "no_wallet_configured",
      });
    }
  });
});
