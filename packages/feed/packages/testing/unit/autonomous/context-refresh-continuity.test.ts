import { describe, expect, mock, test } from 'bun:test';

const _actualEngine = await import('@feed/engine');

async function loadTemplateHelpers() {
  mock.module('@feed/engine', () => ({
    ..._actualEngine,
    NPC_POST_QUALITY_RULES: '',
  }));

  return import('../../../agents/src/autonomous/templates/multi-step-decision');
}

function createBaseContext(featuresTrading: string) {
  return {
    balance: 1000,
    pnl: 120,
    openPositions: 0,
    pendingCommentReplies: [],
    pendingChatMessages: [],
    enabledFeatures: [featuresTrading],
    predictionMarkets: [],
    perpMarkets: [],
    recentPosts: [],
    agentPositions: {
      predictions: [],
      perps: [],
    },
  };
}

describe('MultiStep Prompt Context Refresh Continuity', () => {
  test('includes continuity section when context refresh summary exists', async () => {
    const { Features, buildMultiStepDecisionPrompt } =
      await loadTemplateHelpers();

    const { prompt } = buildMultiStepDecisionPrompt({
      agentName: 'Agent Test',
      iterationCount: 1,
      maxIterations: 5,
      traceActionResults: [],
      context: {
        ...createBaseContext(Features.TRADING),
        contextRefreshSummary:
          'Runtime refreshed after 48h. Keep trading thesis continuity.',
      },
      shareTradeRoll: 0.9,
    });

    expect(prompt).toContain('# Continuity Notes (Previous Runtime)');
    expect(prompt).toContain(
      'Runtime refreshed after 48h. Keep trading thesis continuity.'
    );
  });

  test('omits continuity section when no refresh summary is present', async () => {
    const { Features, buildMultiStepDecisionPrompt } =
      await loadTemplateHelpers();

    const { prompt } = buildMultiStepDecisionPrompt({
      agentName: 'Agent Test',
      iterationCount: 1,
      maxIterations: 5,
      traceActionResults: [],
      context: createBaseContext(Features.TRADING),
      shareTradeRoll: 0.9,
    });

    expect(prompt).not.toContain('# Continuity Notes (Previous Runtime)');
  });
});
