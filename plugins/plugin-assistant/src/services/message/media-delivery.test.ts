import type { ActionResult } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  collectMediaDeliveryUrls,
  sanitizeReplyTextAfterMediaDelivery,
} from "./media-delivery.ts";

const LOGO_URL = "https://cdn.example.com/knowledge/logo-v3.png";

// The shape ATTACH_TO_CHAT returns after it delivered a stored item: the
// attachment went out with empty text and the planner still writes the reply
// (`modelReplyRequired`), which planner-reply.ts then runs through the
// media-delivery sanitizer.
const attachResult: ActionResult = {
  success: true,
  text: 'Attached "Logo v3" to the chat.',
  data: { mediaUrl: LOGO_URL, title: "Logo v3" },
};

function sanitizeAfterAttach(reply: string): string {
  return sanitizeReplyTextAfterMediaDelivery(
    reply,
    collectMediaDeliveryUrls([attachResult]),
  );
}

describe("sanitizeReplyTextAfterMediaDelivery preamble", () => {
  it.each([
    "Here you go! Hope you like it.",
    "Here's the logo from last week's meeting.",
    "Here are three variations of your logo. Let me know which one you like!",
    "Your video of the sunset timelapse is attached above.",
    "Done rendering your clip. It is attached above.",
  ])("keeps a reply that only starts with a preamble word: %s", (reply) => {
    expect(sanitizeAfterAttach(reply)).toBe(reply);
  });

  it.each([
    [`Here it is: ${LOGO_URL}`, ""],
    [`Here you go: ${LOGO_URL} Enjoy the colors!`, "Enjoy the colors!"],
    [`Your video is ready: ${LOGO_URL}`, ""],
    [
      "Done. Let me know if you want any changes.",
      "Let me know if you want any changes.",
    ],
  ])("still drops a lead-in to the delivered media: %s", (reply, expected) => {
    expect(sanitizeAfterAttach(reply)).toBe(expected);
  });
});
