import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  lifeopsFeaturesTable,
  lifeOpsSchema,
  lifeScheduleMergedStates,
  lifeScheduleObservations,
} from "../src/lifeops/schema.js";

describe("life-ops plugin schema ownership", () => {
  it("wires the app-owned schema onto the plugin definition", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pluginSource = fs.readFileSync(
      path.resolve(here, "../src/plugin.ts"),
      "utf8",
    );
    expect(pluginSource).toContain("schema: lifeOpsSchema");
  });

  it("includes every migration-owned LifeOps table in the plugin schema", () => {
    expect(lifeOpsSchema.lifeopsFeaturesTable).toBe(lifeopsFeaturesTable);
    expect(lifeOpsSchema.lifeScheduleObservations).toBe(
      lifeScheduleObservations,
    );
    expect(lifeOpsSchema.lifeScheduleMergedStates).toBe(
      lifeScheduleMergedStates,
    );
  });
});
