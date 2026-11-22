import { subscribe } from "node:diagnostics_channel";
import { writeSync } from "node:fs";

if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_JOB === "verify") {
  subscribe("vibestack:check:phase", (timing) => {
    try {
      writeSync(2, `check phase ${JSON.stringify(timing, ["phase", "event", "elapsedMs"])}\n`);
    } catch {
      return;
    }
  });
}
