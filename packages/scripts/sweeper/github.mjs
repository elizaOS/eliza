// Runs connector sweeper sweeper github automation for local account maintenance.
import { makeUnavailableSweep } from "./_unavailable.mjs";

export default makeUnavailableSweep({
  service: "github",
  blockingTask: "T8i",
  reason: "waiting on plugin-github scratch-repo lifecycle implementation",
});
