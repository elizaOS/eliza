/**
 * Coverage for cloud-eliza-persona.
 */
import { describe, expect, it } from "vitest";
import {
  buildCloudElizaPersona,
  CLOUD_MEMORY_BIO,
  CLOUD_MEMORY_SYSTEM,
} from "./cloud-eliza-persona.js";

describe("cloud-eliza-persona", () => {
  it("has bio", () => {
    expect(CLOUD_MEMORY_BIO).toContain("Remembers");
  });
  it("has system", () => {
    expect(CLOUD_MEMORY_SYSTEM).toContain("Memory");
  });
  it("builds persona", () => {
    const persona = buildCloudElizaPersona();
    expect(persona.bio.join(" ")).toContain("Remembers");
    expect(persona.system).toContain("Memory");
  });
});
