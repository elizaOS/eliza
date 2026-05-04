import { makeNotYetImplementedSweep } from "./_not-yet-implemented.mjs";

export default makeNotYetImplementedSweep({
  service: "discord",
  blockingTask: "T5b",
  reason: "waiting on plugin-discord bulk-delete admin path used by scenarios",
});
