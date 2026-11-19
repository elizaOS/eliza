// spec/cloud/identity/federatedSignIn.md, "Story: Sign in with Google in the browser"; spec/cloud/identity/federatedSignIn.md, "Story: Sign in with the device's Google account"
import type { Driver, Options } from "../../gen/cloud__identity__federatedSignIn.conformance.ts";
import type { Event, GoogleAttempt } from "../../gen/cloud__identity__federatedSignIn.ts";
import { attemptRows } from "../../src/identity/federated.vibe";
import { loadRow, stepRow } from "../../src/store/rows.vibe";
import { ledger, within } from "../support/ledger.ts";

const cloud = ledger();
const keys = ["a", "b"];
const attempt = (key: string) => `attempt-${key}`;
const emitted = new Map<string, unknown>();

function columns(state: GoogleAttempt) {
  const { code, native } = state;
  return {
    route: native.tag === "ChallengeOpen" ? "native" : "browser",
    client_id: "com.example.one",
    pending: code.tag === "CodeIssued" || native.tag === "ChallengeOpen",
    expires_at: code.tag === "CodeIssued" ? code.redeemBy : native.tag === "ChallengeOpen" ? native.openUntil : state.stateExpiresAt,
    updated_at: state.now,
  };
}

async function dispatch(key: string, event: Event) {
  const done = await cloud.run(within((tx) => stepRow(tx, attemptRows, attempt(key), { event, now: 0 }, columns)));
  emitted.set(key, done.kind === "done" ? done.value.out.out : []);
  if (done.kind === "done") return "accepted" as const;
  if (done.tag === "Rejected") return "refused" as const;
  throw new Error(`the cloud failed with ${done.tag}`, { cause: done.error });
}

async function observe(key: string): Promise<GoogleAttempt> {
  const done = await cloud.run(within((tx) => loadRow(tx, attemptRows, attempt(key), false)));
  if (done.kind === "failed") throw new Error(`reading the attempt failed with ${done.tag}`, { cause: done.error });
  return done.value.state;
}

export const driver: Driver & AsyncDisposable = {
  reset: async () => {
    emitted.clear();
    await cloud.reset([]);
    await cloud.sql("TRUNCATE oauth_attempts");
  },
  dispatch,
  observe,
  observeOutput: (key) => emitted.get(key) ?? [],
  [Symbol.asyncDispose]: () => cloud.dispose(),
};

export const options: Options = { keys };
