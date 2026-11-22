// spec/os/agentService/health.md, "The delay before restart attempt n is 1, 2, 4, 8, 16, 32 s and then 60 s"; spec/agent/host/launch.md, "Each boot failure has one exit code, and every code outside the table is a crash"
import readline from "node:readline";
import type { Driver } from "../../gen/_conformance.ts";
import type { Options } from "../../gen/os__agentService__lifecycle.conformance.ts";
import { jvmDriver } from "./jvm-adapter.ts";

const KEY = "device";

type Cause = "Payload" | "Storage" | "Config" | "Credential" | "Agent" | "Crashed" | "Runtime";
type RecoveryToken = { readonly epoch: number; readonly nonce: string };

export type LifecycleEvent =
  | { readonly type: "start" | "stop" | "reapStale" | "spawn" | "spawnFailed" | "timeout" | "failUnclassified" | "restartUnhealthy" | "stableReset" | "signedOut" | "credentialExpired" }
  | { readonly type: "launchHook"; readonly refused: boolean }
  | { readonly type: "refuse"; readonly cause: Cause }
  | { readonly type: "observeReady"; readonly epoch: number }
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
  readonly epoch: number;
  readonly attempt: number;
  readonly held: boolean;
  readonly credentialHeld: boolean;
  readonly delivered: number;
}

interface AdapterState extends Omit<LifecycleView, "held"> {
  readonly hold: { readonly tag: "NotHeld" | "Held" };
}

const nativeView = (state: AdapterState): LifecycleView => ({
  phase: state.phase,
  epoch: state.epoch,
  attempt: state.attempt,
  held: state.hold.tag === "Held",
  credentialHeld: state.credentialHeld,
  delivered: state.delivered,
});

const adapter = jvmDriver<LifecycleEvent, AdapterState>("ai.eliza.os.agent.LifecycleAdapter", { receives: true });

export const driver: Driver<LifecycleEvent, LifecycleView> & AsyncDisposable = {
  ...adapter,
  observe: async (key) => nativeView(await adapter.observe(key)),
};

export const options: Options<LifecycleView> = {
  keys: [KEY],
  view: ({ phase, epoch, attempt, hold, key, delivered }) => ({
    phase: phase.tag === "Starting" ? { tag: "Starting", stage: phase.step }
      : phase.tag === "Stopping" ? { tag: "Stopping" }
      : phase,
    epoch,
    attempt,
    held: hold.tag === "HeldFor",
    credentialHeld: key.tag === "Key",
    delivered,
  }),
};

if (import.meta.main) {
  const answer = async (line: string) => {
    const request: unknown = JSON.parse(line);
    if (typeof request !== "object" || request === null || Array.isArray(request)) throw new Error(`not a driver request: ${line}`);
    const event = (request as { event?: LifecycleEvent }).event;
    if (event === undefined) await driver.reset();
    else await driver.dispatch(KEY, event);
    return { state: await driver.observe(KEY), out: event === undefined ? [] : await driver.observeOutput?.(KEY) };
  };
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (line.trim() === "") continue;
    process.stdout.write(`${JSON.stringify(await answer(line))}\n`);
  }
  await driver[Symbol.asyncDispose]();
}
