/**
 * Contract tests for the browser-safe Google Workspace capability catalog used
 * by connector OAuth UI.
 */
import { describe, expect, it } from "vitest";
import {
  GOOGLE_WORKSPACE_CAPABILITY_OPTIONS,
  googleWorkspaceCapabilitiesFromAccountMetadata,
  normalizeGoogleWorkspaceCapabilitySelection,
} from "./google-workspace-capabilities";

describe("google-workspace-capabilities", () => {
  it("deduplicates and ignores unknown capability ids", () => {
    expect(
      normalizeGoogleWorkspaceCapabilitySelection([
        "gmail.read",
        "gmail.read",
        "calendar.read",
        "unknown.capability",
      ]),
    ).toEqual(["gmail.read", "calendar.read"]);
  });

  it("reads granted capabilities from connected account metadata", () => {
    expect(
      googleWorkspaceCapabilitiesFromAccountMetadata({
        grantedCapabilities: ["gmail.read", "calendar.read", "drive.write"],
      }),
    ).toEqual(["gmail.read", "calendar.read", "drive.write"]);
  });

  it("covers every supported Google Workspace capability id", () => {
    expect(
      GOOGLE_WORKSPACE_CAPABILITY_OPTIONS.map((option) => option.id),
    ).toEqual([
      "gmail.read",
      "gmail.send",
      "gmail.manage",
      "calendar.read",
      "calendar.write",
      "drive.read",
      "drive.write",
      "meet.create",
      "meet.read",
    ]);
  });
});
