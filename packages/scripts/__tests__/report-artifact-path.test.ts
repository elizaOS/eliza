import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveReportArtifactPath } from "../lib/report-artifact-path.ts";

for (const directory of ["test-results", "reports"]) {
  test(`${directory} artifact paths remain inside their owned output tree`, () => {
    const root = mkdtempSync(path.join(tmpdir(), "report-boundary-"));
    const options = { extension: ".json", label: "--report" };
    try {
      const relative = `${directory}/script-tests/inventory.json`;
      expect(resolveReportArtifactPath(root, relative, options)).toEqual({
        relative,
        absolute: path.join(root, relative),
      });
      expect(() =>
        resolveReportArtifactPath(
          root,
          `${directory}/../package.json`,
          options,
        ),
      ).toThrow("traversal");
      mkdirSync(path.join(root, directory));
      symlinkSync(root, path.join(root, directory, "escape"), "junction");
      expect(() =>
        resolveReportArtifactPath(
          root,
          `${directory}/escape/package.json`,
          options,
        ),
      ).toThrow("symlinked parent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
