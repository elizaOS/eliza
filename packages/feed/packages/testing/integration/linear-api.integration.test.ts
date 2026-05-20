/**
 * Linear API integration test. Skipped by default.
 * Run with: LINEAR_TEST=true bun test packages/testing/integration/linear-api.integration.test.ts
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
  createLinearIssue,
  getLinearConfig,
} from '../../api/src/linear/client';
import { formatFeedbackForLinear } from '../../api/src/linear/format-feedback';

const SHOULD_RUN = process.env.LINEAR_TEST === 'true';

if (SHOULD_RUN) {
  describe('Linear API Integration', () => {
    let createdIssueId: string | null = null;
    const config = getLinearConfig();

    afterAll(() => {
      if (createdIssueId) {
        console.log(`Test issue: ${createdIssueId} - delete manually`);
      }
    });

    test('getLinearConfig returns valid config', () => {
      expect(config).not.toBeNull();
      expect(config?.apiKey).toMatch(/^lin_api_/);
      expect(config?.teamId).toMatch(/^[a-f0-9-]+$/);
    });

    test('createLinearIssue creates issue', async () => {
      expect(config).not.toBeNull();

      const formatted = formatFeedbackForLinear({
        id: 'test-' + Date.now(),
        feedbackType: 'bug',
        description: '[TEST - DELETE] Integration test',
        stepsToReproduce: '1. Run test\n2. Verify\n3. Delete',
        userId: 'test-user',
        userEmail: 'test@example.com',
      });

      const issue = await createLinearIssue(config!.apiKey, {
        teamId: config!.teamId,
        title: formatted.title,
        description: formatted.description,
        labelIds: config!.gameFeedbackLabelId
          ? [config!.gameFeedbackLabelId]
          : undefined,
      });

      createdIssueId = issue.identifier;
      expect(issue.id).toBeDefined();
      expect(issue.identifier).toMatch(/^BAB-\d+$/);
      expect(issue.url).toContain('linear.app');
    });

    test('createLinearIssue rejects invalid API key', async () => {
      await expect(
        createLinearIssue('lin_api_invalid', {
          teamId: 'fake',
          title: 'test',
          description: 'test',
        })
      ).rejects.toThrow();
    });

    test('createLinearIssue rejects invalid team ID', async () => {
      expect(config).not.toBeNull();
      await expect(
        createLinearIssue(config!.apiKey, {
          teamId: 'invalid',
          title: 'test',
          description: 'test',
        })
      ).rejects.toThrow();
    });
  });
}

describe('formatFeedbackForLinear', () => {
  test('bug report', () => {
    const result = formatFeedbackForLinear({
      id: 'fb-1',
      feedbackType: 'bug',
      description: 'App crashes',
      stepsToReproduce: '1. Click\n2. Crash',
      screenshotUrl: 'https://example.com/img.png',
      userId: 'u-1',
      userEmail: 'a@b.com',
    });
    expect(result.title).toStartWith('[🐛 Bug]');
    expect(result.description).toContain('## Bug Report');
    expect(result.description).toContain('Steps to Reproduce');
    expect(result.description).toContain('Screenshot');
  });

  test('feature request', () => {
    const result = formatFeedbackForLinear({
      id: 'fb-2',
      feedbackType: 'feature_request',
      description: 'Add dark mode',
      rating: 5,
      userId: 'u-2',
    });
    expect(result.title).toStartWith('[✨ Feature]');
    expect(result.description).toContain('⭐⭐⭐⭐⭐');
  });

  test('performance issue', () => {
    const result = formatFeedbackForLinear({
      id: 'fb-3',
      feedbackType: 'performance',
      description: 'Slow loading',
      userId: 'u-3',
    });
    expect(result.title).toStartWith('[⚡ Performance]');
  });
});
