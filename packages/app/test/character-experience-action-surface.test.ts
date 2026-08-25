/**
 * Static guard for the Character Experience view→action contract: the renderer's
 * update/delete controls must have a registered semantic EXPERIENCE action twin.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");

function readRepoFiles(files: readonly string[]): string {
  const missing = files.filter(
    (file) => !existsSync(path.join(REPO_ROOT, file)),
  );
  expect(missing, "owner files must exist").toEqual([]);
  return files
    .map((file) => readFileSync(path.join(REPO_ROOT, file), "utf8"))
    .join("\n");
}

describe("Character Experience action surface", () => {
  it("keeps view update/delete mutations backed by the EXPERIENCE action", () => {
    const source = readRepoFiles([
      "packages/ui/src/components/character/CharacterExperienceView.tsx",
      "packages/ui/src/components/character/CharacterExperienceWorkspace.tsx",
      "packages/core/src/features/advanced-capabilities/experience/actions/manage-experience.ts",
      "packages/core/src/features/advanced-capabilities/index.ts",
    ]);

    expect(source).toContain("client.updateExperience(");
    expect(source).toContain("client.deleteExperience(");
    expect(source).toContain('const EXPERIENCE = "EXPERIENCE"');
    expect(source).toContain("name: EXPERIENCE");
    expect(source).toContain("withCanonicalActionDocs(manageExperienceAction)");
  });
});
