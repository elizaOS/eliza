import { describe, expect, test } from 'bun:test';
import type { ClarificationRequest } from '../../src/types';
import {
  CATALOG_CLARIFICATION_SUFFIX,
  coerceClarificationRequests,
  isCatalogClarification,
  isCatalogClarificationString,
} from '../../src/utils/clarification';

describe('coerceClarificationRequests', () => {
  test('returns empty array for nullish or empty input', () => {
    expect(coerceClarificationRequests(undefined)).toEqual([]);
    expect(coerceClarificationRequests(null)).toEqual([]);
    expect(coerceClarificationRequests([])).toEqual([]);
  });

  test('normalizes legacy strings to free_text ClarificationRequest', () => {
    const result = coerceClarificationRequests([
      'Which channel should I post to?',
      '   Trim me   ',
    ]);
    expect(result).toEqual([
      {
        kind: 'free_text',
        question: 'Which channel should I post to?',
        paramPath: '',
      },
      { kind: 'free_text', question: 'Trim me', paramPath: '' },
    ]);
  });

  test('drops empty/whitespace-only string entries', () => {
    expect(coerceClarificationRequests(['', '   ', 'real'])).toEqual([
      { kind: 'free_text', question: 'real', paramPath: '' },
    ]);
  });

  test('passes structured requests through unchanged in shape', () => {
    const input: ClarificationRequest = {
      kind: 'target_channel',
      platform: 'discord',
      scope: { guildId: '123' },
      question: 'Which channel in Cozy Devs?',
      paramPath: 'nodes["Discord Send"].parameters.channelId',
    };
    const result = coerceClarificationRequests([input]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(input);
  });

  test('handles mixed-shape arrays in a single pass', () => {
    const input: Array<string | ClarificationRequest> = [
      'Which server?',
      {
        kind: 'target_channel',
        platform: 'discord',
        question: 'Which channel?',
        paramPath: 'nodes[0].parameters.channelId',
      },
    ];
    const result = coerceClarificationRequests(input);
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe('free_text');
    expect(result[1].kind).toBe('target_channel');
    expect(result[1].paramPath).toBe('nodes[0].parameters.channelId');
  });

  test('defaults missing paramPath on structured input to empty string', () => {
    const result = coerceClarificationRequests([{ kind: 'value', question: 'How many?' }]);
    expect(result[0].paramPath).toBe('');
  });
});

describe('isCatalogClarification', () => {
  test('detects suffix on legacy string', () => {
    const flagged = `Channel "Slack Send" is missing channelId ${CATALOG_CLARIFICATION_SUFFIX}`;
    expect(isCatalogClarificationString(flagged)).toBe(true);
    expect(isCatalogClarification(flagged)).toBe(true);
  });

  test('detects suffix on structured ClarificationRequest question', () => {
    const flagged: ClarificationRequest = {
      kind: 'value',
      question: `Missing channelId ${CATALOG_CLARIFICATION_SUFFIX}`,
      paramPath: 'nodes[0].parameters.channelId',
    };
    expect(isCatalogClarification(flagged)).toBe(true);
  });

  test('does not match LLM-emitted clarifications without the suffix', () => {
    expect(isCatalogClarification('Which Discord server?')).toBe(false);
    expect(
      isCatalogClarification({
        kind: 'target_server',
        question: 'Which Discord server?',
        paramPath: 'nodes[0].parameters.guildId',
      })
    ).toBe(false);
  });
});
