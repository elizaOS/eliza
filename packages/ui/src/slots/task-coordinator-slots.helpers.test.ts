/**
 * Covers the task-coordinator slot registry: the live
 * `registeredTaskCoordinatorSlots` object and the merge semantics of
 * `registerTaskCoordinatorSlots` that app plugins call at boot and
 * `task-coordinator-slots.tsx` reads at render time. Runs the real module in
 * the node environment with a fresh ESM instance per case via vi.resetModules;
 * no DOM and no mocks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Helpers = typeof import("./task-coordinator-slots.helpers");

async function loadHelpers(): Promise<Helpers> {
  return import("./task-coordinator-slots.helpers");
}

function fakeComponent(): null {
  return null;
}

beforeEach(() => {
  vi.resetModules();
});

describe("registerTaskCoordinatorSlots", () => {
  it("exposes an empty registry before any registration", async () => {
    const { registeredTaskCoordinatorSlots } = await loadHelpers();

    expect(Object.keys(registeredTaskCoordinatorSlots)).toEqual([]);
  });

  it("stores a provided component on the registry under its slot key", async () => {
    const { registerTaskCoordinatorSlots, registeredTaskCoordinatorSlots } =
      await loadHelpers();

    registerTaskCoordinatorSlots({ CodingAgentControlChip: fakeComponent });

    expect(registeredTaskCoordinatorSlots.CodingAgentControlChip).toBe(
      fakeComponent,
    );
  });

  it("leaves slots not included in a partial registration unset", async () => {
    const { registerTaskCoordinatorSlots, registeredTaskCoordinatorSlots } =
      await loadHelpers();

    registerTaskCoordinatorSlots({ CodingAgentControlChip: fakeComponent });

    expect(
      registeredTaskCoordinatorSlots.CodingAgentTasksPanel,
    ).toBeUndefined();
    expect(registeredTaskCoordinatorSlots.PtyConsoleBase).toBeUndefined();
    expect(Object.keys(registeredTaskCoordinatorSlots)).toEqual([
      "CodingAgentControlChip",
    ]);
  });

  it("merges later registrations without dropping earlier slots", async () => {
    const { registerTaskCoordinatorSlots, registeredTaskCoordinatorSlots } =
      await loadHelpers();
    const panel = (): null => null;

    registerTaskCoordinatorSlots({ CodingAgentTasksPanel: fakeComponent });
    registerTaskCoordinatorSlots({ PtyConsoleBase: panel });

    expect(registeredTaskCoordinatorSlots.CodingAgentTasksPanel).toBe(
      fakeComponent,
    );
    expect(registeredTaskCoordinatorSlots.PtyConsoleBase).toBe(panel);
  });

  it("replaces a slot when the same key is registered again", async () => {
    const { registerTaskCoordinatorSlots, registeredTaskCoordinatorSlots } =
      await loadHelpers();
    const replacement = (): null => null;

    registerTaskCoordinatorSlots({
      CodingAgentSettingsSection: fakeComponent,
    });
    registerTaskCoordinatorSlots({
      CodingAgentSettingsSection: replacement,
    });

    expect(registeredTaskCoordinatorSlots.CodingAgentSettingsSection).toBe(
      replacement,
    );
    expect(Object.keys(registeredTaskCoordinatorSlots)).toHaveLength(1);
  });

  it("keeps the registry identity stable so earlier readers observe new slots", async () => {
    const helpers = await loadHelpers();
    const liveView = helpers.registeredTaskCoordinatorSlots;

    helpers.registerTaskCoordinatorSlots({
      CodingAgentControlChip: fakeComponent,
    });

    expect(helpers.registeredTaskCoordinatorSlots).toBe(liveView);
    expect(liveView.CodingAgentControlChip).toBe(fakeComponent);
  });

  it("treats an empty registration as a no-op", async () => {
    const { registerTaskCoordinatorSlots, registeredTaskCoordinatorSlots } =
      await loadHelpers();

    registerTaskCoordinatorSlots({});

    expect(Object.keys(registeredTaskCoordinatorSlots)).toEqual([]);
  });

  it("accepts all four coordinator slots in a single call", async () => {
    const { registerTaskCoordinatorSlots, registeredTaskCoordinatorSlots } =
      await loadHelpers();

    registerTaskCoordinatorSlots({
      CodingAgentSettingsSection: fakeComponent,
      CodingAgentTasksPanel: fakeComponent,
      CodingAgentControlChip: fakeComponent,
      PtyConsoleBase: fakeComponent,
    });

    expect(registeredTaskCoordinatorSlots.CodingAgentSettingsSection).toBe(
      fakeComponent,
    );
    expect(registeredTaskCoordinatorSlots.CodingAgentTasksPanel).toBe(
      fakeComponent,
    );
    expect(registeredTaskCoordinatorSlots.CodingAgentControlChip).toBe(
      fakeComponent,
    );
    expect(registeredTaskCoordinatorSlots.PtyConsoleBase).toBe(fakeComponent);
  });
});
