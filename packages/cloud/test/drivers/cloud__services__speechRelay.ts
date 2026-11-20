// spec/cloud/services/speechRelay.md, "Story: Start speech only from a consent I gave"; spec/cloud/services/speechRelay.md, "Story: Keep a live session funded and close it with receipts"
import type { Driver, Options } from "../../gen/cloud__services__speechRelay.conformance.ts";
import type { Event, Session } from "../../gen/cloud__services__speechRelay.ts";
import { sessionColumns, sessionRows } from "../../src/services/speech-session.vibe";
import { loadRow, stepRow } from "../../src/store/rows.vibe";
import { ledger, within } from "../support/ledger.ts";

const cloud = ledger();
const keys = ["a", "b"];
const organization = (key: string) => `org-${key}`;
const person = (key: string) => `person-${key}`;
const nonce = (key: string) => `consent-${key}`;
const credentialExpiresAt = 10 ** 13;

const ownership = (key: string) => ({
  consent_nonce: nonce(key),
  user_id: person(key),
  organization_id: organization(key),
  credential_kind: "session",
  credential_ref: `credential-${key}`,
  credential_expires_at: credentialExpiresAt,
  created_at: 0,
});

async function dispatch(key: string, event: Event) {
  const done = await cloud.run(within((tx) => stepRow(tx, sessionRows, key, event, (session: Session) => ({ ...sessionColumns(0)(session), ...ownership(key) }))));
  if (done.kind === "done") return "accepted" as const;
  if (done.tag === "Rejected") return "refused" as const;
  throw new Error(`the cloud failed with ${done.tag}`, { cause: done.error });
}

async function observe(key: string): Promise<Session> {
  const done = await cloud.run(within((tx) => loadRow(tx, sessionRows, key, false)));
  if (done.kind === "failed") throw new Error(`reading the speech session failed with ${done.tag}`, { cause: done.error });
  return done.value.state;
}

export const driver: Driver & AsyncDisposable = {
  reset: async () => {
    await cloud.reset(keys.map(organization));
    await cloud.sql("DELETE FROM speech_usage_days");
    for (const key of keys) {
      await cloud.sql(
        "INSERT INTO speech_consents (nonce, user_id, organization_id, credential_kind, credential_ref, expires_at, consumed_at, created_at) VALUES ($1, $2, $3, 'session', $4, $5, 0, 0)",
        [nonce(key), person(key), organization(key), `credential-${key}`, credentialExpiresAt],
      );
    }
  },
  dispatch,
  observe,
  [Symbol.asyncDispose]: () => cloud.dispose(),
};

export const options: Options = { keys };
