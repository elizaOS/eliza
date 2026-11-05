import { describe, expect, it } from "vitest";
import { Client } from "./client";
import { countTwitterWeightedLength } from "./tweet-length";
import { sendTextAsTweetThread, splitTweetContent } from "./utils";

const LIMIT = 280;

/** Visible post text of exactly `length` characters that ends in a word. */
function visiblePost(length: number): string {
  const words =
    "We just shipped the new deployment pipeline for the agent runtime and builds now run in parallel across every package ";
  const text = words.repeat(Math.ceil(length / words.length));
  return `${text.slice(0, length - 1)}x`;
}

function expectWithinLimit(parts: string[]) {
  for (const part of parts) {
    expect(part.length).toBeGreaterThan(0);
    expect(part.trim().length).toBeGreaterThan(0);
    expect(countTwitterWeightedLength(part)).toBeLessThanOrEqual(LIMIT);
  }
}

describe("splitTweetContent", () => {
  it("cuts long English text at a space instead of inside a word", () => {
    const text =
      "We just shipped the new deployment pipeline for the agent runtime. Builds now run in parallel across every package, " +
      "cache hits skip the typecheck step, and failed jobs report the exact package that broke instead of a wall of logs. " +
      "Next up is wiring the release notes generator into the same flow so every tag gets a summary automatically.";

    const parts = splitTweetContent(text, LIMIT);

    expect(parts.length).toBe(2);
    expect(parts.join("")).toBe(text);
    expectWithinLimit(parts);
    for (let i = 0; i + 1 < parts.length; i += 1) {
      expect(parts[i]).toMatch(/\s$/);
      expect(parts[i + 1]).toMatch(/^\S/);
    }
  });

  it("keeps a URL near the boundary whole", () => {
    const url =
      "https://example.com/releases/agent-runtime/deployment-pipeline";
    const text = `${"word ".repeat(52)}read more at ${url} and tell us what you think about it.`;

    const parts = splitTweetContent(text, LIMIT);

    expect(parts.length).toBe(2);
    expect(parts.join("")).toBe(text);
    expectWithinLimit(parts);
    expect(parts.filter((part) => part.includes(url))).toHaveLength(1);
  });

  it("splits long CJK text with no spaces losslessly within the limit", () => {
    const text = "分散型エージェントの新しい配備手順を公開しました".repeat(20);

    const parts = splitTweetContent(text, LIMIT);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(text);
    expectWithinLimit(parts);
  });

  it("returns text within the limit as a single part", () => {
    const text = "Short update: the deployment pipeline is live.";

    expect(splitTweetContent(text, LIMIT)).toEqual([text]);
  });

  it("does not make a post of the whitespace that ends text past the limit", () => {
    // Model replies often end in newlines. The visible text fills 279 of the
    // 280 characters, so only the second newline crosses the limit.
    const post = visiblePost(279);
    expect(countTwitterWeightedLength(`${post}\n`)).toBe(LIMIT);

    const parts = splitTweetContent(`${post}\n\n`, LIMIT);

    expect(parts).toEqual([`${post}\n`]);
    expectWithinLimit(parts);
  });
});

describe("sendTextAsTweetThread", () => {
  it("posts text whose trailing newlines cross the limit once", async () => {
    const client = new Client();

    const receipts = await sendTextAsTweetThread(
      `${visiblePost(279)}\n\n`,
      async (chunk, previousTweetId, index) => {
        // Client.sendTweet refuses blank text ("Text is required") before
        // it reads credentials. This client has none, so "Not authenticated"
        // means the post passed that check and would have gone to X.
        try {
          await client.sendTweet(chunk, previousTweetId);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "Not authenticated"
          ) {
            throw error;
          }
        }
        return { id: `post-${index}` };
      },
    );

    expect(receipts.map((receipt) => receipt.id)).toEqual(["post-0"]);
  });
});
