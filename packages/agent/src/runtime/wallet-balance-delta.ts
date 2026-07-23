/**
 * Producer-side wallet balance-delta notifications. The home spec demoted the
 * `wallet.balance` resident card (NOTIFICATIONS-WIDGETS-SYSTEM.md §B/§E item
 * 3): the routed wallet view keeps the price surface, and "something changed
 * with your money" travels as a notification instead of resident chrome. This
 * module is that promised producer (#16943): a structural `kind: "watcher"`
 * ScheduledTask on the one scheduling spine samples the wallet's total USD
 * balance on an interval and, when it moved materially since the recorded
 * baseline, emits a `general` notification through NotificationService.
 *
 * Structural behavior only: the fire rides a contributed dispatch channel
 * (`registerScheduledTaskChannelDispatcher`), the same seam the coding-agent
 * pr-shepherd recipe uses — the task's `promptInstructions` is never rendered
 * or routed on. The notification copy is deterministic and deliberately
 * amount-free (percent only): notifications surface on lock screens of
 * shared/kid devices, so dollar figures stay in `data` for in-app consumers,
 * matching the spirit of the price-only widget invariant (#10706).
 *
 * Error doctrine: "couldn't read the balance" must never read as "balance is
 * zero". A failed leg fetch surfaces as a typed retryable dispatch failure
 * (the runner's dispatch policy retries the same step), and a change in WHICH
 * legs are samplable (chain errored, RPC readiness flipped, address
 * added/removed) re-baselines silently instead of fabricating a delta. The
 * same doctrine covers price availability: the upstream balance stack encodes
 * "price unknown" as `valueUsd: "0"` with no error (wallet-evm-balance.ts
 * seeds "0" and only overwrites on a dex-price hit; wallet-dex-prices.ts
 * swallows provider failures into a partial map), so a dexscreener /
 * geckoterminal outage collapses totals to ~0 while unit balances are
 * unchanged. The sample fingerprint therefore folds in per-position price
 * coverage: a priced↔unpriced flip is a sampling change, not a balance move,
 * and re-baselines silently instead of emitting a "down ~100%" / "up" flap.
 *
 * Registered from the agent boot path (desktop/cloud only — mobile has no
 * EVM/Solana wallet surface, mirroring the /api/wallet route gate).
 */

import type { AgentRuntime, NotificationInput } from "@elizaos/core";
import { logger, ServiceType } from "@elizaos/core";
import type { DispatchResult } from "@elizaos/plugin-scheduling";
import {
  getScheduledTaskRunner,
  registerScheduledTaskChannelDispatcher,
  type ScheduledTaskDispatchRecord,
  type ScheduledTaskInput,
  waitForScheduledTaskRunnerService,
} from "@elizaos/plugin-scheduling";
import type { WalletBalancesResponse } from "@elizaos/shared";

/** Contributed dispatch channel the watcher's escalation step names. */
export const WALLET_BALANCE_DELTA_CHANNEL = "wallet_balance_delta";
/** Stable notification groupKey so repeated deltas coalesce (§C.3 supersede). */
export const WALLET_BALANCE_DELTA_GROUP_KEY = "wallet:balance-delta";
/** Seed-once idempotency key for the watcher ScheduledTask row. */
export const WALLET_BALANCE_DELTA_TASK_IDEMPOTENCY_KEY =
  "wallet:balance-delta-watcher:v1";
/** Runtime-cache key holding the last notified/observed baseline. */
export const WALLET_BALANCE_DELTA_BASELINE_CACHE_KEY =
  "wallet:balance-delta:baseline:v1";
/** Sampling cadence. The server-side balance stack caches aggressively and a
 * material move is not a seconds-scale event; 30 minutes keeps RPC load
 * negligible while beating the "next morning" bar for noticing a move. */
export const WALLET_BALANCE_DELTA_INTERVAL_MINUTES = 30;

/** Default materiality floor in absolute USD. Below this, never notify. */
export const DEFAULT_MIN_DELTA_USD = 10;
/** Default materiality threshold relative to the baseline, in percent. */
export const DEFAULT_THRESHOLD_PCT = 10;

const RETRY_AFTER_MINUTES = 15;

/** Persisted baseline: the last total we notified about (or first observed). */
export interface WalletBalanceBaseline {
  totalUsd: number;
  /** Sorted sample fingerprint: the legs the total was computed from (e.g.
   * `"evm:ethereum"`, `"sol"`) plus one `unpriced:<position>` entry per
   * position whose units are nonzero but whose USD value is unknown (the
   * upstream "0"-means-unpriced encoding). A fingerprint change is a
   * sampling-composition or price-coverage change, not a balance change; the
   * watcher re-baselines instead of notifying. */
  sampleFingerprint: string[];
  observedAtIso: string;
}

