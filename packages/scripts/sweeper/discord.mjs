// Runs connector sweeper sweeper discord automation for local account maintenance.
import { makeUnavailableSweep } from "./_unavailable.mjs";

export default makeUnavailableSweep({
  service: "discord",
  blockingTask: "T5b",
  reason: "waiting on plugin-discord bulk-delete admin path used by scenarios",
});
