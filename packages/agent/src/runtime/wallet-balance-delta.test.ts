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
import { ScheduledTaskRunnerService } from "@elizaos/plugin-scheduling";
import type { WalletBalancesResponse } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  buildWalletBalanceDeltaTaskInput,
  DEFAULT_MIN_DELTA_USD,
  DEFAULT_THRESHOLD_PCT,
  evaluateWalletBalanceDelta,
  registerWalletBalanceDeltaProducer,
  resolveThresholds,
  sumWalletBalancesUsd,
  WALLET_BALANCE_DELTA_BASELINE_CACHE_KEY,
  WALLET_BALANCE_DELTA_GROUP_KEY,
  WALLET_BALANCE_DELTA_TASK_IDEMPOTENCY_KEY,
  type WalletBalanceBaseline,
  walletSampleFingerprint,
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
    expect(walletSampleFingerprint(balances)).toEqual(["evm:ethereum", "sol"]);
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
    expect(baseline1).toMatchObject({ totalUsd: 100, sampledLegs: ["sol"] });

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
    const rebased = h.cache.get(
      WALLET_BALANCE_DELTA_BASELINE_CACHE_KEY,
    ) as WalletBalanceBaseline;
    expect(rebased.totalUsd).toBe(500);
    expect(rebased.sampledLegs).toEqual(["evm:ethereum", "sol"]);

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
