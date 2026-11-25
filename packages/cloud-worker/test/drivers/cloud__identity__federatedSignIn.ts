// spec/cloud/identity/federatedSignIn.md, "Story: Sign in with Google in the browser"; spec/cloud/identity/federatedSignIn.md, "Story: Sign in with the device's Google account"
import type { Driver, Options } from "../../gen/cloud__identity__federatedSignIn.conformance.ts";
import type { Event, GoogleAttempt } from "../../gen/cloud__identity__federatedSignIn.ts";
import { attemptRows } from "../../src/identity/federated.vibe";
import { loadRow, stepRow } from "../../src/store/rows.vibe";
import { identityDriverLedger, within } from "../support/ledger.ts";

const cloud = identityDriverLedger();
const keys = ["a", "b"];
const attempt = (key: string) => `attempt-${key}`;

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
  return cloud.dispatch(key, within((tx) => stepRow(tx, attemptRows, attempt(key), { event, now: 0 }, columns)), (value) => value.out.out);
}

async function observe(key: string): Promise<GoogleAttempt> {
  const done = await cloud.run(within((tx) => loadRow(tx, attemptRows, attempt(key), false)));
  if (done.kind === "failed") throw new Error(`reading the attempt failed with ${done.tag}`, { cause: done.error });
  return done.value.state;
}

export const driver: Driver & AsyncDisposable = {
  reset: async () => {
    await cloud.reset([]);
    await cloud.sql("TRUNCATE oauth_attempts");
  },
  dispatch,
  observe,
  observeOutput: cloud.observeOutput,
  [Symbol.asyncDispose]: () => cloud.dispose(),
};

export const options: Options = { keys };
