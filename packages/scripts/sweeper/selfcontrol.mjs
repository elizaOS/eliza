// Runs connector sweeper sweeper selfcontrol automation for local account maintenance.
import { makeUnavailableSweep } from "./_unavailable.mjs";

export default makeUnavailableSweep({
  service: "selfcontrol",
  blockingTask: "T7g",
  reason:
    "waiting on website-blocker chat integration with e2e-prefix profile cleanup",
});
