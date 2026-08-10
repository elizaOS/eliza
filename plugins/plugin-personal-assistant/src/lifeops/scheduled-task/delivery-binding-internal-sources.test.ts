/**
 * Provenance classification behind `bindScheduledTaskToInboundChat` (#17747).
 *
 * The guard is fail-open: a provenance it does not recognise is BOUND to
 * outbound connector dispatch, so every sentinel core defines is asserted
 * individually rather than as a count.
 *
 * Scope is deliberately the predicate, not the binding. The trusted-audience
 * record the binding requires is minted by the runtime under a module-private
 * symbol and cannot be constructed here, so a binding-level assertion in this
 * file would return null for the wrong reason and pass vacuously. End-to-end
 * coverage of the branch belongs to the pglite integration lane.
 */
import { MESSAGE_SOURCES } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { isInternalMessageSource } from "./delivery-binding";

const INTERNAL_SENTINELS = Object.values(MESSAGE_SOURCES);

describe("isInternalMessageSource", () => {
  it("covers every sentinel core defines", () => {
    // Pins the guard to the canonical list rather than to this file's opinion
    // of it: a sentinel added upstream fails here as well as at typecheck.
    for (const sentinel of INTERNAL_SENTINELS) {
      expect(isInternalMessageSource(sentinel)).toBe(true);
    }
    expect(INTERNAL_SENTINELS).toHaveLength(5);
  });

  it("covers the api transport label", () => {
    expect(isInternalMessageSource("api")).toBe(true);
  });

  it("does not claim real connectors", () => {
    for (const connector of ["discord", "telegram", "slack", "sms"]) {
      expect(isInternalMessageSource(connector)).toBe(false);
    }
  });

  it("treats absent or empty provenance as not-internal", () => {
    // Absent provenance is handled by the attestation checks upstream; this
    // predicate must not silently claim it.
    expect(isInternalMessageSource(undefined)).toBe(false);
    expect(isInternalMessageSource("")).toBe(false);
  });

  it("does not inherit Object.prototype keys", () => {
    // A plain `in` or truthiness check would report these as internal.
    expect(isInternalMessageSource("toString")).toBe(false);
    expect(isInternalMessageSource("constructor")).toBe(false);
  });

  it("still refuses the original denylist names (regression pin)", () => {
    expect(isInternalMessageSource("client_chat")).toBe(true);
    expect(isInternalMessageSource("api")).toBe(true);
  });

  it("refuses the three sentinels the old denylist left open", () => {
    expect(isInternalMessageSource("sub_agent")).toBe(true);
    expect(isInternalMessageSource("coding-agent")).toBe(true);
    expect(isInternalMessageSource("agent_greeting")).toBe(true);
    expect(isInternalMessageSource("trigger-prompt")).toBe(true);
  });
});
