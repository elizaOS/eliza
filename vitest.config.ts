/**
 * Root Vitest configuration for workspace tests that run directly against source.
 *
 * The aliases point package imports at their TypeScript entry points so targeted
 * package tests can execute without first building every workspace.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.git/**",
      // Tool worktrees are root containers; same-named nested paths remain tests.
      ".worktrees/**",
      ".audit-worktrees/**",
      ".codex-worktrees/**",
      ".codex-pr-worktrees/**",
      ".codex-agent-worktrees/**",
      "**/.claude/**",
      "**/.eliza/**",
      "**/.tmp/**",
      "**/tmp/**",
      "**/*.e2e.test.{ts,tsx}",
      "**/*.e2e.spec.{ts,tsx}",
      "**/*.live.test.{ts,tsx}",
      "**/*.live.e2e.test.{ts,tsx}",
      "**/*.real.test.{ts,tsx}",
      "**/*.real.e2e.test.{ts,tsx}",
    ],
  },
  resolve: {
    alias: [],
  },
});
