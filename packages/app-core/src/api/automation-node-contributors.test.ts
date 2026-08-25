/**
 * Drives the app-core `automation-node-contributors` re-export against the real
 * shared singleton. Covers contributor registration (empty/whitespace ids,
 * trim, overwrite, insertion order, list copy, clear) and
 * `buildRuntimeCapabilityNodes` gating (empty specs, missing actions/plugins,
 * action name + simile + plugin matches, case/whitespace normalization, and
 * `enabledWithoutRuntimeCapability`). No mocks.
 */
import type { AgentRuntime } from "@elizaos/core";
import {
  buildRuntimeCapabilityNodes as sharedBuild,
  clearAutomationNodeContributorsForTests as sharedClear,
  listAutomationNodeContributors as sharedList,
  registerAutomationNodeContributor as sharedRegister,
} from "@elizaos/shared/automation-node-contributors";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AutomationNodeContributor,
  buildRuntimeCapabilityNodes,
  clearAutomationNodeContributorsForTests,
  listAutomationNodeContributors,
  type RuntimeCapabilityNodeSpec,
  registerAutomationNodeContributor,
} from "./automation-node-contributors.ts";

const REQUIRED_ID_ERROR = "Automation node contributor id is required";

function spec(
  overrides: {
    id?: string;
    label?: string;
    description?: string;
    class?: RuntimeCapabilityNodeSpec["class"];
    backingCapability?: string;
    actionNames?: string[];
    pluginNames?: string[];
    ownerScoped?: boolean;
    enabledWithoutRuntimeCapability?: boolean;
    disabledReason?: string;
  } = {},
): RuntimeCapabilityNodeSpec {
  return {
    id: overrides.id ?? "node.one",
    label: overrides.label ?? "Node One",
    description: overrides.description ?? "A catalog node",
    class: overrides.class ?? "action",
    backingCapability: overrides.backingCapability ?? "cap.one",
    actionNames: overrides.actionNames ?? [],
    pluginNames: overrides.pluginNames ?? [],
    ownerScoped: overrides.ownerScoped ?? false,
    enabledWithoutRuntimeCapability:
      overrides.enabledWithoutRuntimeCapability ?? false,
    disabledReason: overrides.disabledReason ?? "capability missing",
  };
}

function runtime(
  overrides: {
    actions?: Array<{ name: string; similes?: string[] }>;
    plugins?: Array<{ name: string }>;
  } = {},
): AgentRuntime {
  return overrides as AgentRuntime;
}

const emptyContributor: AutomationNodeContributor = () => [];
const otherContributor: AutomationNodeContributor = () => [];
const thirdContributor: AutomationNodeContributor = () => [];

describe("app-core automation-node-contributors re-export", () => {
  beforeEach(() => {
    clearAutomationNodeContributorsForTests();
  });

  afterEach(() => {
    clearAutomationNodeContributorsForTests();
  });

  it("re-exports the same function identities as @elizaos/shared", () => {
    expect(buildRuntimeCapabilityNodes).toBe(sharedBuild);
    expect(registerAutomationNodeContributor).toBe(sharedRegister);
    expect(listAutomationNodeContributors).toBe(sharedList);
    expect(clearAutomationNodeContributorsForTests).toBe(sharedClear);
  });

  it("shares the contributor Map across the app-core and shared import paths", () => {
    registerAutomationNodeContributor("wallet", emptyContributor);
    expect(sharedList()).toEqual([emptyContributor]);

    sharedRegister("lifeops", otherContributor);
    expect(listAutomationNodeContributors()).toEqual([
      emptyContributor,
      otherContributor,
    ]);
  });
});

