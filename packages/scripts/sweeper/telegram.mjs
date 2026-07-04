// Runs connector sweeper sweeper telegram automation for local account maintenance.
import { makeUnavailableSweep } from "./_unavailable.mjs";

export default makeUnavailableSweep({
  service: "telegram",
  blockingTask: "T5c",
  reason: "waiting on plugin-telegram bot deleteMessage wrapper",
});
