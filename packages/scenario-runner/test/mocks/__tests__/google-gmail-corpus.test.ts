/**
 * Corpus-loaded Gmail mock contract tests: real startMocks servers seeded
 * from the committed synthetic sample corpus in @elizaos/corpus-tools, no
 * network beyond loopback and no mocked collaborators. Covers manifest
 * publication, message retrieval, builtin-fixture preservation, and the
 * verified-scrub floor rejecting unscrubbed corpora, the unhostable-account
 * rejection, and the blank-corpus-directory boot refusal.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CORPUS_GMAIL_FIXTURE_SET,
  corpusGmailMockOptions,
} from "../scripts/google-gmail-corpus.ts";
import {
  parseCliArgs,
  type StartedMocks,
  startMocks,
} from "../scripts/start-mocks.ts";

const SAMPLE_CORPUS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../corpus-tools/fixtures/sample-corpus",
);

let activeMocks: StartedMocks | null = null;
let tempDir: string | null = null;

afterEach(async () => {
  if (activeMocks) {
    await activeMocks.stop();
    activeMocks = null;
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe("corpus-loaded gmail mock", () => {
  it("seeds corpus rows alongside builtin fixtures and publishes fixture sets", async () => {
    activeMocks = await startMocks({
      envs: ["google"],
      corpusDir: SAMPLE_CORPUS_DIR,
    });
    const base = activeMocks.baseUrls.google;

    const manifest = await getJson(`${base}/__mock/google/gmail/fixtures`);
    const fixtures = manifest.fixtures as Record<string, string[]>;
    expect(fixtures[CORPUS_GMAIL_FIXTURE_SET]).toEqual([
      "corpus-gmail-work-1",
      "corpus-gmail-work-2",
      "corpus-gmail-work-3",
      "corpus-gmail-home-1",
    ]);
    expect(fixtures["corpus-gmail:home"]).toEqual(["corpus-gmail-home-1"]);
    // Builtin fixture registry must remain untouched for existing scenarios.
    expect(fixtures.default).toContain("msg-finance");

    const message = await getJson(
      `${base}/gmail/v1/users/me/messages/corpus-gmail-work-1`,
    );
    expect(message.threadId).toBe("corpus-thr-atlas");
    expect(message.snippet).toContain("launch checklist");

    const builtin = await getJson(
      `${base}/gmail/v1/users/me/messages/msg-finance`,
    );
    expect(builtin.id).toBe("msg-finance");
  });

  it("keeps corpus timestamps aged relative to the run-time anchor", () => {
    const options = corpusGmailMockOptions([
      {
        id: "corpus-x",
        platform: "gmail",
        accountId: "work",
        threadId: "thr-x",
        ts: Date.parse("2026-07-04T00:00:00.000Z"),
        direction: "in",
        senderId: "a@b.test",
        senderDisplay: "A",
        recipients: [{ id: "owner", address: "owner@example.test" }],
        text: "body",
        labels: [],
        attachments: [],
        scrubState: "verified",
      },
    ]);
    const fixture = options.corpusGmailFixtures?.[0];
    expect(fixture?.internalDateOffsetMs).toBe(-24 * 60 * 60 * 1000);
    expect(fixture?.labelIds).toEqual(["INBOX"]);
    expect(
      fixture?.headers.find((header) => header.name === "From")?.value,
    ).toBe("A <a@b.test>");
  });

  it("rejects non-gmail rows instead of silently dropping them", () => {
    expect(() =>
      corpusGmailMockOptions([
        {
          id: "corpus-tg",
          platform: "telegram",
          accountId: "owner",
          threadId: "thr-tg",
          ts: Date.parse("2025-03-05T08:00:00.000Z"),
          direction: "in",
          senderId: "tg-a",
          senderDisplay: "A",
          recipients: [],
          text: "hi",
          labels: [],
          attachments: [],
          scrubState: "verified",
        },
      ]),
    ).toThrow(/non-gmail/);
  });

  it("rejects a corpus account the Gmail mock cannot host", () => {
    // Otherwise the mock files these under its default account while a
    // `corpus-gmail:<accountId>` set still advertises them under the corpus
    // name — a silently wrong mapping instead of a boot failure.
    expect(() =>
      corpusGmailMockOptions([
        {
          id: "corpus-p",
          platform: "gmail",
          accountId: "personal",
          threadId: "thr-p",
          ts: Date.parse("2025-03-05T08:00:00.000Z"),
          direction: "in",
          senderId: "a@b.test",
          senderDisplay: "A",
          recipients: [],
          text: "body",
          labels: [],
          attachments: [],
          scrubState: "verified",
        },
      ]),
    ).toThrow(/personal/);
  });

  it("refuses to boot on a blank corpus directory instead of running fixture-only", async () => {
    // A mistyped `--corpus-dir=` or an unset shell variable must not produce a
    // green run whose corpus leg silently never executed.
    expect(() => parseCliArgs(["--corpus-dir="])).toThrow(
      /--corpus-dir requires a directory path/,
    );
    expect(parseCliArgs(["--corpus-dir=/tmp/corpus"]).corpusDir).toBe(
      "/tmp/corpus",
    );
    await expect(
      startMocks({ envs: ["google"], corpusDir: "" }),
    ).rejects.toThrow(/corpus directory is set but empty/);

    const previous = process.env.ELIZA_CORPUS_DIR;
    process.env.ELIZA_CORPUS_DIR = "";
    try {
      await expect(startMocks({ envs: ["google"] })).rejects.toThrow(
        /corpus directory is set but empty/,
      );
    } finally {
      if (previous === undefined) delete process.env.ELIZA_CORPUS_DIR;
      else process.env.ELIZA_CORPUS_DIR = previous;
    }
  });

  it("refuses to start when the corpus has no verified gmail rows", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "corpus-gmail-mock-"));
    const shardDir = path.join(tempDir, "gmail", "work");
    await mkdir(shardDir, { recursive: true });
    await writeFile(
      path.join(shardDir, "2025-03.jsonl"),
      `${JSON.stringify({
        id: "raw-row",
        platform: "gmail",
        accountId: "work",
        threadId: "thr-raw",
        ts: Date.parse("2025-03-02T00:00:00.000Z"),
        direction: "in",
        senderId: "a@b.test",
        senderDisplay: "A",
        recipients: [],
        text: "unscrubbed",
        labels: [],
        attachments: [],
        scrubState: "raw",
      })}\n`,
    );
    await expect(
      startMocks({ envs: ["google"], corpusDir: tempDir }),
    ).rejects.toThrow(/no verified gmail rows/);
  });
});
