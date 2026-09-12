/**
 * Tool-schema contract for the CONNECTOR action's Google scope narrowing: the
 * `capabilities` argument the handler forwards to `startGoogleConnector` must be
 * accepted by core's real argument validator, otherwise scope narrowing is
 * unreachable from any planner call (#31115). Deterministic, no runtime.
 */

import { describe, expect, it } from "vitest";
import { validateToolArgs } from "../../../../packages/core/src/actions/validate-tool-args.js";
import { LIFEOPS_GOOGLE_CAPABILITIES } from "../contracts/index.js";
import { connectorAction } from "./connector.js";

describe("CONNECTOR capabilities parameter", () => {
  it("accepts a google connect call that narrows scopes to declared capabilities", () => {
    const result = validateToolArgs(connectorAction, {
      connector: "google",
      action: "connect",
      capabilities: ["google.calendar.read", "google.gmail.triage"],
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("offers every LifeOps Google capability and nothing else", () => {
    const parameter = connectorAction.parameters?.find(
      (entry) => entry.name === "capabilities",
    );
    expect(parameter?.required).toBe(false);
    expect(parameter?.schema.type).toBe("array");
    expect(parameter?.schema.items?.enum).toEqual([
      ...LIFEOPS_GOOGLE_CAPABILITIES,
    ]);
  });

  it("rejects a capability name outside the shared contract", () => {
    const result = validateToolArgs(connectorAction, {
      connector: "google",
      action: "connect",
      capabilities: ["google.drive.read"],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/capabilities/);
  });

  it("still accepts a connect call that omits capabilities", () => {
    const result = validateToolArgs(connectorAction, {
      connector: "google",
      action: "connect",
    });
    expect(result.valid).toBe(true);
  });
});