describe("registerAutomationNodeContributor / listAutomationNodeContributors", () => {
  beforeEach(() => {
    clearAutomationNodeContributorsForTests();
  });

  afterEach(() => {
    clearAutomationNodeContributorsForTests();
  });

  it("lists an empty queue after a clear, including a clear of an already empty map", () => {
    expect(listAutomationNodeContributors()).toEqual([]);
    clearAutomationNodeContributorsForTests();
    expect(listAutomationNodeContributors()).toEqual([]);
  });

  it("lists a single registered contributor", () => {
    registerAutomationNodeContributor("wallet", emptyContributor);
    expect(listAutomationNodeContributors()).toEqual([emptyContributor]);
  });

  it("lists contributors in Map insertion order", () => {
    registerAutomationNodeContributor("wallet", emptyContributor);
    registerAutomationNodeContributor("lifeops", otherContributor);
    registerAutomationNodeContributor("coding", thirdContributor);
    expect(listAutomationNodeContributors()).toEqual([
      emptyContributor,
      otherContributor,
      thirdContributor,
    ]);
  });

  it("rejects an empty id", () => {
    expect(() =>
      registerAutomationNodeContributor("", emptyContributor),
    ).toThrow(REQUIRED_ID_ERROR);
    expect(listAutomationNodeContributors()).toEqual([]);
  });

  it("rejects a whitespace-only id after trim", () => {
    expect(() =>
      registerAutomationNodeContributor(" \t\n ", emptyContributor),
    ).toThrow(REQUIRED_ID_ERROR);
    expect(listAutomationNodeContributors()).toEqual([]);
  });

  it("trims contributor ids so padded and bare ids collide as one Map key", () => {
    registerAutomationNodeContributor("  wallet  ", emptyContributor);
    registerAutomationNodeContributor("wallet", otherContributor);
    expect(listAutomationNodeContributors()).toEqual([otherContributor]);
  });

  it("overwrites the contributor for an existing id without changing insertion position", () => {
    registerAutomationNodeContributor("wallet", emptyContributor);
    registerAutomationNodeContributor("lifeops", otherContributor);
    registerAutomationNodeContributor("wallet", thirdContributor);
    expect(listAutomationNodeContributors()).toEqual([
      thirdContributor,
      otherContributor,
    ]);
  });

  it("returns a shallow copy so mutating the listed array does not change the registry", () => {
    registerAutomationNodeContributor("wallet", emptyContributor);
    const listed = listAutomationNodeContributors();
    listed.pop();
    listed.push(otherContributor);
    expect(listAutomationNodeContributors()).toEqual([emptyContributor]);
  });

  it("does not surface an unregistered id", () => {
    registerAutomationNodeContributor("wallet", emptyContributor);
    expect(listAutomationNodeContributors()).not.toContain(otherContributor);
    expect(listAutomationNodeContributors()).toHaveLength(1);
  });
});

