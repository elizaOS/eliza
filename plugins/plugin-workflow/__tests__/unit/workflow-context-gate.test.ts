/**
 * #8913 — verify the WORKFLOW action's chat-context gating.
 *
 * The issue asked that the WORKFLOW action be reachable from an ordinary
 * chat/Telegram turn (which seeds the `general` context) while staying gated out
 * of unrelated contexts. #9014 implemented this by declaring
 * `contexts/contextGate = ['general','automation','tasks','agent_internal']`
 * (the `chat` literal in the issue text is an inert alias; a plain chat turn
 * actually seeds `general`). That correctness argument previously lived only in
 * code comments + the PR body — no test exercised the gate itself. This locks it
 * in by evaluating the action's real `contextGate` through core's
 * `satisfiesContextGate` (the same predicate the planner uses to admit an
 * action).
 */

import { describe, expect, test } from 'bun:test';
import { satisfiesContextGate } from '@elizaos/core';
import { workflowAction } from '../../src/actions/workflow';

describe('WORKFLOW context gating (#8913)', () => {
  const gate = workflowAction.contextGate;
  const ALLOWED = ['general', 'automation', 'tasks', 'agent_internal'] as const;

  test('declares the intended allow-set on both contexts and contextGate', () => {
    expect(gate).toBeDefined();
    expect(workflowAction.contexts).toEqual(expect.arrayContaining([...ALLOWED]));
    expect(gate?.anyOf).toEqual(expect.arrayContaining([...ALLOWED]));
  });

  test('fires under "general" — the context a plain chat/Telegram turn seeds', () => {
    expect(satisfiesContextGate(['general'], gate)).toBe(true);
  });

  test('fires under every allowed context', () => {
    for (const ctx of ALLOWED) {
      expect(satisfiesContextGate([ctx], gate)).toBe(true);
    }
  });

  test('is gated OUT of contexts outside the allow-set', () => {
    expect(satisfiesContextGate(['contacts'], gate)).toBe(false);
    expect(satisfiesContextGate(['settings'], gate)).toBe(false);
    expect(satisfiesContextGate(['admin'], gate)).toBe(false);
  });

  test('does not fire when no context is active', () => {
    expect(satisfiesContextGate([], gate)).toBe(false);
    expect(satisfiesContextGate(undefined, gate)).toBe(false);
  });
});
