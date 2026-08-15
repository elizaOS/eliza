/**
 * Deployment contract for the immutable Pages artifact and its precompiled
 * Functions worker, exercised without production credentials.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflow = readFileSync(
  join(import.meta.dir, "../../../.github/workflows/cloud-cf-release.yml"),
  "utf8",
);

describe("Pages deployment artifact", () => {
  test("compiles workspace imports before publishing the immutable artifact", () => {
    expect(workflow).toContain("Build self-contained Pages Functions bundle");
    expect(workflow).toContain(
      "bunx wrangler@4.100.0 pages functions build functions",
    );
    expect(workflow).toContain(
      'install -m 0644 "$functions_bundle/index.js" dist/_worker.js',
    );
    expect(workflow).toContain("node --check dist/_worker.js");
  });

  test("uploads and verifies the compiled worker instead of mutable function sources", () => {
    const uploadStart = workflow.indexOf(
      "- name: Upload consolidated frontend artifact",
    );
    const deployStart = workflow.indexOf("  deploy-app:", uploadStart);
    expect(uploadStart).toBeGreaterThan(-1);
    expect(deployStart).toBeGreaterThan(uploadStart);

    const artifactProducer = workflow.slice(uploadStart, deployStart);
    expect(artifactProducer).toContain("packages/app/dist");
    expect(artifactProducer).not.toContain("packages/app/functions");

    const artifactConsumer = workflow.slice(deployStart);
    expect(artifactConsumer).toContain(
      "Verify immutable Pages Functions bundle",
    );
    expect(artifactConsumer).toContain("test -s dist/_worker.js");
  });
});
