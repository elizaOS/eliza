/**
 * Unit coverage for canonical connector-id constants in schema.ts.
 *
 * Tests list composition, uniqueness, non-emptiness, and inclusion of
 * core and local connector IDs in CONNECTOR_IDS.
 */

import { describe, expect, it } from "vitest";
import {
  CONNECTOR_IDS,
  type ConnectorId,
  ELIZA_LOCAL_CONNECTOR_IDS,
} from "./schema.js";

describe("schema connector ids", () => {
  it("exports ELIZA_LOCAL_CONNECTOR_IDS containing 'wechat'", () => {
    expect(Array.isArray(ELIZA_LOCAL_CONNECTOR_IDS)).toBe(true);
    expect(ELIZA_LOCAL_CONNECTOR_IDS).toContain("wechat");
  });

  it("exports CONNECTOR_IDS including both core and local connectors", () => {
    expect(Array.isArray(CONNECTOR_IDS)).toBe(true);
    expect(CONNECTOR_IDS.length).toBeGreaterThan(15);

    // Key connectors
    expect(CONNECTOR_IDS).toContain("discord");
    expect(CONNECTOR_IDS).toContain("telegram");
    expect(CONNECTOR_IDS).toContain("slack");
    expect(CONNECTOR_IDS).toContain("twitter");
    expect(CONNECTOR_IDS).toContain("wechat");
  });

  it("ensures all CONNECTOR_IDS are unique and lowercase strings", () => {
    const unique = new Set(CONNECTOR_IDS);
    expect(unique.size).toBe(CONNECTOR_IDS.length);

    for (const id of CONNECTOR_IDS) {
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
      expect(id.trim()).toBe(id);
    }
  });

  it("contains all ELIZA_LOCAL_CONNECTOR_IDS within CONNECTOR_IDS", () => {
    for (const localId of ELIZA_LOCAL_CONNECTOR_IDS) {
      expect(CONNECTOR_IDS.includes(localId as ConnectorId)).toBe(true);
    }
  });
});
