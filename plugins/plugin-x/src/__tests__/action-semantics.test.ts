import { describe, expect, it } from "vitest";
import { fetchFeedTopAction } from "../actions/fetchFeedTop.js";
import { postTweetAction } from "../actions/postTweet.js";
import { readUnreadXDmsAction } from "../actions/readUnreadXDms.js";
import { replyXDmAction } from "../actions/replyXDm.js";
import { searchXAction } from "../actions/searchX.js";
import { sendXPostAction } from "../actions/sendXPost.js";
import { summarizeFeedAction } from "../actions/summarizeFeed.js";

type ActionInteractionSemantics = {
  suppressPostActionContinuation?: boolean;
  suppressActionResultClipboard?: boolean;
};

describe("Twitter/X action interaction semantics", () => {
  it("marks terminal send actions as turn-owning", () => {
    expect(
      (postTweetAction as ActionInteractionSemantics)
        .suppressPostActionContinuation,
    ).toBe(true);
    expect(
      (sendXPostAction as ActionInteractionSemantics)
        .suppressPostActionContinuation,
    ).toBe(true);
    expect(
      (replyXDmAction as ActionInteractionSemantics)
        .suppressPostActionContinuation,
    ).toBe(true);
  });

  it("keeps confirmation previews copyable while suppressing legacy direct post copies", () => {
    expect(
      (postTweetAction as ActionInteractionSemantics)
        .suppressActionResultClipboard,
    ).toBe(true);
    expect(
      (sendXPostAction as ActionInteractionSemantics)
        .suppressActionResultClipboard,
    ).not.toBe(true);
    expect(
      (replyXDmAction as ActionInteractionSemantics)
        .suppressActionResultClipboard,
    ).not.toBe(true);
  });

  it("keeps informational retrieval actions copyable", () => {
    for (const action of [
      readUnreadXDmsAction,
      searchXAction,
      fetchFeedTopAction,
      summarizeFeedAction,
    ]) {
      expect(
        (action as ActionInteractionSemantics).suppressActionResultClipboard,
      ).not.toBe(true);
    }
  });
});
