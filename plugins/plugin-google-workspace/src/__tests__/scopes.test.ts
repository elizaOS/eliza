import { describe, expect, it } from "vitest";
import {
  GOOGLE_CAPABILITIES,
  GOOGLE_CAPABILITY_GROUPS,
  GOOGLE_CAPABILITY_METADATA,
  GOOGLE_CAPABILITY_SCOPES,
} from "./scopes.ts";

describe("GOOGLE_CAPABILITY_METADATA", () => {
  it("covers every capability", () => {
    for (const capability of GOOGLE_CAPABILITIES) {
      expect(GOOGLE_CAPABILITY_METADATA[capability]).toBeDefined();
    }
  });

  it("maps each capability to its group", () => {
    for (const capability of GOOGLE_CAPABILITIES) {
      const meta = GOOGLE_CAPABILITY_METADATA[capability];
      expect(GOOGLE_CAPABILITY_GROUPS).toContain(meta.group);
      expect(meta.group).toBe(capability.split(".")[0]);
    }
  });

  it("gives every capability at least one scope", () => {
    for (const capability of GOOGLE_CAPABILITIES) {
      const scopes = GOOGLE_CAPABILITY_SCOPES[capability];
      expect(scopes.length).toBeGreaterThan(0);
      for (const scope of scopes) {
        expect(scope).toContain("https://www.googleapis.com/auth/");
      }
    }
  });

  it("labels every capability", () => {
    for (const capability of GOOGLE_CAPABILITIES) {
      const meta = GOOGLE_CAPABILITY_METADATA[capability];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(10);
    }
  });
});
