/**
 * ELIZA_DISABLE_PROACTIVE_AGENT is the hard kill switch for proactive
 * interactions: the decider re-reads it on every interaction so an operator
 * can stop proactive messages without a restart. plugin-personal-assistant
 * reads the same key through isDisabledByEnv, which trims and lowercases the
 * value; the gate must agree, or a "TRUE" / " True " kill switch falls through
 * to the chattiness setting and leaves the decider running.
 */
import { expect, it } from "vitest";
import { resolveProactiveChattiness } from "../src/services/proactive-interaction-gate.ts";

it("reads the kill switch as off in any letter case", () => {
  expect(
    resolveProactiveChattiness(
      { ELIZA_DISABLE_PROACTIVE_AGENT: "TRUE" },
      "chatty",
    ),
  ).toBe("off");
  expect(
    resolveProactiveChattiness(
      { ELIZA_DISABLE_PROACTIVE_AGENT: " True " },
      "chatty",
    ),
  ).toBe("off");
  expect(
    resolveProactiveChattiness(
      { ELIZA_DISABLE_PROACTIVE_AGENT: "Yes" },
      "subtle",
    ),
  ).toBe("off");
});

it("keeps the chosen chattiness when the kill switch is absent or not a disable value", () => {
  expect(resolveProactiveChattiness({}, "chatty")).toBe("chatty");
  expect(
    resolveProactiveChattiness(
      { ELIZA_DISABLE_PROACTIVE_AGENT: "0" },
      "subtle",
    ),
  ).toBe("subtle");
  expect(
    resolveProactiveChattiness(
      { ELIZA_PROACTIVE_INTERACTIONS: "Chatty" },
      undefined,
    ),
  ).toBe("chatty");
});
