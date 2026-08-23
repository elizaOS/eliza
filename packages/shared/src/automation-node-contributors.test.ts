/**
 * Coverage for automation-node-contributors.
 */
import { describe, expect, it } from "vitest";
import {
  buildRuntimeCapabilityNodes,
  clearAutomationNodeContributorsForTests,
  listAutomationNodeContributors,
  registerAutomationNodeContributor,
} from "./automation-node-contributors.js";

const baseSpec = {
  id: "n1",
  label: "N1",
  description: "d",
  class: "action",
  backingCapability: "cap",
  actionNames: ["SEND_MESSAGE"],
  pluginNames: [],
  ownerScoped: false,
  enabledWithoutRuntimeCapability: false,
  disabledReason: "missing",
};

describe("automation-node-contributors", () => {
  it("builds disabled nodes when the runtime lacks the capability", () => {
    const nodes = buildRuntimeCapabilityNodes([baseSpec], {
      actions: [],
      plugins: [],
    } as never);
    expect(nodes[0].id).toBe("n1");
    expect(nodes[0].availability).toBe("disabled");
    expect(nodes[0].requiresSetup).toBe(true);
    expect(nodes[0].disabledReason).toBe("missing");
  });

  it("marks enabled when the runtime has a matching action (case-insensitive)", () => {
    const nodes = buildRuntimeCapabilityNodes([baseSpec], {
      actions: [{ name: "send_message" }],
      plugins: [],
    } as never);
    expect(nodes[0].availability).toBe("enabled");
    expect(nodes[0].requiresSetup).toBe(false);
  });

  it("marks enabled via matching plugin name", () => {
    const nodes = buildRuntimeCapabilityNodes(
      [{ ...baseSpec, pluginNames: ["SEND_MESSAGE"] }],
      { actions: [], plugins: [{ name: "SEND_MESSAGE" }] } as never,
    );
    expect(nodes[0].availability).toBe("enabled");
  });

  it("registers and lists contributors, clearing for tests", () => {
    clearAutomationNodeContributorsForTests();
    expect(listAutomationNodeContributors()).toEqual([]);
    const fn = () => ({ id: "a" }) as never;
    registerAutomationNodeContributor("a", fn);
    expect(listAutomationNodeContributors()).toEqual([fn]);
    clearAutomationNodeContributorsForTests();
    expect(listAutomationNodeContributors()).toEqual([]);
  });

  it("trims contributor ids and rejects empty ids", () => {
    clearAutomationNodeContributorsForTests();
    const fn = () => ({ id: "b" }) as never;
    registerAutomationNodeContributor("  b  ", fn);
    expect(listAutomationNodeContributors()).toEqual([fn]);
    expect(() => registerAutomationNodeContributor("  ", fn)).toThrow();
  });
});
