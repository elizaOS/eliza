// spec/os/agentService/lifecycle.md, "A stop before the spawn spawns nothing, and a stop of a live child waits for its exit"; spec/os/agentService/lifecycle.md, "A failed agent's notice is on the alerts channel with the failure words, and a starting, running or stopping agent's on the status channel"; spec/os/agentService/lifecycle.md, "A hold is taken only with no child, blocks every start and is released only for its target or an ended attempt"; spec/os/agentService/health.md, "The delay before restart attempt n is 1, 2, 4, 8, 16, 32 s and then 60 s"; spec/agent/host/launch.md, "Each boot failure has one exit code, and every code outside the table is a crash"
import { createHash } from "node:crypto";
import type { Driver } from "../../gen/_conformance.ts";
import type { Options } from "../../gen/os__agentService__lifecycle.conformance.ts";
import type { AgentService, Event, NoticeChannel, ServiceEffect } from "../../gen/os__agentService__lifecycle.ts";
import { answerDriverLines, jvmDriver } from "./jvm-adapter.ts";

const KEY = "device";

type Cause = "Payload" | "Storage" | "Config" | "Credential" | "Agent" | "Runtime";
type RecoveryToken = { readonly epoch: number; readonly nonce: string };

export type LifecycleEvent =
  | { readonly type: "start" | "stop" | "reapStale" | "spawn" | "spawnFailed" | "timeout" | "failUnclassified" | "restartUnhealthy" | "stableReset" | "signedOut" | "credentialExpired" }
  | { readonly type: "launchHook"; readonly refused: boolean }
  | { readonly type: "refuse"; readonly cause: Cause }
  | { readonly type: "observeReady"; readonly epoch: number }
  | Extract<Event, { type: "observeReady" | "readinessTimedOut" | "spawn" | "holdForUpdate" | "holdWriteFailed" | "observeHoldGrant" | "releaseUpdate" | "releaseUpdateFailed" | "processRestarted" }>
  | { readonly type: "observeExit"; readonly code: number }
  | { readonly type: "credentialArrived" | "credentialReplaced"; readonly version: number }
  | { readonly type: "accountChanged"; readonly account: string }
  | { readonly type: "reviewRecovery"; readonly focused: boolean; readonly nonce?: string }
  | { readonly type: "archiveRecovery"; readonly token: RecoveryToken }
  | { readonly type: "archiveFinished"; readonly token: RecoveryToken; readonly archiveSucceeded: boolean }
  | { readonly type: "holdForUpdate"; readonly targetCode: number; readonly targetDigest: string }
  | { readonly type: "releaseUpdate"; readonly installedCode: number; readonly installedDigest: string; readonly attemptEnded: boolean };

export type LifecyclePhase =
  | { readonly tag: "Stopped" | "Running" | "Stopping" }
  | { readonly tag: "Starting"; readonly stage: "Checking" | "Spawned" }
  | { readonly tag: "Failed"; readonly cause: Cause };

export interface LifecycleView {
  readonly phase: LifecyclePhase;
  readonly notice: NoticeChannel;
  readonly epoch: number;
  readonly attempt: number;
  readonly hold: { readonly tag: "NotHeld" } | { readonly tag: "Held" | "Unconfirmed"; readonly targetCode: number; readonly targetDigest: string };
  readonly credentialHeld: boolean;
  readonly delivered: number;
}

interface AdapterState extends LifecycleView {
  readonly account: string | null;
  readonly child: boolean;
}

const nativeView = (state: AdapterState): LifecycleView => ({
  phase: state.phase,
  notice: state.notice,
  epoch: state.epoch,
  attempt: state.attempt,
  hold: state.hold,
  credentialHeld: state.credentialHeld,
  delivered: state.delivered,
});

function expectedHold(hold: AgentService["hold"]): LifecycleView["hold"] {
  if (hold.tag === "NotHeld") return hold;
  const unconfirmed = hold.tag === "UnconfirmedHold";
  const targetCode = unconfirmed ? hold.pendingTarget : hold.target;
  return {
    tag: unconfirmed ? "Unconfirmed" : "Held",
    targetCode,
    targetDigest: createHash("sha256").update(`artifact:${targetCode}`).digest("hex"),
  };
}

function nativeEffects(output: unknown, state: AdapterState): ServiceEffect[] {
  if (!Array.isArray(output)) throw new Error("The native lifecycle adapter did not return an effect list");
  return output.map((value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native lifecycle effect");
    const { tag, epoch, delayMs, account } = value as Record<string, unknown>;
    if (tag !== "Check" && tag !== "Kill") throw new Error(`Unsupported native lifecycle effect ${JSON.stringify(tag)}`);
    if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1) throw new Error("Invalid native lifecycle effect epoch");
    if (tag === "Kill") {
      if (epoch !== state.epoch || state.child !== true) throw new Error("Native kill does not own the observed launch");
      return { tag: "KillChild" };
    }
    if (typeof delayMs !== "number" || !Number.isSafeInteger(delayMs) || delayMs < 0
      || (typeof account !== "string" && account !== null) || account !== state.account) {
      throw new Error("Invalid native lifecycle check effect");
    }
    return { tag: "BeginCheck", epoch, delayMs };
  });
}

const adapter = jvmDriver<LifecycleEvent, AdapterState>("ai.eliza.os.agent.LifecycleAdapter", {
  receives: true,
  recreateAfter: (event) => typeof event === "object" && event !== null && "type" in event && event.type === "processRestarted",
});

export const driver: Driver<LifecycleEvent, LifecycleView> & AsyncDisposable = {
  ...adapter,
  observe: async (key) => nativeView(await adapter.observe(key)),
  observeOutput: async (key) => nativeEffects(await adapter.observeOutput?.(key), await adapter.observe(key)),
};

export const options: Options<LifecycleView> = {
  keys: [KEY],
  view: ({ phase, epoch, attempt, hold, key, delivered }) => ({
    phase: phase.tag === "Starting" ? { tag: "Starting", stage: phase.step }
      : phase.tag === "Stopping" ? { tag: "Stopping" }
      : phase,
    notice: phase.tag === "Stopped" ? "NoNotice" : phase.tag === "Failed" ? "AlertsChannel" : "StatusChannel",
    epoch,
    attempt,
    hold: expectedHold(hold),
    credentialHeld: key.tag === "Key",
    delivered,
  }),
};

if (import.meta.main) await answerDriverLines(driver, KEY, (key) => adapter.observeOutput?.(key));
