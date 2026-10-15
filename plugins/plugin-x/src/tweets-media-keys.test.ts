import { describe, expect, it } from "vitest";
import { parseTweetV2ToV1 } from "./client/tweets";

describe("parseTweetV2ToV1 media linkage", () => {
  const includes = {
    media: [
      {
        media_key: "m1",
        type: "photo" as const,
        url: "https://example.com/m1.jpg",
      },
      {
        media_key: "m2",
        type: "photo" as const,
        url: "https://example.com/m2.jpg",
      },
    ],
  };

  it("attaches only the media referenced by the tweet's media_keys", () => {
    const tweet = {
      id: "t1",
      text: "with one photo",
      attachments: { media_keys: ["m1"] },
    };
    const parsed = parseTweetV2ToV1(tweet, includes);
    expect(parsed.photos).toHaveLength(1);
    expect(parsed.photos[0].id).toBe("m1");
  });

  it("attaches no media when the tweet has no media_keys", () => {
    const tweet = { id: "t2", text: "no media" };
    const parsed = parseTweetV2ToV1(tweet, includes);
    expect(parsed.photos).toHaveLength(0);
    expect(parsed.videos).toHaveLength(0);
  });

  it("attaches no media when media_keys is empty", () => {
    const tweet = {
      id: "t3",
      text: "empty keys",
      attachments: { media_keys: [] },
    };
    const parsed = parseTweetV2ToV1(tweet, includes);
    expect(parsed.photos).toHaveLength(0);
  });
});

it("links each tweet to its own poll in a shared response", () => {
  const poll = (id: string) => ({
    id,
    options: [{ position: 1, label: "Yes", votes: 1 }],
    duration_minutes: 5,
    end_datetime: "2026-10-15T12:00:00Z",
    voting_status: "open" as const,
  });
  const includes = { polls: [poll("other"), poll("mine")] };
  expect(
    parseTweetV2ToV1(
      { id: "t4", text: "Vote", attachments: { poll_ids: ["mine"] } },
      includes,
    ).poll?.id,
  ).toBe("mine");
  expect(
    parseTweetV2ToV1({ id: "t5", text: "No poll" }, includes).poll,
  ).toBeNull();
});
