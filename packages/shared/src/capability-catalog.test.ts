/** Exercises the runtime capability-handoff contract against malformed, hostile, and valid browser-bound receipts. */

import { describe, expect, it } from "vitest";
import {
  capabilityHandoffTargetAgentId,
  parsePersonalWorkspaceCapabilityHandoff,
} from "./capability-catalog";

const valid = {
  version: 1,
  kind: "capability_handoff",
  capabilityId: "calendar",
  label: "Calendar",
  availability: "needs_workspace",
  reason: "Calendar needs setup.",
  currentTier: "shared",
  requiredTier: "personal",
  nextAction: "upgrade_workspace",
  requiresConfirmation: true,
  cta: { label: "Set up", href: "/cloud/agents/personal%3Aone" },
  continuation: { originalIntent: "Move tomorrow's meeting." },
};

describe("personal workspace capability handoff", () => {
  it("preserves a valid contained review receipt", () => {
    expect(
      parsePersonalWorkspaceCapabilityHandoff(valid, "personal:one"),
    ).toEqual(valid);
    expect(capabilityHandoffTargetAgentId(valid.cta.href)).toBe("personal:one");
  });

  it.each([
    { ...valid, version: 2 },
    { ...valid, availability: "needs_connection" },
    { ...valid, nextAction: "connect_account" },
    { ...valid, requiresConfirmation: false },
    { ...valid, cta: { label: "Set up", href: "https://evil.test" } },
    { ...valid, cta: { label: "Set up", href: "//evil.test/cloud/agents/a" } },
    { ...valid, cta: { label: "Set up", href: "/cloud/agents/a/../b" } },
    { ...valid, cta: { label: "Set up", href: "/cloud/agents/%2e%2e" } },
    { ...valid, cta: { label: "Set up", href: "/cloud/agents/%2F" } },
    { ...valid, cta: { label: "Set up", href: "/cloud/agents/%5c" } },
    { ...valid, cta: { label: "Set up", href: "/cloud/agents/%252e%252e" } },
    { ...valid, cta: { label: "Set up", href: "/cloud/agents/%00agent" } },
    { ...valid, capabilityId: "conversation" },
    { ...valid, continuation: 1 },
    { ...valid, continuation: { originalIntent: 1 } },
    { ...valid, continuation: { clientMessageId: false } },
    Object.assign(Object.create({ version: 1 }), valid, { version: 2 }),
  ])("rejects an invalid or hostile receipt", (candidate) => {
    expect(parsePersonalWorkspaceCapabilityHandoff(candidate)).toBeNull();
  });

  it("preserves a long original intent without changing model context", () => {
    const originalIntent = "x".repeat(16_001);
    expect(
      parsePersonalWorkspaceCapabilityHandoff({
        ...valid,
        continuation: { originalIntent },
      })?.continuation?.originalIntent,
    ).toBe(originalIntent);
  });

  it("binds the receipt to the expected agent", () => {
    expect(
      parsePersonalWorkspaceCapabilityHandoff(valid, "another"),
    ).toBeNull();
  });

  it("fails closed when hostile object access throws", () => {
    const hostile = new Proxy(valid, {
      get() {
        throw new Error("hostile getter");
      },
    });
    expect(parsePersonalWorkspaceCapabilityHandoff(hostile)).toBeNull();
  });
});
