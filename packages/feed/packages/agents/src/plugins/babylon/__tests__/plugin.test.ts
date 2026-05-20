import { describe, expect, test } from 'bun:test';
import { babylonPlugin } from '../index';

describe('babylonPlugin social context wiring', () => {
  test('exports the shared chat context providers and evaluator', () => {
    const providerNames =
      babylonPlugin.providers?.map((provider) => provider.name) ?? [];
    const evaluatorNames =
      babylonPlugin.evaluators?.map((evaluator) => evaluator.name) ?? [];

    expect(providerNames).toContain('SHARED_CHAT_FACTS');
    expect(providerNames).toContain('RECENT_RELEVANT_GROUP_CONTEXT');
    expect(providerNames).toContain('LIVE_PLAYER_ROSTER');
    expect(evaluatorNames).toContain('SHARED_CHAT_CONTEXT_EVALUATOR');
  });
});
