import { describe, expect, it } from "vitest";
import { neynarCastToCast } from "../utils";

describe("farcaster utility hardening", () => {
  it("does not throw when Neynar omits parent_author for a parented cast", () => {
    const cast = neynarCastToCast({
      hash: "0xchild",
      text: "reply",
      timestamp: "2026-01-01T00:00:00.000Z",
      thread_hash: "0xthread",
      parent_hash: "0xparent",
      parent_author: undefined,
      embeds: [],
      author: {
        fid: 123,
        display_name: "Author",
        username: "author",
      },
    } as never);

    expect(cast.inReplyTo).toBeUndefined();
    expect(cast.hash).toBe("0xchild");
  });
});
