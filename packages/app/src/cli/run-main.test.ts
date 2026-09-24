/** Verifies CLI commands select the correct global process-failure policy. */
import { describe, expect, it } from "vitest";
import { isLongRunningServerCommand } from "./run-main";

describe("isLongRunningServerCommand", () => {
  it.each(["run", "serve", "start"])(
    "treats %s as a supervised long-running command",
    (command) => {
      expect(isLongRunningServerCommand(["node", "eliza", command])).toBe(true);
    },
  );

  it.each(["auth", "config", "doctor", "setup"])(
    "keeps %s fail-fast",
    (command) => {
      expect(isLongRunningServerCommand(["node", "eliza", command])).toBe(
        false,
      );
    },
  );
});
