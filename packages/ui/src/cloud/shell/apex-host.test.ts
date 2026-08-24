/**
 * Unit tests for apex host detection: validates control plane host resolution.
 */
import { describe, expect, it } from "vitest";
import {
  APEX_UI_CONTROL_PLANE_HOSTS,
  isApexControlPlaneHostname,
} from "./apex-host.ts";

describe("apex-host", () => {
  it("contains production marketing host in control plane set", () => {
    expect(APEX_UI_CONTROL_PLANE_HOSTS.size).toBeGreaterThan(0);
  });

  it("identifies marketing hostnames as apex control plane", () => {
    expect(isApexControlPlaneHostname("eliza.app")).toBe(true);
    expect(isApexControlPlaneHostname("staging.eliza.app")).toBe(true);
  });

  it("returns false for random unknown hostnames", () => {
    expect(isApexControlPlaneHostname("example.com")).toBe(false);
    expect(isApexControlPlaneHostname("localhost")).toBe(false);
  });
});
