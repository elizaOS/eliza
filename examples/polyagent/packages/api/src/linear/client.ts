/**
 * Linear GraphQL API client for creating issues from feedback.
 */

import { logger } from "@polyagent/shared";
import { GraphQLClient } from "graphql-request";

const LINEAR_API_URL = "https://api.linear.app/graphql";
const TIMEOUT_MS = 10_000;

const CREATE_ISSUE_MUTATION = `
  mutation CreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id, identifier, url }
    }
  }
`;

export interface LinearIssue {
  id: string;
  identifier: string;
  url: string;
}

export interface CreateIssueInput {
  teamId: string;
  title: string;
  description: string;
  labelIds?: string[];
}

interface CreateIssueResponse {
  issueCreate: { success: boolean; issue: LinearIssue };
}

export async function createLinearIssue(
  apiKey: string,
  input: CreateIssueInput,
): Promise<LinearIssue> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const client = new GraphQLClient(LINEAR_API_URL, {
    headers: {
      // Personal API keys (lin_api_*) don't use Bearer prefix
      // OAuth tokens would use: `Bearer ${token}`
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    signal: controller.signal,
  });

  const response = await client
    .request<CreateIssueResponse>(CREATE_ISSUE_MUTATION, { input })
    .finally(() => clearTimeout(timeoutId));

  if (!response.issueCreate.success) {
    throw new Error("Linear API returned success: false");
  }

  const { issue } = response.issueCreate;
  logger.info("Linear issue created", {
    id: issue.id,
    identifier: issue.identifier,
  });

  return issue;
}

/**
 * Get Linear configuration from environment variables.
 * Returns null if not configured or if credentials appear invalid.
 */
export function getLinearConfig(): {
  apiKey: string;
  teamId: string;
  gameFeedbackLabelId: string | null;
} | null {
  const apiKey = process.env.LINEAR_API_KEY;
  const teamId = process.env.LINEAR_TEAM_ID;
  if (!apiKey || !teamId) return null;

  // Validate API key format (Linear API keys start with "lin_api_")
  if (!apiKey.startsWith("lin_api_")) {
    logger.warn(
      'LINEAR_API_KEY appears invalid (should start with "lin_api_"). Linear integration disabled.',
    );
    return null;
  }

  return {
    apiKey,
    teamId,
    gameFeedbackLabelId: process.env.LINEAR_GAME_FEEDBACK_LABEL_ID ?? null,
  };
}
