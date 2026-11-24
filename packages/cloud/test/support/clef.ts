// spec/cloud/index.md, "A dispatch uses the current account and its available quota slots"
import { Effect } from "effect";
import { SecureRandom } from "effect/crypto";
import { signInWithProof } from "../../src/identity-store.vibe";
import { cloudWorker, type CloudBindings } from "../../src/worker.vibe";
import type { openBackupDatabase } from "./password-backup.ts";
import { workerBindings } from "./worker.ts";

type BackupDatabase = Awaited<ReturnType<typeof openBackupDatabase>>;

export async function clefWorker(fixture: BackupDatabase, digest: string, email: string, ai: CloudBindings["AI"]) {
  await fixture.db.query("INSERT INTO cloud_identity (digest, environment, created_at) VALUES ($1, 'staging', 1)", [digest]);
  const owner = await Effect.runPromise(Effect.provide(signInWithProof(fixture.db, {
    provider: "email", subject: email, email,
  }), SecureRandom.layerWebCrypto));
  const web = "https://app.example.test";
  const api = "https://api.example.test";
  const env = {
    ...workerBindings({ api, web, digest }), AI: ai, DATABASE_URL: fixture.databaseUrl,
  } satisfies CloudBindings;
  return { owner, web, api, env, worker: cloudWorker() };
}
