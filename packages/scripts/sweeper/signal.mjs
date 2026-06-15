import { makeUnavailableSweep } from "./_unavailable.mjs";

export default makeUnavailableSweep({
  service: "signal",
  blockingTask: "T5f",
  reason: "waiting on plugin-signal local-history cleanup via signal-cli admin",
});
