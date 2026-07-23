/**
 * Ensures OS release validation provisions its static-smoke dependency on
 * unprivileged Linux runners before executing the Linux metadata gate.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WORKFLOW_PATH = `${REPOSITORY_ROOT}/.github/workflows/elizaos-os-release.yml`;

test("OS release validation installs a checksum-verified ripgrep first", () => {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");
  const provisionIndex = workflow.indexOf(
    "- name: Provision ripgrep for Linux metadata validation",
  );
  const validationIndex = workflow.indexOf(
    "- name: Validate Linux live USB metadata",
  );
  const dollar = "$";

  expect(provisionIndex).toBeGreaterThan(0);
  expect(validationIndex).toBeGreaterThan(provisionIndex);
  expect(workflow).toContain("version=15.1.0");
  expect(workflow).toContain("X64) target=x86_64-unknown-linux-musl");
  expect(workflow).toContain("ARM64) target=aarch64-unknown-linux-gnu");
  expect(workflow).toContain(`sha256sum --check "${dollar}{archive}.sha256"`);
  expect(workflow).toContain(
    `echo "${dollar}{bin_dir}" >> "${dollar}{GITHUB_PATH}"`,
  );
});
