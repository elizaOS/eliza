/**
 * Covers the automation-catalog contributor registry and the runtime-capability
 * node builder.
 *
 * The builder's job is a gate: a node is offered as `enabled` only when the
 * runtime actually loaded a backing action or plugin, otherwise it is surfaced
 * as `disabled` with a reason and `requiresSetup`. Getting that backwards would
 * either hide working automations or advertise ones that cannot run, so the
 * enabled/disabled pairing and the case/whitespace-insensitive matching are
 * pinned directly.
 *
 * Pure functions over stub runtimes — no real AgentRuntime, no IO.
 */

import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRuntimeCapabilityNodes,
  clearAutomationNodeContributorsForTests,
  listAutomationNodeContributors,
  type RuntimeCapabilityNodeSpec,
  registerAutomationNodeContributor,
} from "./automation-node-contributors.js";

function runtime(
  actions: Array<{ name: string; similes?: string[] }> = [],
  plugins: Array<{ name: string }> = [],
): AgentRuntime {
  return { actions, plugins } as unknown as AgentRuntime;
}

function spec(
  overrides: Partial<RuntimeCapabilityNodeSpec> = {},
): RuntimeCapabilityNodeSpec {
  return {
    id: "node-1",
    label: "Node",
    description: "A node",
    class: "action" as RuntimeCapabilityNodeSpec["class"],
    backingCapability: "cap",
    actionNames: ["SEND_MESSAGE"],
    pluginNames: ["@elizaos/plugin-x"],
    ownerScoped: false,
    enabledWithoutRuntimeCapability: false,
    disabledReason: "install the plugin",
    ...overrides,
  };
}

beforeEach(() => clearAutomationNodeContributorsForTests());
afterEach(() => clearAutomationNodeContributorsForTests());

describe("registerAutomationNodeContributor", () => {
  it("registers and lists a contributor", () => {
    const contributor = () => [];
    registerAutomationNodeContributor("a", contributor);
    expect(listAutomationNodeContributors()).toEqual([contributor]);
  });

  it("rejects an empty or whitespace-only id", () => {
    expect(() => registerAutomationNodeContributor("", () => [])).toThrow();
    expect(() => registerAutomationNodeContributor("   ", () => [])).toThrow();
    expect(listAutomationNodeContributors()).toEqual([]);
  });

  it("treats ids as trimmed, so re-registering replaces rather than duplicates", () => {
    const first = () => [];
    const second = () => [];
    registerAutomationNodeContributor("dup", first);
    registerAutomationNodeContributor("  dup  ", second);
    expect(listAutomationNodeContributors()).toEqual([second]);
  });

  it("clears every registration", () => {
    registerAutomationNodeContributor("a", () => []);
    clearAutomationNodeContributorsForTests();
    expect(listAutomationNodeContributors()).toEqual([]);
  });
});

describe("buildRuntimeCapabilityNodes", () => {
  it("enables a node whose action is loaded", () => {
    const [node] = buildRuntimeCapabilityNodes(
      [spec()],
      runtime([{ name: "SEND_MESSAGE" }]),
    );
    expect(node).toMatchObject({
      availability: "enabled",
      requiresSetup: false,
      source: "static_catalog",
    });
    expect(node).not.toHaveProperty("disabledReason");
  });

  it("matches action names case-insensitively and ignoring surrounding whitespace", () => {
    const [node] = buildRuntimeCapabilityNodes(
      [spec({ actionNames: ["  send_message  "] })],
      runtime([{ name: "SEND_MESSAGE" }]),
    );
    expect(node?.availability).toBe("enabled");
  });

  it("enables via an action simile", () => {
    const [node] = buildRuntimeCapabilityNodes(
      [spec({ actionNames: ["REPLY"] })],
      runtime([{ name: "SEND_MESSAGE", similes: ["REPLY"] }]),
    );
    expect(node?.availability).toBe("enabled");
  });

  it("enables via a loaded plugin when no action matches", () => {
    const [node] = buildRuntimeCapabilityNodes(
      [spec({ actionNames: ["NOT_LOADED"] })],
      runtime([], [{ name: "@elizaos/plugin-x" }]),
    );
    expect(node?.availability).toBe("enabled");
  });

  it("disables a node with no backing capability and carries the reason", () => {
    const [node] = buildRuntimeCapabilityNodes([spec()], runtime());
    expect(node).toMatchObject({
      availability: "disabled",
      requiresSetup: true,
      disabledReason: "install the plugin",
    });
  });

  it("enables unconditionally when the spec opts out of the capability gate", () => {
    const [node] = buildRuntimeCapabilityNodes(
      [spec({ enabledWithoutRuntimeCapability: true })],
      runtime(),
    );
    expect(node?.availability).toBe("enabled");
    expect(node).not.toHaveProperty("disabledReason");
  });

  it("tolerates a runtime with no actions or plugins arrays", () => {
    const bare = {} as unknown as AgentRuntime;
    expect(() => buildRuntimeCapabilityNodes([spec()], bare)).not.toThrow();
    expect(buildRuntimeCapabilityNodes([spec()], bare)[0]?.availability).toBe(
      "disabled",
    );
  });

  it("ignores an unnamed plugin rather than matching an empty capability name", () => {
    const [node] = buildRuntimeCapabilityNodes(
      [spec({ actionNames: [], pluginNames: [""] })],
      runtime([], [{ name: "" }]),
    );
    expect(node?.availability).toBe("disabled");
  });

  it("carries declarative fields through and gates each spec independently", () => {
    const nodes = buildRuntimeCapabilityNodes(
      [
        spec({ id: "on", actionNames: ["LOADED"] }),
        spec({ id: "off", actionNames: ["MISSING"], pluginNames: [] }),
      ],
      runtime([{ name: "LOADED" }]),
    );
    expect(nodes.map((n) => [n.id, n.availability])).toEqual([
      ["on", "enabled"],
      ["off", "disabled"],
    ]);
    expect(nodes[0]).toMatchObject({
      label: "Node",
      description: "A node",
      backingCapability: "cap",
      ownerScoped: false,
    });
  });

  it("returns an empty list for no specs", () => {
    expect(buildRuntimeCapabilityNodes([], runtime())).toEqual([]);
  });
});
