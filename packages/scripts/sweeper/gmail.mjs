// Runs connector sweeper sweeper gmail automation for local account maintenance.
import { makeUnavailableSweep } from "./_unavailable.mjs";

export default makeUnavailableSweep({
  service: "gmail",
  blockingTask: "T7d",
  reason: "waiting on plugin-gmail delete-by-label admin path",
});