describe("buildRuntimeCapabilityNodes", () => {
  it("returns an empty array for an empty spec list", () => {
    expect(buildRuntimeCapabilityNodes([], runtime())).toEqual([]);
  });

  it("disables a gated spec when the runtime has no actions or plugins", () => {
    expect(
      buildRuntimeCapabilityNodes(
        [
          spec({
            actionNames: ["SWAP_EVM"],
            pluginNames: ["wallet"],
            disabledReason: "Load the wallet plugin.",
          }),
        ],
        runtime(),
      ),
    ).toEqual([
      {
        id: "node.one",
        label: "Node One",
        description: "A catalog node",
        class: "action",
        source: "static_catalog",
        backingCapability: "cap.one",
        ownerScoped: false,
        requiresSetup: true,
        availability: "disabled",
        disabledReason: "Load the wallet plugin.",
      },
    ]);
  });

  it("treats missing runtime.actions and runtime.plugins as empty lists", () => {
    const nodes = buildRuntimeCapabilityNodes(
      [spec({ actionNames: ["SWAP"], pluginNames: ["wallet"] })],
      {} as AgentRuntime,
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.availability).toBe("disabled");
    expect(nodes[0]?.requiresSetup).toBe(true);
  });

  it("enables a spec whose action name matches, case-insensitively, and omits disabledReason", () => {
    const nodes = buildRuntimeCapabilityNodes(
      [spec({ actionNames: ["swap_evm"], pluginNames: ["wallet"] })],
      runtime({ actions: [{ name: "SWAP_EVM" }] }),
    );
    expect(nodes).toEqual([
      {
        id: "node.one",
        label: "Node One",
        description: "A catalog node",
        class: "action",
        source: "static_catalog",
        backingCapability: "cap.one",
        ownerScoped: false,
        requiresSetup: false,
        availability: "enabled",
      },
    ]);
    expect(nodes[0]?.disabledReason).toBeUndefined();
  });

  it("enables a spec when a simile matches after trim and lowercase", () => {
    const nodes = buildRuntimeCapabilityNodes(
      [spec({ actionNames: ["  Swap_Evm  "] })],
      runtime({
        actions: [{ name: "OTHER", similes: [" SWAP_EVM "] }],
      }),
    );
    expect(nodes[0]?.availability).toBe("enabled");
    expect(nodes[0]?.requiresSetup).toBe(false);
  });

  it("enables a spec when a plugin name matches after trim and lowercase", () => {
    const nodes = buildRuntimeCapabilityNodes(
      [spec({ pluginNames: [" Wallet "] })],
      runtime({ plugins: [{ name: "WALLET" }] }),
    );
    expect(nodes[0]?.availability).toBe("enabled");
  });

  it("enables when either the action list or the plugin list matches", () => {
    const byAction = buildRuntimeCapabilityNodes(
      [spec({ actionNames: ["SWAP"], pluginNames: ["wallet"] })],
      runtime({ actions: [{ name: "swap" }] }),
    );
    const byPlugin = buildRuntimeCapabilityNodes(
      [spec({ actionNames: ["SWAP"], pluginNames: ["wallet"] })],
      runtime({ plugins: [{ name: "wallet" }] }),
    );
    expect(byAction[0]?.availability).toBe("enabled");
    expect(byPlugin[0]?.availability).toBe("enabled");
  });

  it("does not match an empty normalized plugin name because those names are dropped", () => {
    const nodes = buildRuntimeCapabilityNodes(
      [spec({ pluginNames: ["   "] })],
      runtime({ plugins: [{ name: "   " }, { name: "" }] }),
    );
    expect(nodes[0]?.availability).toBe("disabled");
  });

  it("does match an empty normalized action name because action names are not filtered", () => {
    const nodes = buildRuntimeCapabilityNodes(
      [spec({ actionNames: ["  "] })],
      runtime({ actions: [{ name: "   " }] }),
    );
    expect(nodes[0]?.availability).toBe("enabled");
  });

  it("enables every spec that sets enabledWithoutRuntimeCapability even with empty queues", () => {
    const nodes = buildRuntimeCapabilityNodes(
      [
        spec({
          id: "always.on",
          enabledWithoutRuntimeCapability: true,
          actionNames: ["MISSING"],
          pluginNames: ["missing"],
        }),
      ],
      runtime(),
    );
    expect(nodes[0]?.availability).toBe("enabled");
    expect(nodes[0]?.requiresSetup).toBe(false);
    expect(nodes[0]?.disabledReason).toBeUndefined();
  });

  it("preserves spec order and mixed availability across several nodes", () => {
    const nodes = buildRuntimeCapabilityNodes(
      [
        spec({
          id: "disabled.one",
          label: "Disabled",
          class: "trigger",
          ownerScoped: true,
          actionNames: ["MISSING"],
        }),
        spec({
          id: "enabled.one",
          label: "Enabled",
          class: "agent",
          actionNames: ["TASKS"],
        }),
      ],
      runtime({ actions: [{ name: "tasks" }] }),
    );
    expect(nodes.map((node) => node.id)).toEqual([
      "disabled.one",
      "enabled.one",
    ]);
    expect(nodes[0]?.availability).toBe("disabled");
    expect(nodes[0]?.ownerScoped).toBe(true);
    expect(nodes[0]?.class).toBe("trigger");
    expect(nodes[1]?.availability).toBe("enabled");
    expect(nodes[1]?.class).toBe("agent");
  });

  it("copies label, description, backingCapability, and source through unchanged", () => {
    const nodes = buildRuntimeCapabilityNodes(
      [
        spec({
          id: "crypto:evm.swap",
          label: "EVM Swap",
          description: "Swap on EVM",
          backingCapability: "wallet.evm.swap",
          class: "integration",
        }),
      ],
      runtime(),
    );
    expect(nodes[0]).toMatchObject({
      id: "crypto:evm.swap",
      label: "EVM Swap",
      description: "Swap on EVM",
      class: "integration",
      source: "static_catalog",
      backingCapability: "wallet.evm.swap",
    });
  });
});
