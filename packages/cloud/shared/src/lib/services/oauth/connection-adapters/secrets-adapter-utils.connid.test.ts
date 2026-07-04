// Exercises secrets adapter utils.connid behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, it } from "vitest";
import { generateConnectionId, verifyConnectionId } from "./secrets-adapter-utils";

/**
 * `verifyConnectionId` is the cross-org authorization check for an OAuth
 * connection (#8801 — shipped untested). The connection id is derived
 * deterministically from (platform, organizationId), so verification must REJECT
 * an id that belongs to a different org or platform — otherwise it's an IDOR
 * (one org reaching another org's connection). The accept + cross-tenant reject
 * paths are pinned.
 */
describe("verifyConnectionId", () => {
  it("derives a deterministic id from platform + org", () => {
    expect(generateConnectionId("github", "org-1")).toBe("github:org-1");
  });

  it("accepts the id that matches (platform, org)", () => {
    const id = generateConnectionId("github", "org-1");
    expect(() => verifyConnectionId("github", "org-1", id)).not.toThrow();
  });

  it("REJECTS another org's connection id (IDOR guard)", () => {
    const orgOnesId = generateConnectionId("github", "org-1");
    // same platform, different org context → must not validate
    expect(() => verifyConnectionId("github", "org-2", orgOnesId)).toThrow();
  });

  it("REJECTS a different platform's id and an arbitrary id", () => {
    const id = generateConnectionId("github", "org-1");
    expect(() => verifyConnectionId("slack", "org-1", id)).toThrow();
    expect(() => verifyConnectionId("github", "org-1", "forged-id")).toThrow();
  });
});