/** Structural per-task threshold overrides read from task metadata. */
export interface WalletBalanceDeltaThresholds {
  minDeltaUsd: number;
  thresholdPct: number;
}

/**
 * The injected balance source. Returns the current balances snapshot, or
 * `null` when no wallet leg is configured/samplable (a designed no-op tick,
 * not an error). MUST throw on a failed fetch — never substitute an empty
 * response for an unreachable one.
 */
export type WalletBalanceSampleSource =
  () => Promise<WalletBalancesResponse | null>;

function parseUsd(value: string | number | null | undefined): number {
  const n = typeof value === "number" ? value : Number.parseFloat(value ?? "");
  return Number.isFinite(n) ? n : 0;
}

/**
 * Total portfolio USD across every samplable leg. EVM chains that report a
 * per-chain `error` are EXCLUDED (their balances are unknown, not zero) —
 * the fingerprint below keeps that exclusion honest.
 */
export function sumWalletBalancesUsd(balances: WalletBalancesResponse): number {
  let total = 0;
  if (balances.solana) {
    total += parseUsd(balances.solana.solValueUsd);
    for (const token of balances.solana.tokens) {
      total += parseUsd(token.valueUsd);
    }
  }
  if (balances.evm) {
    for (const chain of balances.evm.chains) {
      if (chain.error !== null) continue;
      total += parseUsd(chain.nativeValueUsd);
      for (const token of chain.tokens) {
        total += parseUsd(token.valueUsd);
      }
    }
  }
  return total;
}

/**
 * Sorted fingerprint of what the total was computed FROM: the samplable legs
 * plus one `unpriced:<position>` entry per position holding nonzero units
 * whose USD value is unknown. Upstream encodes "price unknown" as
 * `valueUsd: "0"` with no error, so without the coverage entries a price-feed
 * outage (units unchanged, values collapsed to 0) is indistinguishable from
 * the owner's balance actually going to zero — the dispatcher re-baselines on
 * any fingerprint change instead of notifying. Positions on an errored chain
 * are excluded entirely (the whole leg already is).
 */
export function walletSampleFingerprint(
  balances: WalletBalancesResponse,
): string[] {
  const entries: string[] = [];
  const markUnpriced = (
    positionId: string,
    units: string,
    valueUsd: string,
  ): void => {
    const amount = Number.parseFloat(units);
    if (Number.isFinite(amount) && amount > 0 && parseUsd(valueUsd) === 0) {
      entries.push(`unpriced:${positionId}`);
    }
  };
  if (balances.solana) {
    entries.push("sol");
    markUnpriced(
      "sol:native",
      balances.solana.solBalance,
      balances.solana.solValueUsd,
    );
    for (const token of balances.solana.tokens) {
      markUnpriced(`sol:token:${token.mint}`, token.balance, token.valueUsd);
    }
  }
  if (balances.evm) {
    for (const chain of balances.evm.chains) {
      if (chain.error !== null) continue;
      entries.push(`evm:${chain.chain}`);
      markUnpriced(
        `evm:${chain.chain}:native`,
        chain.nativeBalance,
        chain.nativeValueUsd,
      );
      for (const token of chain.tokens) {
        markUnpriced(
          `evm:${chain.chain}:token:${token.contractAddress.toLowerCase()}`,
          token.balance,
          token.valueUsd,
        );
      }
    }
  }
  return entries.sort();
}

/**
 * Materiality decision. Material iff the absolute move clears BOTH the flat
 * USD floor and the percent-of-baseline threshold (the percent clause is
 * vacuous for a ~zero baseline, so first funding of an empty wallet counts
 * once it clears the USD floor).
 */
