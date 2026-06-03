import { makeUnavailableSweep } from "./_unavailable.mjs";

export default makeUnavailableSweep({
  service: "imessage",
  blockingTask: "T5e",
  reason:
    "waiting on BlueBubbles delete-thread admin endpoint (best-effort archive only)",
});
