// Runs connector sweeper sweeper twilio automation for local account maintenance.
import { makeUnavailableSweep } from "./_unavailable.mjs";

export default makeUnavailableSweep({
  service: "twilio",
  blockingTask: "T9e",
  reason: "waiting on Twilio call-recording DELETE wrapper (voice plugin)",
});
