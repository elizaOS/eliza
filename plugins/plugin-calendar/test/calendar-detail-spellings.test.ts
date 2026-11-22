/**
 * The standalone Calendar family under the shared `details` spelling contract,
 * plus the two parts of it that are this plugin's alone: the handler folds
 * every accepted spelling into its field, and a field's guidance is on the
 * one spelling that is described, so none is lost with the alternates' text.
 */
import { describe, expect, it } from "vitest";
import { calendarAction } from "../src/actions/calendar.js";
import { normalizeCalendarDetails } from "../src/actions/calendar-handler.js";
import { calendarOperationActions } from "../src/calendar-read-parameters.js";
import {
  DETAIL_FIELDS,
  type DetailFieldName,
  describeCalendarDetailSpellings,
  plannerDetailLevels,
} from "./calendar-detail-spellings-contract.js";

describeCalendarDetailSpellings(calendarOperationActions(calendarAction));

describe("Calendar details spellings", () => {
  it("fold into one handler field each", () => {
    for (const [name, field] of Object.entries(DETAIL_FIELDS)) {
      const handlerField = "handlerField" in field ? field.handlerField : name;
      for (const spelling of field.spellings)
        expect(
          normalizeCalendarDetails({ [spelling]: field.value })?.[handlerField],
          `${spelling} reaches ${handlerField}`,
        ).toEqual(field.value);
    }
  });

  it("keep their guidance on the spelling the planner writes", () => {
    const [umbrella] = plannerDetailLevels(calendarAction);
    const guided: DetailFieldName[] = [
      "calendarId",
      "eventId",
      "start",
      "end",
      "timeMin",
      "timeMax",
      "timeZone",
      "newTitle",
      "oldTitle",
      "description",
      "location",
    ];
    for (const field of guided)
      expect(umbrella.properties?.[field]?.description, field).toBeTruthy();
    // The alternates say nothing, so the rule against invented ids is here.
    expect(umbrella.properties?.eventId?.description).toContain(
      "Never invent an event ID or derive it from a title",
    );
  });
});
