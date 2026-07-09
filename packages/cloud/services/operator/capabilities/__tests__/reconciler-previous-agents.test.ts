/**
 * Real-error-path coverage for `getPreviousAgentIds` (#12268): a corrupt or
 * malformed `eliza.ai/previous-agents` annotation must throw so the reconcile
 * loop's J1 boundary surfaces it, never fabricate an empty list that silently
 * skips Redis cleanup of removed agents.
 */
import { describe, expect, test } from "bun:test";
import type { Server } from "../crd/generated/server-v1alpha1";
import { getPreviousAgentIds } from "../previous-agents";

function serverWithAnnotation(value: string | undefined): Server {
  return {
    metadata: {
      name: "server-a",
      annotations:
        value === undefined ? {} : { "eliza.ai/previous-agents": value },
    },
  } as Server;
}

describe("getPreviousAgentIds", () => {
  test("absent annotation is a legitimate empty list (first reconcile)", () => {
    expect(getPreviousAgentIds(serverWithAnnotation(undefined))).toEqual([]);
    expect(getPreviousAgentIds({ metadata: {} } as Server)).toEqual([]);
  });

  test("valid JSON string array round-trips", () => {
    expect(
      getPreviousAgentIds(serverWithAnnotation('["agent-1","agent-2"]')),
    ).toEqual(["agent-1", "agent-2"]);
    expect(getPreviousAgentIds(serverWithAnnotation("[]"))).toEqual([]);
  });

  test("corrupt JSON throws (does not fabricate empty)", () => {
    expect(() =>
      getPreviousAgentIds(serverWithAnnotation("{not json")),
    ).toThrow(/corrupt eliza.ai\/previous-agents annotation/);
  });

  test("well-formed JSON that is not a string array throws", () => {
    expect(() =>
      getPreviousAgentIds(serverWithAnnotation('{"agent":1}')),
    ).toThrow(/not a string array/);
    expect(() => getPreviousAgentIds(serverWithAnnotation("[1,2,3]"))).toThrow(
      /not a string array/,
    );
    expect(() =>
      getPreviousAgentIds(serverWithAnnotation('"agent-1"')),
    ).toThrow(/not a string array/);
  });

  test("corrupt annotation preserves the underlying parse error as cause", () => {
    try {
      getPreviousAgentIds(serverWithAnnotation("{not json"));
      throw new Error("expected getPreviousAgentIds to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).cause).toBeInstanceOf(Error);
    }
  });
});
