import { describe, expect, it } from "vitest";
import { buildPayload } from "./element-reporter";
import { ViewAgentRegistry } from "./registry";

describe("element-reporter buildPayload", () => {
  it("maps the registry snapshot to the report payload shape", () => {
    const registry = new ViewAgentRegistry("wallet", "gui");
    registry.register(
      {
        id: "amount",
        label: "Amount",
        role: "text-input",
        getValue: () => "5",
      },
      () => null,
    );
    registry.register(
      { id: "send", label: "Send", role: "button" },
      () => null,
    );

    const payload = buildPayload(registry);
    expect(payload.viewId).toBe("wallet");
    const byId = Object.fromEntries(payload.elements.map((e) => [e.id, e]));
    expect(byId.amount).toMatchObject({
      id: "amount",
      role: "text-input",
      label: "Amount",
      value: "5",
    });
    expect(byId.send).toMatchObject({
      id: "send",
      role: "button",
      label: "Send",
    });
    // No spurious value/focused keys when absent.
    expect("value" in byId.send).toBe(false);
    expect("focused" in byId.send).toBe(false);
  });

  it("returns an empty element list for an empty view", () => {
    const registry = new ViewAgentRegistry("empty", "gui");
    expect(buildPayload(registry).elements).toEqual([]);
  });
});
