// spec/cloud/identity/codeChallenges.md, "Story: Sign in with a code sent to my email or phone"; spec/cloud/identity/codeChallenges.md, "Story: Stop guessing at my code"
import type { Driver, Options } from "../../gen/cloud__identity__codeChallenges.conformance.ts";
import type { Challenge, Event } from "../../gen/cloud__identity__codeChallenges.ts";
import { challengeRows } from "../../src/identity/code-challenges.vibe";
import { loadRow, stepRow } from "../../src/store/rows.vibe";
import { identityDriverLedger, within } from "../support/ledger.ts";

const cloud = identityDriverLedger();
const keys = ["a", "b"];
const challenge = (key: string) => `challenge-${key}`;

function columns(key: string) {
  return (state: Challenge) => ({
    method: state.method === "PhoneSignIn" ? "sms" : "email",
    purpose_key: state.purpose.tag === "SignInCode" ? "sign-in" : `link:${state.purpose.userId}`,
    user_id: state.purpose.tag === "SignInCode" ? null : state.purpose.userId,
    client_id: state.clientId,
    destination_digest: `destination-${key}`,
    code_digest: `code-${key}`,
    code_challenge: `challenge-${key}`,
    phase: state.phase.tag.toLowerCase(),
    sent_at: state.sentAt,
    expires_at: state.expiresAt,
  });
}

async function dispatch(key: string, event: Event) {
  return cloud.dispatch(key, within((tx) => stepRow(tx, challengeRows, challenge(key), { event, now: 0 }, columns(key))), (value) => value.out.out);
}

async function observe(key: string): Promise<Challenge> {
  const done = await cloud.run(within((tx) => loadRow(tx, challengeRows, challenge(key), false)));
  if (done.kind === "failed") throw new Error(`reading the challenge failed with ${done.tag}`, { cause: done.error });
  return done.value.state;
}

export const driver: Driver & AsyncDisposable = {
  reset: async () => {
    await cloud.reset([]);
    await cloud.sql("TRUNCATE code_challenges");
  },
  dispatch,
  observe,
  observeOutput: cloud.observeOutput,
  [Symbol.asyncDispose]: () => cloud.dispose(),
};

export const options: Options = { keys };
