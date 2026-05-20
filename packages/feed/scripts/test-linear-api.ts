#!/usr/bin/env bun
/**
 * Manual test: bun run scripts/test-linear-api.ts
 * Requires LINEAR_API_KEY and LINEAR_TEAM_ID in .env
 */

import { existsSync, readFileSync } from "node:fs";

// Load env files
for (const file of [".env", ".env.test", ".env.local"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (key && rest.length && !process.env[key]) {
      process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
    }
  }
}

import {
  createLinearIssue,
  getLinearConfig,
} from "../packages/api/src/linear/client";
import { formatFeedbackForLinear } from "../packages/api/src/linear/format-feedback";

const config = getLinearConfig();
if (!config) {
  console.error("LINEAR_API_KEY or LINEAR_TEAM_ID not set");
  process.exit(1);
}

console.log("Config:", {
  teamId: config.teamId,
  apiKey: `${config.apiKey.substring(0, 12)}...`,
});

const formatted = formatFeedbackForLinear({
  id: `test-${Date.now()}`,
  feedbackType: "bug",
  description: "[TEST - DELETE] Linear API verification",
  stepsToReproduce: "1. Run script\n2. Verify issue\n3. Delete",
  userId: "test",
  userEmail: "test@example.com",
});

const issue = await createLinearIssue(config.apiKey, {
  teamId: config.teamId,
  title: formatted.title,
  description: formatted.description,
  labelIds: config.gameFeedbackLabelId
    ? [config.gameFeedbackLabelId]
    : undefined,
});

console.log("Created:", issue.identifier, issue.url);
