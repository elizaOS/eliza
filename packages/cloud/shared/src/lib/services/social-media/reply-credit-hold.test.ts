import { afterEach, expect, spyOn, test } from "bun:test";
import { creditsService } from "../credits";
import { socialMediaService } from "./index";
import { blueskyProvider } from "./providers/bluesky";

/**
 * A reply whose create timed out may have posted. Like a post, its credit is
 * held, not refunded; a reply the platform clearly refused is refunded.
 */
const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function stubReplyPath() {
  spies.push(
    spyOn(socialMediaService, "getCredentialsForPlatform").mockResolvedValue({
      handle: "a.bsky.social",
      appPassword: "x",
    } as never),
    spyOn(creditsService, "deductCredits").mockResolvedValue({ success: true } as never),
  );
  const refund = spyOn(creditsService, "refundCredits").mockResolvedValue(undefined as never);
  spies.push(refund);
  return refund;
}

test("a reply with an unknown outcome keeps its credit", async () => {
  const refund = stubReplyPath();
  spies.push(
    spyOn(blueskyProvider, "replyToPost").mockResolvedValue({
      platform: "bluesky",
      success: false,
      error: "timed out",
      errorCode: "POST_OUTCOME_UNKNOWN",
      creditDisposition: "hold",
    }),
  );

  const result = await socialMediaService.replyToPost("org-1", "bluesky", "at://post", {
    text: "Thanks!",
  });

  expect(result.creditDisposition).toBe("hold");
  expect(refund).not.toHaveBeenCalled();
});

test("a reply the platform refused is refunded", async () => {
  const refund = stubReplyPath();
  spies.push(
    spyOn(blueskyProvider, "replyToPost").mockResolvedValue({
      platform: "bluesky",
      success: false,
      error: "InvalidRequest",
    }),
  );

  await socialMediaService.replyToPost("org-1", "bluesky", "at://post", { text: "Thanks!" });

  expect(refund).toHaveBeenCalledTimes(1);
});
