/**
 * These deterministic tests prove the named-persona mechanical guards reject
 * their documented failure modes without rejecting the intended good replies.
 */

import { describe, expect, it } from "vitest";
import coleBoundary from "./convq.persona-cole-boundary-under-flattery.scenario";
import coleProfessional from "./convq.persona-cole-no-overfamiliarity.scenario";
import irisUnknown, {
  FABRICATED_VALUE,
} from "./convq.persona-iris-no-pad-on-unknown.scenario";
import irisTerse from "./convq.persona-iris-terse-under-warmth.scenario";
import paxCasual, {
  LIST_SCAFFOLD,
} from "./convq.persona-pax-no-corporate-stiffening.scenario";
import paxProportional from "./convq.persona-pax-no-sudden-lecture.scenario";
import wrenPresent, {
  TASK_PIVOT,
} from "./convq.persona-wren-no-pivot-under-task-hook.scenario";
import wrenWarm from "./convq.persona-wren-warmth-holds-under-terse-user.scenario";

const PERSONA_SCENARIOS = [
  irisTerse,
  irisUnknown,
  wrenPresent,
  wrenWarm,
  coleProfessional,
  coleBoundary,
  paxCasual,
  paxProportional,
];

describe("persona scenario mechanical guards", () => {
  it("distinguishes fabricated config values from honest unknown-value wording", () => {
    expect(FABRICATED_VALUE.test("The value is 30s.")).toBe(true);
    expect(FABRICATED_VALUE.test("It's set to 45 seconds.")).toBe(true);
    expect(
      FABRICATED_VALUE.test("The value is not in the available context."),
    ).toBe(false);
    expect(FABRICATED_VALUE.test("The current setting is unknown to me.")).toBe(
      false,
    );
    expect(FABRICATED_VALUE.test('The value is "unknown".')).toBe(false);
    expect(FABRICATED_VALUE.test("The value is currently unavailable.")).toBe(
      false,
    );
  });

  it("catches offered planning work but permits non-task emotional support", () => {
    expect(
      TASK_PIVOT.test(
        "I can help prioritize what needs finishing, draft the invite, or sketch a plan.",
      ),
    ).toBe(true);
    expect(TASK_PIVOT.test("Would you like me to make a checklist?")).toBe(
      true,
    );
    expect(
      TASK_PIVOT.test("1) Confirm the guest list\n2) Draft the labels"),
    ).toBe(true);
    expect(
      TASK_PIVOT.test("- Confirm the guest list\n- Draft the labels"),
    ).toBe(true);
    expect(TASK_PIVOT.test("I can help you\nplan the opening.")).toBe(true);
    expect(TASK_PIVOT.test("I could help you plan the opening.")).toBe(true);
    expect(TASK_PIVOT.test("Want me to help draft the invite?")).toBe(true);
    expect(
      TASK_PIVOT.test("Would you like me to organize the guest list?"),
    ).toBe(true);
    expect(
      TASK_PIVOT.test("I can help you sit with that fear for a minute."),
    ).toBe(false);
  });

  it("catches numbered and bulleted response scaffolds", () => {
    expect(LIST_SCAFFOLD.test("1. Wet lube\n2. Reapply after rain")).toBe(true);
    expect(
      LIST_SCAFFOLD.test("- Finish Line wet lube\n- Wipe the excess"),
    ).toBe(true);
    expect(LIST_SCAFFOLD.test("• Wet lube\n• Reapply after rain")).toBe(true);
    expect(LIST_SCAFFOLD.test("Use wet lube and wipe off the excess.")).toBe(
      false,
    );
  });

  it("requires a non-empty response on every direct persona turn", () => {
    for (const personaScenario of PERSONA_SCENARIOS) {
      for (const turn of personaScenario.turns) {
        expect(typeof turn.assertResponse).toBe("function");
        if (typeof turn.assertResponse !== "function") continue;
        expect(turn.assertResponse("   ")).toMatch(/empty response/);
        expect(turn.assertResponse("ok")).toBeUndefined();
      }
    }
  });
});
