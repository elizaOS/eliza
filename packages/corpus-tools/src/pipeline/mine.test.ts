/**
 * Stage-0 PII mining coverage for #14766. These tests prove the corpus miner
 * catches every deterministic core detector kind, includes contact-gazetteer
 * entity spans, and emits byte-stable owner-review artifacts for the same salt.
 */
import { PII_DETECTORS } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { CorpusContact, CorpusMessage } from "../schema.ts";
import { minePiiCandidates } from "./mine.ts";

const BASE_TS = Date.parse("2026-06-01T12:00:00.000Z");

const CANARIES: Readonly<Record<string, string>> = {
  email: "jane.doe+x@example.co.uk",
  "credit-card": "4242424242424242",
  ssn: "123-45-6789",
  iban: "GB29 NWBK 6016 1331 9268 19",
  jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  "seed-phrase":
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  "wif-private-key": "5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ",
  "url-credentials": "postgres://app:s3cr3tP4ss@db.host:5432/prod",
  "anthropic-key": "sk-ant-api03-9fK3xQ7zL2mNpR8tV4wYbC1dE6gH0jKlMnOp",
  "stripe-webhook-secret": "whsec_aBcD1234efGH5678ijKL9012mnOPqrSt",
  "slack-webhook-url":
    "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX",
  "basic-auth-header": "Authorization: Basic dXNlcjpzM2NyZXRwYXNz",
  "google-oauth-refresh-token":
    "1//0gB7xLm9Qw3rT4refreshTokenBodyAbCdEf0123456789",
  "telegram-bot-token": "123456789:AAH-abcdefghijklmnopqrstuvwxyz1234567",
  "pgp-private-key":
    "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF...\n-----END PGP PRIVATE KEY BLOCK-----",
  "aws-access-key": "AKIAIOSFODNN7EXAMPLE",
  "stripe-key": "sk_live_4eC39HqLyjWDarjtT1zdp7dc",
  "google-api-key": "AIzaSyA-1234567890abcdefghijklmnopqrstu",
  "github-token": "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
  "openai-key": "sk-test_1234567890abcdef",
  "slack-token": "xoxb-12345-67890-abcdefghij",
  "private-key":
    "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIQ\n-----END EC PRIVATE KEY-----",
  "hex-secret": `0x${"a".repeat(64)}`,
  "mac-address": "01:23:45:67:89:ab",
  ipv4: "192.168.0.42",
  phone: "+1 (415) 555-2671",
};

function message(id: string, text: string): CorpusMessage {
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
    subject: "PII canary",
    text,
    labels: [],
    attachments: [],
    scrubState: "raw",
  };
}

describe("minePiiCandidates", () => {
  it("has a canary for every core deterministic detector kind", () => {
    expect(Object.keys(CANARIES).sort()).toEqual(
      PII_DETECTORS.map((detector) => detector.kind).sort(),
    );
  });

  it("catches every seeded deterministic detector kind", async () => {
    const rows = Object.entries(CANARIES).map(([kind, value], index) =>
      message(`canary-${index}`, `Stage 0 canary for ${kind}: ${value}`),
    );

    const artifacts = await minePiiCandidates(rows, { hashSalt: "canary-v1" });
    const seen = new Set(
      artifacts.candidates.map((candidate) => candidate.kind),
    );

    for (const kind of Object.keys(CANARIES)) {
      expect(seen.has(kind), `missing ${kind}`).toBe(true);
    }
    expect(
      artifacts.candidates.every((candidate) => candidate.sourceRef.memoryId),
    ).toBe(true);
  });

  it("matches name-based redact patterns case-insensitively, like the production redactor", async () => {
    // Regression for the gi->g flag change (#15116 follow-up): core compiles
    // the identical pattern list with "gi" (redact.ts parsePattern,
    // secret-swap.ts); the miner going case-sensitive silently under-reported
    // these on the stage-0 human-review surface.
    const rows = [
      message("case-1", "password: hunter2"),
      message("case-2", "token=abc4567"),
      message("case-3", "authorization: bearer eyJhbGciOiJIUzI1NiJ9.e30.abc"),
    ];

    const artifacts = await minePiiCandidates(rows, { hashSalt: "case-v1" });
    const byMemory = new Set(
      artifacts.candidates
        .filter((candidate) => candidate.kind === "redact-pattern")
        .map((candidate) => candidate.sourceRef.memoryId),
    );

    for (const id of ["case-1", "case-2", "case-3"]) {
      expect(byMemory.has(id), `redact-pattern miss on ${id}`).toBe(true);
    }
  });

  it("emits stable hashes and contact-gazetteer candidates", async () => {
    const contacts: CorpusContact[] = [
      {
        id: "contact-alice",
        display: "Alice Example",
        handles: [{ platform: "gmail", accountId: "work", handle: "alice" }],
        emails: ["alice@example.test"],
        phones: ["415-555-0101"],
        source: "collector",
      },
    ];
    const rows = [
      message(
        "contact-row",
        "Alice Example asked us to use alice@example.test and 415-555-0101.",
      ),
    ];

    const first = await minePiiCandidates(rows, {
      contacts,
      hashSalt: "stable-v1",
    });
    const second = await minePiiCandidates(rows, {
      contacts,
      hashSalt: "stable-v1",
    });

    expect(first).toEqual(second);
    expect(first.candidates.map((candidate) => candidate.kind)).toEqual(
      expect.arrayContaining(["person", "email", "phone"]),
    );
    expect(first.reviewCsv).toContain("valueHash");
    expect(first.reviewCsv).toContain("Alice Example");
  });
});
