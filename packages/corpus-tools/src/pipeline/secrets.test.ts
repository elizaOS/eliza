/**
 * Stage-1 secret replacement coverage for #14768. The tests exercise the local
 * permanent-swap contract: high-confidence credentials become stable typed
 * placeholders, known `.env` values are seeded, and off-device stages cannot run
 * without a green secrets ledger record.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CorpusMessage } from "../schema.ts";
import { runScrubPipeline } from "./driver.ts";
import { swapPermanentSecrets } from "./secrets.ts";

const BASE_TS = Date.parse("2026-06-01T12:00:00.000Z");

const SECRET_CANARIES: Readonly<Record<string, string>> = {
  "anthropic-key": "sk-ant-api03-9fK3xQ7zL2mNpR8tV4wYbC1dE6gH0jKlMnOp",
  "aws-access-key": "AKIAIOSFODNN7EXAMPLE",
  "basic-auth-header": "Authorization: Basic dXNlcjpzM2NyZXRwYXNz",
  "github-token": "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
  "google-api-key": "AIzaSyA-1234567890abcdefghijklmnopqrstu",
  "google-oauth-refresh-token":
    "1//0gB7xLm9Qw3rT4refreshTokenBodyAbCdEf0123456789",
  "hex-secret": `0x${"a".repeat(64)}`,
  jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  "openai-key": "sk-test_1234567890abcdef",
  "pgp-private-key":
    "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF...\n-----END PGP PRIVATE KEY BLOCK-----",
  "private-key":
    "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIQ\n-----END EC PRIVATE KEY-----",
  "seed-phrase":
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  "slack-token": "xoxb-12345-67890-abcdefghij",
  "slack-webhook-url":
    "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX",
  "stripe-key": "sk_live_4eC39HqLyjWDarjtT1zdp7dc",
  "stripe-webhook-secret": "whsec_aBcD1234efGH5678ijKL9012mnOPqrSt",
  "telegram-bot-token": "123456789:AAH-abcdefghijklmnopqrstuvwxyz1234567",
  "url-credentials": "postgres://app:s3cr3tP4ss@db.host:5432/prod",
  "wif-private-key": "5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ",
};

function message(
  id: string,
  text: string,
  scrubState: CorpusMessage["scrubState"] = "raw",
): CorpusMessage {
  return {
    id,
    platform: "gmail",
    accountId: "work",
    threadId: `thread-${id}`,
    ts: BASE_TS,
    direction: "in",
    senderId: "sender@example.test",
    senderDisplay: "Sender Example",
    recipients: [
      { id: "owner", display: "Owner", address: "owner@example.test" },
    ],
    subject: "Secret canary",
    text,
    labels: [],
    attachments: [],
    scrubState,
  };
}

async function writeShard(dir: string, messages: readonly CorpusMessage[]) {
  const shard = path.join(dir, "gmail", "work", "2026-06.jsonl");
  await fs.mkdir(path.dirname(shard), { recursive: true });
  await fs.writeFile(
    shard,
    `${messages.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

describe("swapPermanentSecrets", () => {
  it("replaces every seeded secret-kind canary with typed placeholders", () => {
    const row = message(
      "canaries",
      Object.entries(SECRET_CANARIES)
        .map(([kind, value]) => `${kind}: ${value}`)
        .join("\n"),
    );

    const swapped = swapPermanentSecrets(row, { hashSalt: "secret-v1" });

    for (const value of Object.values(SECRET_CANARIES)) {
      expect(swapped.message.text).not.toContain(value);
    }
    for (const kind of Object.keys(SECRET_CANARIES)) {
      expect(swapped.replacements.some((entry) => entry.kind === kind)).toBe(
        true,
      );
    }
    expect(swapped.message.text).toMatch(
      /\[\[SECRET:openai-key:[a-f0-9]{12}\]\]/,
    );
  });

  it("keeps placeholders stable across reruns and swaps known non-regex secrets", () => {
    const row = message(
      "known",
      "Internal password value was hunter2-super-secret in the old notes.",
    );
    const first = swapPermanentSecrets(row, {
      hashSalt: "secret-v1",
      knownSecrets: { INTERNAL_PASSWORD: "hunter2-super-secret" },
    });
    const second = swapPermanentSecrets(row, {
      hashSalt: "secret-v1",
      knownSecrets: { INTERNAL_PASSWORD: "hunter2-super-secret" },
    });

    expect(first.message.text).toBe(second.message.text);
    expect(first.message.text).not.toContain("hunter2-super-secret");
    expect(first.message.text).toContain("[[SECRET:internal-password:");
  });
});

describe("scrub pipeline secrets stage", () => {
  it("seeds known secrets from local .env files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-secrets-env-"));
    await fs.writeFile(
      path.join(dir, ".env.local"),
      "INTERNAL_PASSWORD=hunter2-super-secret\n",
    );
    await writeShard(dir, [
      message("msg-1", "The old password was hunter2-super-secret."),
    ]);

    const result = await runScrubPipeline({
      targetPath: dir,
      stage: "secrets",
      mode: "deep",
      resume: true,
      dryRun: false,
      rulesetVersion: "secret-env-v1",
    });

    expect(result.messages[0].text).not.toContain("hunter2-super-secret");
    expect(result.messages[0].text).toContain("[[SECRET:internal-password:");
    expect(result.report.stageReports[0].secretReplacementCount).toBe(1);
  });

  it("refuses off-device rewrite before a green secrets ledger entry", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "corpus-secrets-gate-"),
    );
    await writeShard(dir, [
      message("msg-1", "Use sk-test_1234567890abcdef for the old job."),
    ]);

    await expect(
      runScrubPipeline({
        targetPath: dir,
        stage: "rewrite",
        mode: "deep",
        resume: true,
        dryRun: false,
        rulesetVersion: "secret-gate-v1",
      }),
    ).rejects.toThrow("before secrets stage");
  });
});
