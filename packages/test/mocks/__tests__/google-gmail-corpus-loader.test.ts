/**
 * Covers the personal-corpus loader path through the real Google mock server:
 * corpus JSONL rows become Gmail fixtures, fixture names are exposed through the
 * mock manifest endpoint, and fault injection still applies after corpus load.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type StartedMocks, startMocks } from "../scripts/start-mocks.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sampleCorpusDir = path.resolve(
  __dirname,
  "../../../corpus-tools/fixtures/synthetic",
);

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

describe("Google Gmail corpus loader", () => {
  it("loads synthetic corpus rows into Gmail fixtures and exposes manifest names", async () => {
    activeMocks = await startMocks({
      envs: ["google"],
      corpus: { dir: sampleCorpusDir },
    });
    const baseUrl = activeMocks.baseUrls.google;

    const manifest = await jsonRequest(
      `${baseUrl}/__mock/google/gmail/fixtures`,
    );
    expect(manifest.response.status).toBe(200);
    expect(manifest.body.fixtures).toEqual(
      expect.objectContaining({
        "corpus:all": expect.arrayContaining(["syn-gmail-001"]),
        "corpus:thread:syn-thread-001": ["syn-gmail-001", "syn-gmail-002"],
        default: expect.arrayContaining(["msg-finance"]),
      }),
    );

    const message = await jsonRequest(
      `${baseUrl}/gmail/v1/users/me/messages/syn-gmail-001`,
    );
    expect(message.response.status).toBe(200);
    expect(message.body).toEqual(
      expect.objectContaining({
        id: "syn-gmail-001",
        threadId: "syn-thread-001",
        snippet: "Could you review the Atlas launch checklist before standup?",
      }),
    );

    const configured = await jsonRequest(
      `${baseUrl}/__mock/google/gmail/fault`,
      {
        method: "POST",
        body: JSON.stringify({
          mode: "server_error",
          method: "GET",
          path: "/gmail/v1/users/me/messages/syn-gmail-001",
          remaining: 1,
        }),
      },
    );
    expect(configured.response.status).toBe(200);

    const failed = await jsonRequest(
      `${baseUrl}/gmail/v1/users/me/messages/syn-gmail-001`,
    );
    expect(failed.response.status).toBe(500);

    const recovered = await jsonRequest(
      `${baseUrl}/gmail/v1/users/me/messages/syn-gmail-001`,
    );
    expect(recovered.response.status).toBe(200);
  });
});
