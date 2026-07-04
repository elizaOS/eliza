/**
 * Guards that each `LIFEOPS_OPTIMIZED_PROMPT_TASKS` entry declared in core has a
 * real consumer referenced in the source tree (static source scan), catching
 * orphaned optimization tasks.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIFEOPS_OPTIMIZED_PROMPT_TASKS } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const EXPECTED_CONSUMERS = {
  calendar_extract: "plugins/plugin-calendar/src/actions/calendar-handler.ts",
  schedule_plan:
    "plugins/plugin-personal-assistant/src/actions/lib/scheduling-handler.ts",
  reminder_dispatch:
    "plugins/plugin-personal-assistant/src/lifeops/domains/reminders-service.ts",
  inbox_triage: "plugins/plugin-inbox/src/inbox/triage-classifier.ts",
  meeting_prep: "plugins/plugin-personal-assistant/src/actions/brief.ts",
  morning_brief: "plugins/plugin-personal-assistant/src/actions/brief.ts",
  health_checkin: "plugins/plugin-health/src/actions/health.ts",
  screentime_recap: "plugins/plugin-health/src/actions/screen-time.ts",
} as const;

function resolverSnippetFor(source: string, task: string): string | null {
  const literal = `"${task}"`;
  let index = source.indexOf("resolveOptimizedPromptForRuntime");
  while (index !== -1) {
    const snippet = source.slice(index, index + 600);
    if (snippet.includes(literal)) {
      return snippet;
    }
    index = source.indexOf("resolveOptimizedPromptForRuntime", index + 1);
  }
  return null;
}

describe("LifeOps optimized prompt consumers", () => {
  it("keeps every declared LifeOps task wired to its production runtime prompt", () => {
    expect(Object.keys(EXPECTED_CONSUMERS).sort()).toEqual(
      [...LIFEOPS_OPTIMIZED_PROMPT_TASKS].sort(),
    );

    for (const task of LIFEOPS_OPTIMIZED_PROMPT_TASKS) {
      const relativePath =
        EXPECTED_CONSUMERS[task as keyof typeof EXPECTED_CONSUMERS];
      const source = readFileSync(join(repoRoot, relativePath), "utf8");
      const snippet = resolverSnippetFor(source, task);

      expect(snippet, `${task} must be consumed in ${relativePath}`).toContain(
        `"${task}"`,
      );
    }
  });
});
