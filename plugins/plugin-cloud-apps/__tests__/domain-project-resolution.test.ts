/**
 * Proves app-scoped domain reads cross Cloud only through a real local Project
 * binding, including explicit, active, sole, ambiguous, and unbound outcomes.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ElizaCloudClient } from "@elizaos/cloud-sdk";
import {
  FakeElizaCloudClient,
  installTestProjectRegistry,
  makeApp,
  makeMessage,
  resetSdk,
  setGetApp,
  type TestProjectRegistry,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { resolveDomainTargetProject } = await import("../src/domain-intent.ts");

const HABIT_APP = makeApp({
  id: "00000000-0000-0000-0000-000000000001",
  name: "Habit Cloud Record",
  slug: "habit-cloud-record",
});
const MEAL_APP = makeApp({
  id: "00000000-0000-0000-0000-000000000002",
  name: "Meal Cloud Record",
  slug: "meal-cloud-record",
});

let registry: TestProjectRegistry;
let getAppCalls: string[];
const client = new FakeElizaCloudClient() as unknown as ElizaCloudClient;

function installProjects(
  entries: Array<{ name: string; cloudAppId?: string }>,
  activeIndex?: number | null,
): void {
  registry?.cleanup();
  registry = installTestProjectRegistry(entries, { activeIndex });
}

beforeEach(() => {
  resetSdk();
  getAppCalls = [];
  setGetApp((id) => {
    getAppCalls.push(id);
    return Promise.resolve({
      success: true,
      app: id === MEAL_APP.id ? MEAL_APP : HABIT_APP,
    });
  });
  installProjects([{ name: "Habit Tracker", cloudAppId: HABIT_APP.id }]);
});

afterEach(() => registry.cleanup());

describe("resolveDomainTargetProject", () => {
  it("uses an explicit Project even when another Project is active", async () => {
    installProjects(
      [
        { name: "Habit Tracker", cloudAppId: HABIT_APP.id },
        { name: "Meal Planner", cloudAppId: MEAL_APP.id },
      ],
      1,
    );

    const target = await resolveDomainTargetProject(
      client,
      makeMessage("show the domain"),
      { parameters: { project: "Habit Tracker" } },
    );

    expect(target.project?.name).toBe("Habit Tracker");
    expect(target.app?.id).toBe(HABIT_APP.id);
    expect(getAppCalls).toEqual([HABIT_APP.id]);
  });

  it("uses the active Project, then the sole Project, when none is explicit", async () => {
    installProjects(
      [
        { name: "Habit Tracker", cloudAppId: HABIT_APP.id },
        { name: "Meal Planner", cloudAppId: MEAL_APP.id },
      ],
      1,
    );
    const active = await resolveDomainTargetProject(
      client,
      makeMessage("show domain status"),
    );
    expect(active.project?.name).toBe("Meal Planner");
    expect(active.app?.id).toBe(MEAL_APP.id);

    installProjects([{ name: "Habit Tracker", cloudAppId: HABIT_APP.id }]);
    const sole = await resolveDomainTargetProject(
      client,
      makeMessage("show domain status"),
    );
    expect(sole.project?.name).toBe("Habit Tracker");
    expect(sole.app?.id).toBe(HABIT_APP.id);
  });

  it("keeps legacy appName and bound Cloud id inputs project-scoped", async () => {
    installProjects([
      { name: "Habit Tracker", cloudAppId: HABIT_APP.id },
      { name: "Meal Planner", cloudAppId: MEAL_APP.id },
    ]);

    const byLegacyName = await resolveDomainTargetProject(
      client,
      makeMessage("show the domain"),
      { parameters: { appName: "Meal Planner" } },
    );
    const byBoundId = await resolveDomainTargetProject(
      client,
      makeMessage("show the domain"),
      { appId: HABIT_APP.id },
    );

    expect(byLegacyName.project?.name).toBe("Meal Planner");
    expect(byLegacyName.app?.id).toBe(MEAL_APP.id);
    expect(byBoundId.project?.name).toBe("Habit Tracker");
    expect(byBoundId.app?.id).toBe(HABIT_APP.id);
  });

  it("refuses ambiguous Project names without calling Cloud", async () => {
    installProjects([
      {
        name: "Shared Project",
        cloudAppId: HABIT_APP.id,
      },
      {
        name: "Shared Project",
        cloudAppId: MEAL_APP.id,
      },
    ]);

    const target = await resolveDomainTargetProject(
      client,
      makeMessage("show the domain"),
      { project: "Shared Project" },
    );

    expect(target.project).toBeNull();
    expect(target.app).toBeNull();
    expect(target.reason).toBe("ambiguous");
    expect(target.resolution.candidates).toHaveLength(2);
    expect(getAppCalls).toEqual([]);
  });

  it("reports an unbound Project without borrowing a Cloud app", async () => {
    installProjects([{ name: "Local Draft" }]);

    const target = await resolveDomainTargetProject(
      client,
      makeMessage("show domain status"),
    );

    expect(target.project?.name).toBe("Local Draft");
    expect(target.app).toBeNull();
    expect(target.reason).toBe("not_published");
    expect(getAppCalls).toEqual([]);
  });
});
