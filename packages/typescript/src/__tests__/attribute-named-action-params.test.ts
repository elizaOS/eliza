/**
 * Regression test: action params can also arrive in attribute-named XML form
 * `<param name="X">value</param>` instead of the canonical tag-named form
 * `<X>value</X>`.
 *
 * Some planners (especially small models on the action_planner template)
 * emit the attribute-named form even though the prompt asks for tag-named.
 * Without parser tolerance, every such param ends up bucketed under the key
 * "param" and the handler sees an empty params object — actions like
 * UPDATE_OWNER_PROFILE return MISSING_FIELDS instead of completing.
 */

import { describe, expect, it } from "vitest";
import { parseActionParams } from "../actions";

describe("attribute-named action params", () => {
  it("reads `name` attribute as the key for <param name='X'>value</param>", () => {
    const xml = `
      <action>
        <name>UPDATE_OWNER_PROFILE</name>
        <params>
          <param name="travelBookingPreferences">aisle seats, no red-eyes</param>
          <param name="confirmed">true</param>
        </params>
      </action>
    `;
    const parsed = parseActionParams(xml);
    const params = parsed.get("UPDATE_OWNER_PROFILE");
    expect(params).toBeDefined();
    expect(params?.travelBookingPreferences).toBe(
      "aisle seats, no red-eyes",
    );
    expect(params?.confirmed).toBe(true);
    // Should NOT bucket everything under the literal key "param".
    expect(params?.param).toBeUndefined();
  });

  it("handles single-quoted name attribute", () => {
    const xml = `
      <action>
        <name>LIFE</name>
        <params>
          <param name='intent'>create_definition</param>
          <param name='kind'>todo</param>
        </params>
      </action>
    `;
    const parsed = parseActionParams(xml);
    expect(parsed.get("LIFE")?.intent).toBe("create_definition");
    expect(parsed.get("LIFE")?.kind).toBe("todo");
  });

  it("handles unquoted name attribute", () => {
    const xml = `
      <action>
        <name>OWNER_INBOX</name>
        <params>
          <param name=subaction>digest</param>
        </params>
      </action>
    `;
    const parsed = parseActionParams(xml);
    expect(parsed.get("OWNER_INBOX")?.subaction).toBe("digest");
  });

  it("falls back to tag name when no name attribute present", () => {
    const xml = `
      <action>
        <name>OWNER_INBOX</name>
        <params>
          <subaction>digest</subaction>
          <channel>all</channel>
        </params>
      </action>
    `;
    const parsed = parseActionParams(xml);
    expect(parsed.get("OWNER_INBOX")?.subaction).toBe("digest");
    expect(parsed.get("OWNER_INBOX")?.channel).toBe("all");
  });

  it("mixed canonical and attribute-named forms in the same params block", () => {
    const xml = `
      <action>
        <name>OWNER_CALENDAR</name>
        <params>
          <subaction>propose_times</subaction>
          <param name="durationMinutes">30</param>
          <param name="slotCount">3</param>
        </params>
      </action>
    `;
    const parsed = parseActionParams(xml);
    expect(parsed.get("OWNER_CALENDAR")?.subaction).toBe("propose_times");
    expect(parsed.get("OWNER_CALENDAR")?.durationMinutes).toBe(30);
    expect(parsed.get("OWNER_CALENDAR")?.slotCount).toBe(3);
  });
});
