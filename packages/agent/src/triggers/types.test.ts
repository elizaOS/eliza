/**
 * Behavioral coverage for triggers/types.ts: its only runtime export is the
 * TRIGGER_SCHEMA_VERSION re-export from @elizaos/core, so this suite pins that
 * re-export to the canonical core binding and proves no type-only name leaks
 * into the runtime surface. Drives the real module — no mocks, deterministic.
 */

import { TRIGGER_SCHEMA_VERSION } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { TRIGGER_SCHEMA_VERSION as reexportedSchemaVersion } from "./types.ts";

/** Every export of triggers/types.ts that exists only at compile time. */
const TYPE_ONLY_EXPORT_NAMES = [
  "CreateTriggerRequest",
  "NormalizedTriggerDraft",
  "PromptTriggerConfig",
  "TriggerConfig",
  "TriggerHealthSnapshot",
  "TriggerKind",
  "TriggerLastStatus",
  "TriggerRunRecord",
  "TriggerSummary",
  "TriggerTaskMetadata",
  "TriggerType",
  "TriggerWakeMode",
  "UpdateTriggerRequest",
  "WorkflowTriggerConfig",
] as const;

describe("triggers/types runtime surface", () => {
  it("re-exports TRIGGER_SCHEMA_VERSION identical to the canonical @elizaos/core binding", () => {
    expect(typeof reexportedSchemaVersion).toBe("number");
    expect(reexportedSchemaVersion).toBe(TRIGGER_SCHEMA_VERSION);
  });

  it("exposes TRIGGER_SCHEMA_VERSION and no type-only name at runtime", async () => {
    const mod = await import("./types.ts");
    expect(Object.keys(mod)).toContain("TRIGGER_SCHEMA_VERSION");
    for (const name of TYPE_ONLY_EXPORT_NAMES) {
      expect(
        mod,
        `type-only export "${name}" must not exist at runtime`,
      ).not.toHaveProperty(name);
    }
  });
});
