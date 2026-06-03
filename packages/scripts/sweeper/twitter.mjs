import { makeUnavailableSweep } from "./_unavailable.mjs";

export default makeUnavailableSweep({
  service: "twitter",
  blockingTask: "T8g",
  reason:
    "waiting on plugin-twitter DELETE /2/tweets wrapper in the feed-summarization implementation",
});
