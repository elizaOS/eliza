import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadScenarios } from "../src/runner.ts";
import type { PersonalityScenario } from "../src/types.ts";

describe("runner scenario loading", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("loads dispatcher artifacts shaped as { scenario, trajectory }", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "personality-runner-"));
    const scenario: PersonalityScenario = {
      id: "wrapped-case",
      bucket: "hold_style",
      personalityExpect: {
        bucket: "hold_style",
        directiveTurn: 1,
        checkTurns: [2],
        options: { style: "terse" },
      },
      trajectory: [],
    };
    await writeFile(
      path.join(tempDir, "wrapped.json"),
      JSON.stringify({
        scenario,
        trajectory: [
          { role: "user", content: "Be terse." },
          { role: "assistant", content: "Ok." },
        ],
        agent: "agent-a",
      }),
      "utf8",
    );

    const loaded = await loadScenarios(tempDir);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      id: "wrapped-case",
      bucket: "hold_style",
      agent: "agent-a",
    });
    expect(loaded[0]?.trajectory).toHaveLength(2);
  });
});
