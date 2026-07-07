/**
 * Verifies that corpus-loaded Gmail mock data keeps Google-shaped wire
 * responses. The expected fields come from the canonical corpus mapper, then
 * the test exercises the HTTP mock so scenario seeds and connector code see
 * the same shape a real Gmail integration would parse.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCorpusShard, toGmailFixtureMessage } from "@elizaos/corpus-tools";
import { afterEach, describe, expect, it } from "vitest";
import { type StartedMocks, startMocks } from "../scripts/start-mocks.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sampleCorpusDir = path.resolve(
  __dirname,
  "../../../corpus-tools/fixtures/synthetic",
);
const sampleShard = path.join(sampleCorpusDir, "gmail/work/2026-06.jsonl");

let activeMocks: StartedMocks | null = null;

afterEach(async () => {
  if (!activeMocks) return;
  await activeMocks.stop();
  activeMocks = null;
});

async function jsonRequest(
  url: string,
  init?: RequestInit,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

function responseHeaders(body: Record<string, unknown>) {
  const payload = body.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("expected Gmail payload object");
  }
  const headers = (payload as { headers?: unknown }).headers;
  if (!Array.isArray(headers)) {
    throw new Error("expected Gmail payload headers");
  }
  return headers as Array<{ name: string; value: string }>;
}

function payloadBodyText(body: Record<string, unknown>): string {
  const payload = body.payload as { body?: { data?: string } } | undefined;
  const data = payload?.body?.data;
  if (!data) throw new Error("expected Gmail payload body data");
  return Buffer.from(data, "base64url").toString("utf8");
}

describe("Google Gmail mock fidelity", () => {
  it("round-trips corpus rows through Google-shaped list/get/modify responses", async () => {
    const shard = await readCorpusShard(sampleShard, {
      rootDir: sampleCorpusDir,
    });
    expect(shard.issues).toEqual([]);
    const expected = toGmailFixtureMessage(shard.messages[0]);

    const startedAt = Date.now();
    activeMocks = await startMocks({
      envs: ["google"],
      corpus: { dir: sampleCorpusDir },
    });
    const readyAt = Date.now();
    const baseUrl = activeMocks.baseUrls.google;

    const firstPage = await jsonRequest(
      `${baseUrl}/gmail/v1/users/me/messages?maxResults=1`,
    );
    expect(firstPage.response.status).toBe(200);
    expect(firstPage.body).toEqual(
      expect.objectContaining({
        resultSizeEstimate: expect.any(Number),
        nextPageToken: "1",
      }),
    );
    expect(firstPage.body.messages).toEqual([expect.any(Object)]);

    const corpusSearch = await jsonRequest(
      `${baseUrl}/gmail/v1/users/me/messages?q=Atlas%20launch%20checklist`,
    );
    expect(corpusSearch.response.status).toBe(200);
    expect(corpusSearch.body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expected.id,
          threadId: expected.threadId,
        }),
      ]),
    );

    const fetched = await jsonRequest(
      `${baseUrl}/gmail/v1/users/me/messages/${expected.id}`,
    );
    expect(fetched.response.status).toBe(200);
    expect(fetched.body).toEqual(
      expect.objectContaining({
        id: expected.id,
        threadId: expected.threadId,
        labelIds: expected.labelIds,
        snippet: expected.snippet,
        historyId: expect.any(String),
        internalDate: expect.any(String),
      }),
    );
    const internalDate = Number(fetched.body.internalDate);
    expect(internalDate).toBeGreaterThanOrEqual(
      startedAt + expected.internalDateOffsetMs,
    );
    expect(internalDate).toBeLessThanOrEqual(
      readyAt + expected.internalDateOffsetMs,
    );
    expect(responseHeaders(fetched.body)).toEqual(
      expect.arrayContaining([
        { name: "From", value: "Alice Example <alice@example.test>" },
        { name: "To", value: "Owner <owner@example.test>" },
        { name: "Subject", value: "Atlas launch checklist" },
        { name: "Message-Id", value: "<syn-gmail-001@corpus-tools.local>" },
      ]),
    );
    expect(payloadBodyText(fetched.body)).toBe(expected.bodyText);

    const modified = await jsonRequest(
      `${baseUrl}/gmail/v1/users/me/messages/batchModify`,
      {
        method: "POST",
        body: JSON.stringify({
          ids: [expected.id],
          removeLabelIds: ["UNREAD"],
          addLabelIds: ["STARRED"],
        }),
      },
    );
    expect(modified.response.status).toBe(200);

    const refetched = await jsonRequest(
      `${baseUrl}/gmail/v1/users/me/messages/${expected.id}`,
    );
    expect(refetched.body.labelIds).toEqual(
      expect.arrayContaining(["INBOX", "STARRED"]),
    );
    expect(refetched.body.labelIds).not.toContain("UNREAD");
  });
});
