import { makeUnavailableSweep } from "./_unavailable.mjs";

export default makeUnavailableSweep({
  service: "calendar",
  blockingTask: "T7e",
  reason:
    "waiting on calendar scheduling-with-others plus delete-by-prefix support",
});
