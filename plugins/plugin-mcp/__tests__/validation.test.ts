/**
 * Selection-validator tests for MCP tool and resource dispatch.
 * They cover untrusted model output before a call reaches a connected server, including server state, tool/resource existence, and argument schema checks.
 */

import type { State } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  validateResourceSelection,
  validateToolSelectionArgument,
  validateToolSelectionName,
} from "../src/utils/validation.js";

const stateWith = (mcp: Record<string, unknown>): State =>
  ({ values: { mcp }, data: {}, text: "" }) as unknown as State;

const connectedServer = {
  status: "connected",
  tools: { search: { description: "search the web" } },
};

describe("validateToolSelectionName", () => {
  it("accepts a noToolAvailable signal and preserves reasoning", () => {
    const res = validateToolSelectionName(
      { noToolAvailable: true, reasoning: "nothing fits" },
      stateWith({})
    );
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.noToolAvailable).toBe(true);
      expect(res.data.reasoning).toBe("nothing fits");
    }
  });

  it("rejects a selection for an unknown or disconnected server", () => {
    expect(
      validateToolSelectionName({ serverName: "ghost", toolName: "search" }, stateWith({})).success
    ).toBe(false);
    expect(
      validateToolSelectionName(
        { serverName: "web", toolName: "search" },
        stateWith({ web: { status: "connecting", tools: {} } })
      ).success
    ).toBe(false);
  });

  it("rejects a tool that does not exist on a connected server", () => {
    const res = validateToolSelectionName(
      { serverName: "web", toolName: "delete_everything" },
      stateWith({ web: connectedServer })
    );
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toMatch(/not found on server/);
  });

  it("accepts a real tool on a connected server", () => {
    const res = validateToolSelectionName(
      { serverName: "web", toolName: "search" },
      stateWith({ web: connectedServer })
    );
    expect(res.success).toBe(true);
  });

  it("rejects structurally invalid output (missing toolName)", () => {
    expect(
      validateToolSelectionName({ serverName: "web" }, stateWith({ web: connectedServer })).success
    ).toBe(false);
  });
});

describe("validateToolSelectionArgument", () => {
  const schema = {
    type: "object",
    properties: { q: { type: "string" } },
    required: ["q"],
  } as const;

  it("validates arguments against the tool input schema", () => {
    expect(validateToolSelectionArgument({ toolArguments: { q: "hi" } }, schema).success).toBe(
      true
    );
    const bad = validateToolSelectionArgument({ toolArguments: {} }, schema);
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error).toMatch(/Invalid arguments/);
  });

  it("coerces an empty-string/'{}' toolArguments to an empty object", () => {
    const emptyObjSchema = { type: "object" } as const;
    expect(validateToolSelectionArgument({ toolArguments: "" }, emptyObjSchema).success).toBe(true);
    expect(validateToolSelectionArgument({ toolArguments: "{}" }, emptyObjSchema).success).toBe(
      true
    );
  });
});

describe("validateResourceSelection", () => {
  it("accepts noResourceAvailable and a well-formed selection, rejects a malformed one", () => {
    expect(validateResourceSelection({ noResourceAvailable: true }).success).toBe(true);
    expect(validateResourceSelection({ serverName: "fs", uri: "file:///a" }).success).toBe(true);
    expect(validateResourceSelection({ serverName: "fs" }).success).toBe(false);
  });
});
