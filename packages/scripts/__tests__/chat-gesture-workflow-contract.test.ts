/**
 * Keeps the chat gesture coverage step scoped to its named Vitest contract so
 * unrelated app script tests cannot prevent the browser gesture lane running.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const workflow = readFileSync(
  `${REPOSITORY_ROOT}/.github/workflows/chat-shell-gestures.yml`,
  "utf8",
);

test("chat gesture coverage invokes only its focused Vitest contract", () => {
  const step = workflow.match(
    /- name: Chat gesture coverage gate\n\s+run: ([^\n]+)/,
  );
  expect(step?.[1]).toBe(
    "bunx vitest run --config packages/app/vitest.config.ts packages/app/test/chat-gesture-coverage.test.ts",
  );
  expect(step?.[1]).not.toContain("bun run --cwd packages/app test");
});