export function evaluateWalletBalanceDelta(args: {
  baselineUsd: number;
  currentUsd: number;
  thresholds: WalletBalanceDeltaThresholds;
}): { material: boolean; deltaUsd: number; deltaPct: number } {
  const deltaUsd = args.currentUsd - args.baselineUsd;
  const absDelta = Math.abs(deltaUsd);
  const base = Math.abs(args.baselineUsd);
  const deltaPct =
    base > 0 ? (deltaUsd / base) * 100 : deltaUsd === 0 ? 0 : 100;
  const material =
    absDelta >= args.thresholds.minDeltaUsd &&
    absDelta >= (base * args.thresholds.thresholdPct) / 100;
  return { material, deltaUsd, deltaPct };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Read structural threshold overrides from `metadata.walletBalanceDelta`. */
export function resolveThresholds(
  metadata: Record<string, unknown> | undefined,
): WalletBalanceDeltaThresholds {
  const raw = isRecord(metadata) ? metadata.walletBalanceDelta : undefined;
  const overrides = isRecord(raw) ? raw : {};
  const minDeltaUsd =
    typeof overrides.minDeltaUsd === "number" &&
    Number.isFinite(overrides.minDeltaUsd) &&
    overrides.minDeltaUsd > 0
      ? overrides.minDeltaUsd
      : DEFAULT_MIN_DELTA_USD;
  const thresholdPct =
    typeof overrides.thresholdPct === "number" &&
    Number.isFinite(overrides.thresholdPct) &&
    overrides.thresholdPct >= 0
      ? overrides.thresholdPct
      : DEFAULT_THRESHOLD_PCT;
  return { minDeltaUsd, thresholdPct };
}

/** Structural view of NotificationService.notify — avoids a class import. */
interface NotifierLike {
  notify: (input: NotificationInput) => Promise<unknown>;
}

function getNotifier(runtime: AgentRuntime): NotifierLike | null {
  const service = runtime.getService(ServiceType.NOTIFICATION) as unknown;
  if (
    typeof service === "object" &&
    service !== null &&
    typeof (service as NotifierLike).notify === "function"
  ) {
    return service as NotifierLike;
  }
  return null;
}

function isBaseline(value: unknown): value is WalletBalanceBaseline {
  return (
    isRecord(value) &&
    typeof value.totalUsd === "number" &&
    Number.isFinite(value.totalUsd) &&
    Array.isArray(value.sampleFingerprint) &&
    value.sampleFingerprint.every((entry) => typeof entry === "string") &&
    typeof value.observedAtIso === "string"
  );
}

/** The watcher ScheduledTask row (interval trigger, contributed channel). */
export function buildWalletBalanceDeltaTaskInput(
  agentId: string,
): ScheduledTaskInput {
  return {
    kind: "watcher",
    // Instruction-voice description for humans reading the task list; the
    // contributed channel dispatcher below is deterministic and never renders
    // or routes on this text.
    promptInstructions:
      "Check whether the owner's total wallet balance moved materially since the last recorded baseline and notify them when it did.",
    trigger: {
      kind: "interval",
      everyMinutes: WALLET_BALANCE_DELTA_INTERVAL_MINUTES,
    },
    priority: "low",
    escalation: {
      steps: [{ delayMinutes: 0, channelKey: WALLET_BALANCE_DELTA_CHANNEL }],
    },
    respectsGlobalPause: true,
    source: "plugin",
    createdBy: agentId,
    ownerVisible: false,
    idempotencyKey: WALLET_BALANCE_DELTA_TASK_IDEMPOTENCY_KEY,
    metadata: {
      walletBalanceDelta: {
        minDeltaUsd: DEFAULT_MIN_DELTA_USD,
        thresholdPct: DEFAULT_THRESHOLD_PCT,
      },
    },
    executionProfile: "bg-light-30s",
  };
}

/**
 * The deterministic fire handler for {@link WALLET_BALANCE_DELTA_CHANNEL}.
 * Exported for the real-path integration test; production wiring goes through
 * {@link registerWalletBalanceDeltaProducer}.
 */
export function createWalletBalanceDeltaDispatcher(
  runtime: AgentRuntime,
  source: WalletBalanceSampleSource,
): (record: ScheduledTaskDispatchRecord) => Promise<DispatchResult> {
  return async (record) => {
    let balances: WalletBalancesResponse | null;
    try {
      balances = await source();
    } catch (error) {
      // error-policy:J1 boundary translation — a failed balance read becomes
      // the runner's typed retryable dispatch failure; it must never be
      // recorded as "balance is zero" or as a delivered fire.
      runtime.reportError("WalletBalanceDelta.sample", error, {
        taskId: record.taskId,
      });
      return {
        ok: false,
        reason: "transport_error",
        userActionable: false,
        retryAfterMinutes: RETRY_AFTER_MINUTES,
        message: `wallet balance sample failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    if (balances === null) {
      // No wallet leg configured — a designed no-op tick, not a failure.
      return { ok: true, target: "no_wallet_configured" };
    }

    const totalUsd = sumWalletBalancesUsd(balances);
    const sampleFingerprint = walletSampleFingerprint(balances);
    const nowIso = new Date().toISOString();
    const stored = await runtime.getCache<WalletBalanceBaseline>(
      WALLET_BALANCE_DELTA_BASELINE_CACHE_KEY,
    );
    const baseline = isBaseline(stored) ? stored : null;

    const persistBaseline = async (): Promise<void> => {
      const next: WalletBalanceBaseline = {
        totalUsd,
        sampleFingerprint,
        observedAtIso: nowIso,
      };
      await runtime.setCache(WALLET_BALANCE_DELTA_BASELINE_CACHE_KEY, next);
    };

    if (!baseline) {
      await persistBaseline();
      return { ok: true, target: "baseline_recorded" };
    }

    if (baseline.sampleFingerprint.join("|") !== sampleFingerprint.join("|")) {
      // WHAT we can sample changed, not what the owner holds: either the leg
      // composition moved (chain errored / recovered, RPC readiness flipped,
      // address added/removed) or price coverage flipped (a position's USD
      // value became unknown or recovered — the price-feed-outage flap). Both
      // re-baseline silently; notifying would fabricate a delta the units
      // never made.
      const legsOf = (fp: string[]): string =>
        fp.filter((entry) => !entry.startsWith("unpriced:")).join("|");
      const target =
        legsOf(baseline.sampleFingerprint) !== legsOf(sampleFingerprint)
          ? "rebaselined_leg_change"
          : "rebaselined_price_coverage_change";
      await persistBaseline();
      logger.debug(
        {
          src: "wallet-balance-delta",
          agentId: runtime.agentId,
          taskId: record.taskId,
          previousFingerprint: baseline.sampleFingerprint,
          currentFingerprint: sampleFingerprint,
          previousTotalUsd: baseline.totalUsd,
          currentTotalUsd: totalUsd,
        },
        `[WalletBalanceDelta] sample composition changed — ${target}`,
      );
      return { ok: true, target };
    }

    const thresholds = resolveThresholds(record.metadata);
    const { material, deltaUsd, deltaPct } = evaluateWalletBalanceDelta({
      baselineUsd: baseline.totalUsd,
      currentUsd: totalUsd,
      thresholds,
    });
    if (!material) {
      return { ok: true, target: "below_threshold" };
    }

    const notifier = getNotifier(runtime);
    if (!notifier) {
      // Notifications are the entire point of this watcher; without the
      // service the delta was NOT delivered. Keep the baseline so the retry
      // still sees the move.
      return {
        ok: false,
        reason: "transport_error",
        userActionable: false,
        retryAfterMinutes: RETRY_AFTER_MINUTES,
        message: "NotificationService unavailable",
      };
    }

    const direction = deltaUsd > 0 ? "up" : "down";
    const pctLabel = `${Math.abs(deltaPct) >= 1000 ? Math.round(Math.abs(deltaPct)) : Math.abs(deltaPct).toFixed(1)}%`;
    try {
      await notifier.notify({
        title: `Wallet balance ${direction}`,
        // Percent-only body: lock-screen-safe on shared devices; dollar
        // figures live in `data` for in-app consumers.
        body:
          baseline.totalUsd > 0
            ? `Your total balance moved ${direction} about ${pctLabel} since the last check. Open the wallet for details.`
            : `Your wallet just received funds. Open the wallet for details.`,
        category: "general",
        priority: "normal",
        source: "wallet",
        deepLink: "/wallet",
        groupKey: WALLET_BALANCE_DELTA_GROUP_KEY,
        data: {
          previousTotalUsd: baseline.totalUsd,
          currentTotalUsd: totalUsd,
          deltaUsd,
          deltaPct,
          observedAtIso: nowIso,
        },
      });
    } catch (error) {
      // error-policy:J1 boundary translation — an undelivered notification is
      // a failed dispatch; baseline stays so the retry re-detects the move.
      runtime.reportError("WalletBalanceDelta.notify", error, {
        taskId: record.taskId,
      });
      return {
        ok: false,
        reason: "transport_error",
        userActionable: false,
        retryAfterMinutes: RETRY_AFTER_MINUTES,
        message: `notification emit failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    // Baseline moves only after the notification was accepted, so a failed
    // delivery cannot silently swallow the delta.
    await persistBaseline();
    logger.info(
      {
        src: "wallet-balance-delta",
        agentId: runtime.agentId,
        taskId: record.taskId,
        previousTotalUsd: baseline.totalUsd,
        currentTotalUsd: totalUsd,
        deltaUsd,
        deltaPct,
      },
      "[WalletBalanceDelta] material balance delta notified",
    );
    return {
      ok: true,
      messageId: `wallet-balance-delta:${record.taskId}:${record.firedAtIso}`,
      target: `delta:${deltaUsd.toFixed(2)}`,
    };
  };
}

/**
 * Production balance source: the same address resolution, RPC readiness, and
 * fetchers the `/api/wallet/balances` route uses, with fail-fast legs (a leg
 * that is configured but unreadable throws instead of reading as empty).
 * Modules are imported lazily so agent boot does not pay for the wallet stack
 * until the first watcher fire.
 */
export function createAgentWalletBalanceSource(): WalletBalanceSampleSource {
  return async () => {
    const [walletApi, walletRpc, configModule] = await Promise.all([
      import("../api/wallet.ts"),
      import("../api/wallet-rpc.ts"),
      import("../config/config.ts"),
    ]);
    const addresses = walletApi.getWalletAddresses();
    const readiness = walletRpc.resolveWalletRpcReadiness(
      configModule.loadElizaConfig(),
    );
    const evmReady = Boolean(addresses.evmAddress && readiness.evmBalanceReady);
    const solReady = Boolean(
      addresses.solanaAddress && readiness.solanaBalanceReady,
    );
    if (!evmReady && !solReady) return null;

    const alchemyKey = process.env.ALCHEMY_API_KEY?.trim() || null;
    const ankrKey = process.env.ANKR_API_KEY?.trim() || null;
    const heliusKey = process.env.HELIUS_API_KEY?.trim() || null;

    const result: WalletBalancesResponse = { evm: null, solana: null };
    const legs: Promise<void>[] = [];
    if (evmReady && addresses.evmAddress) {
      const evmAddress = addresses.evmAddress;
      legs.push(
        walletApi
          .fetchEvmBalances(evmAddress, {
            alchemyKey,
            ankrKey,
            cloudManagedAccess: readiness.cloudManagedAccess,
            bscRpcUrls: readiness.bscRpcUrls,
            ethereumRpcUrls: readiness.ethereumRpcUrls,
            baseRpcUrls: readiness.baseRpcUrls,
            avaxRpcUrls: readiness.avalancheRpcUrls,
            nodeRealBscRpcUrl: process.env.NODEREAL_BSC_RPC_URL,
            quickNodeBscRpcUrl: process.env.QUICKNODE_BSC_RPC_URL,
            bscRpcUrl: process.env.BSC_RPC_URL,
            ethereumRpcUrl: process.env.ETHEREUM_RPC_URL,
            baseRpcUrl: process.env.BASE_RPC_URL,
            avaxRpcUrl: process.env.AVALANCHE_RPC_URL,
          })
          .then((chains) => {
            result.evm = { address: evmAddress, chains };
          }),
      );
    }
    if (solReady && addresses.solanaAddress) {
      const solanaAddress = addresses.solanaAddress;
      legs.push(
        (heliusKey
          ? walletApi.fetchSolanaBalances(solanaAddress, heliusKey)
          : walletApi.fetchSolanaNativeBalanceViaRpc(
              solanaAddress,
              readiness.solanaRpcUrls,
            )
        ).then((solanaData) => {
          result.solana = { address: solanaAddress, ...solanaData };
        }),
      );
    }
    // Promise.all: a single failed configured leg fails the whole sample —
    // the dispatcher translates that into a typed retryable failure rather
    // than treating the missing leg as an empty wallet.
    await Promise.all(legs);
    return result;
  };
}

/**
 * Boot wiring: register the contributed dispatch channel, then seed the
 * watcher row (idempotent by key) once the runner host service is up.
 */
export async function registerWalletBalanceDeltaProducer(
  runtime: AgentRuntime,
  options: { source?: WalletBalanceSampleSource } = {},
): Promise<void> {
  const source = options.source ?? createAgentWalletBalanceSource();
  registerScheduledTaskChannelDispatcher(runtime, {
    channelKey: WALLET_BALANCE_DELTA_CHANNEL,
    dispatch: createWalletBalanceDeltaDispatcher(runtime, source),
  });
  await waitForScheduledTaskRunnerService(runtime);
  const runner = getScheduledTaskRunner(runtime, { agentId: runtime.agentId });
  const task = await runner.schedule(
    buildWalletBalanceDeltaTaskInput(runtime.agentId),
  );
  logger.debug(
    {
      src: "wallet-balance-delta",
      agentId: runtime.agentId,
      taskId: task.taskId,
    },
    "[WalletBalanceDelta] balance-delta watcher registered",
  );
}
