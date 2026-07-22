/**
 * Verifies the CodeQL workflow's action phases share one immutable release and
 * proves the contract rejects the cross-version state that breaks analysis.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertCodeqlActionVersions } from "../codeql-action-version-contract";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WORKFLOW_PATH = `${REPOSITORY_ROOT}/.github/workflows/codeql.yml`;

test("all CodeQL action phases use one immutable release", () => {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");
  expect(assertCodeqlActionVersions(workflow)).toMatch(/^[0-9a-f]{40}$/);
});

test("cross-version CodeQL phases fail the contract", () => {
  const workflow = `
    - uses: github/codeql-action/init@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    - uses: github/codeql-action/analyze@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  `;
  expect(() => assertCodeqlActionVersions(workflow)).toThrow(
    "CodeQL action phases must use one release",
  );
});

test("floating CodeQL action tags fail the contract", () => {
  const workflow = `
    - uses: github/codeql-action/init@v4
    - uses: github/codeql-action/analyze@v4
  `;
  expect(() => assertCodeqlActionVersions(workflow)).toThrow(
    "must use an immutable 40-character commit SHA",
  );
});
