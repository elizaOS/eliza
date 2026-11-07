/**
 * The owner's display name comes from the configured `ui.ownerName` unless the
 * owner profile stores a name of its own. Saving any other profile field (an
 * owner fact such as a location) must not copy the default "admin" or the
 * then-configured name into the stored profile, or that copy shadows every
 * later Settings rename. Real task storage and PGlite read-back; the config
 * read goes through owner-profile's `/api/config` fallback.
 */
import type { AgentRuntime } from "@elizaos/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { resolveOwnerFactStore } from "./owner/fact-store.js";
import {
  readLifeOpsOwnerProfile,
  updateLifeOpsOwnerProfile,
} from "./owner-profile.js";
import { LIFEOPS_TASK_TAGS } from "./scheduler-task.js";

describe("owner profile name — configured owner name stays live", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let configuredOwnerName: string | null;

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
  }, 180_000);

  beforeEach(async () => {
    configuredOwnerName = null;
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        input instanceof Request ? input.url : new URL(String(input)).href;
      if (new URL(url).pathname !== "/api/config") {
        return realFetch(input, init);
      }
      return Response.json(
        configuredOwnerName ? { ui: { ownerName: configuredOwnerName } } : {},
      );
    });

    const tasks = await runtime.getTasks({ tags: [...LIFEOPS_TASK_TAGS] });
    for (const task of tasks) {
      if (!task.id || !task.metadata?.ownerProfile) continue;
      const { ownerProfile: _ownerProfile, ...metadata } = task.metadata;
      await runtime.updateTask(task.id, { metadata });
    }
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => runtimeResult?.cleanup());

  async function storedOwnerProfile(): Promise<Record<string, unknown>> {
    const tasks = await runtime.getTasks({ tags: [...LIFEOPS_TASK_TAGS] });
    const stored = tasks.find((task) => task.metadata?.ownerProfile)?.metadata
      ?.ownerProfile;
    if (!stored || typeof stored !== "object") {
      throw new Error("Owner profile must be persisted");
    }
    return stored as Record<string, unknown>;
  }

  it("shows a name set in Settings after an owner location fact was saved", async () => {
    await resolveOwnerFactStore(runtime).update(
      { location: "Berlin" },
      { source: "agent_inferred", recordedAt: new Date().toISOString() },
    );

    configuredOwnerName = "Ethan";
    const profile = await readLifeOpsOwnerProfile(runtime);

    expect(profile.name).toBe("Ethan");
    expect(profile.location).toBe("Berlin");
    const stored = await storedOwnerProfile();
    expect(stored).toMatchObject({ location: "Berlin" });
    expect(stored).not.toHaveProperty("name");
    expect(stored).not.toHaveProperty("relationshipStatus");
  });

  it("follows a Settings rename after another field was saved under the old name", async () => {
    configuredOwnerName = "Ethan";
    const updated = await updateLifeOpsOwnerProfile(runtime, {
      location: "Berlin",
    });
    expect(updated).toMatchObject({
      name: "Ethan",
      location: "Berlin",
      relationshipStatus: "n/a",
    });

    configuredOwnerName = "Sam";
    expect((await readLifeOpsOwnerProfile(runtime)).name).toBe("Sam");
  });

  it("keeps a name the owner profile stores over the configured name", async () => {
    configuredOwnerName = "Ethan";
    await updateLifeOpsOwnerProfile(runtime, { name: "Sam" });
    await updateLifeOpsOwnerProfile(runtime, { location: "Berlin" });

    expect(await readLifeOpsOwnerProfile(runtime)).toMatchObject({
      name: "Sam",
      location: "Berlin",
    });
    expect(await storedOwnerProfile()).toMatchObject({
      name: "Sam",
      location: "Berlin",
    });
  });
});
