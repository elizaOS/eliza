/**
 * Coverage for surface-realm-channel.
 */
import { describe, expect, it } from "vitest";
import {
  isPrivilegedShellActive,
  runAsPrivilegedShell,
} from "./surface-realm-channel.js";

describe("surface-realm-channel", () => {
  it("tracks privileged shell", () => {
    expect(isPrivilegedShellActive()).toBe(false);
    runAsPrivilegedShell(() => {
      expect(isPrivilegedShellActive()).toBe(true);
    });
    expect(isPrivilegedShellActive()).toBe(false);
  });
  it("supports nesting", () => {
    runAsPrivilegedShell(() => {
      runAsPrivilegedShell(() => {
        expect(isPrivilegedShellActive()).toBe(true);
      });
      expect(isPrivilegedShellActive()).toBe(true);
    });
    expect(isPrivilegedShellActive()).toBe(false);
  });
  it("returns value", () => {
    const v = runAsPrivilegedShell(() => 42);
    expect(v).toBe(42);
  });
});
