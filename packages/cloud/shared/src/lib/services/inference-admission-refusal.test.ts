import { describe, expect, it } from "vitest";
import {
  clearAllOrgAdmissionRefusals,
  clearOrgAdmissionRefused,
  isOrgAdmissionRefused,
  markOrgAdmissionRefused,
} from "./inference-admission-refusal.js";

describe("inference-admission-refusal", () => {
  it("marks and checks refused", () => {
    const id = `org-${Date.now()}-${Math.random()}`;
    expect(isOrgAdmissionRefused(id)).toBe(false);
    markOrgAdmissionRefused(id);
    expect(isOrgAdmissionRefused(id)).toBe(true);
  });

  it("clears single org", () => {
    const id = `org-${Date.now()}-${Math.random()}-clear`;
    markOrgAdmissionRefused(id);
    clearOrgAdmissionRefused(id);
    expect(isOrgAdmissionRefused(id)).toBe(false);
  });

  it("clears all", () => {
    const a = `org-a-${Date.now()}`;
    const b = `org-b-${Date.now()}`;
    markOrgAdmissionRefused(a);
    markOrgAdmissionRefused(b);
    clearAllOrgAdmissionRefusals();
    expect(isOrgAdmissionRefused(a)).toBe(false);
    expect(isOrgAdmissionRefused(b)).toBe(false);
  });
});
