// spec/cloud/identity/codeChallenges.md, "Story: Sign in with a code sent to my email or phone"; spec/cloud/identity/codeChallenges.md, "Story: Stop guessing at my code"
import type { Driver, Options } from "../../gen/cloud__identity__codeChallenges.conformance.ts";
import type { Challenge, Event } from "../../gen/cloud__identity__codeChallenges.ts";
import { challengeRows } from "../../src/identity/code-challenges.vibe";
import { loadRow, stepRow } from "../../src/store/rows.vibe";
import { ledger, within } from "../support/ledger.ts";

const cloud = ledger();
const keys = ["a", "b"];
const challenge = (key: string) => `challenge-${key}`;
const emitted = new Map<string, unknown>();

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
  const done = await cloud.run(within((tx) => stepRow(tx, challengeRows, challenge(key), { event, now: 0 }, columns(key))));
  emitted.set(key, done.kind === "done" ? done.value.out.out : []);
  if (done.kind === "done") return "accepted" as const;
  if (done.tag === "Rejected") return "refused" as const;
  throw new Error(`the cloud failed with ${done.tag}`, { cause: done.error });
}

async function observe(key: string): Promise<Challenge> {
  const done = await cloud.run(within((tx) => loadRow(tx, challengeRows, challenge(key), false)));
  if (done.kind === "failed") throw new Error(`reading the challenge failed with ${done.tag}`, { cause: done.error });
  return done.value.state;
}

export const driver: Driver & AsyncDisposable = {
  reset: async () => {
    emitted.clear();
    await cloud.reset([]);
    await cloud.sql("TRUNCATE code_challenges");
  },
  dispatch,
  observe,
  observeOutput: (key) => emitted.get(key) ?? [],
  [Symbol.asyncDispose]: () => cloud.dispose(),
};

export const options: Options = { keys };
