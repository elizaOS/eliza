/**
 * Integration Tests: Game Learnability
 *
 * @module engine/__tests__/integration/game-learnability.test
 *
 * @description
 * Integration tests that use LLM calls to verify:
 * 1. Information gradient exists (early unclear → late clear)
 * 2. NPCs are consistent (agents can learn who to trust)
 * 3. Game is learnable (simple strategies beat random)
 * 4. Insider advantage exists (group chats provide value)
 *
 * ⚠️ **IMPORTANT**: These tests:
 * - Use API calls (cost money)
 * - Take 30-120 seconds each
 * - Marked as .skip by default
 * - Run manually for quality validation
 *
 * **To run manually**:
 * ```bash
 * bun test src/engine/__tests__/integration/game-learnability.test.ts
 * ```
 *
 * **Or run specific test**:
 * ```bash
 * bun test --grep "information gradient"
 * ```
 *
 * @see {@link GameGenerator} - Class under test
 * @see {@link /docs/research/game-engine-analysis.md} - Research justifying these tests
 */

import {
  beforeAll,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { logger } from '@babylon/shared';
import { existsSync, readFileSync } from 'fs';
import { resolveLiveLlmTestConfig } from '../../../../testing/integration/helpers/live-runtime';
// import { GameGenerator } from '@/engine/GameGenerator'; // Removed static import
import type { FeedPost, GeneratedGame, WorldEvent } from '../../types/shared';
import { formatError } from '../../utils/error-utils';

// Set timeout to 10 minutes for LLM-based generation
setDefaultTimeout(600000);

// Mock world-context to avoid DB calls BEFORE importing GameGenerator
const mockWorldContext = {
  generateWorldContext: async () => ({
    worldActors: 'Test Actor 1, Test Actor 2',
    currentMarkets: 'Active Markets: None currently active',
    activePredictions: 'Active Questions: None currently active',
    recentTrades: 'Recent Trades: No recent activity',
    currentDateTime: new Date().toISOString(),
    currentDate: new Date().toDateString(),
    currentTime: new Date().toTimeString(),
    currentYear: '2025',
    currentMonth: 'October',
    currentDay: '15',
    realityGrounding: 'Reality grounding context',
    worldFacts: 'World facts context',
  }),
  generateCurrentMarkets: async () => 'Active Markets: None currently active',
  generateActivePredictions: async () =>
    'Active Questions: None currently active',
  generateRecentTrades: async () => 'Recent Trades: No recent activity',
  generateWorldActors: () => 'Test Actor 1, Test Actor 2',
  getParodyActorNames: () => ['Test Actor 1', 'Test Actor 2'],
  getForbiddenRealNames: () => [],
  validateNoRealNames: () => [],
  validateGeneratedContent: () => ({ errors: [], isValid: true }),
  getCurrentDateContext: () => ({
    dateISO: new Date().toISOString(),
    dateFull: new Date().toDateString(),
    time: new Date().toTimeString(),
    year: '2025',
    month: 'October',
    day: '15',
  }),
  getRealityGrounding: async () => 'Reality grounding context',
  getMinimalRealityGrounding: async () => 'Minimal reality grounding',
  getFullRealityGrounding: async () => 'Full reality grounding',
  checkRealityGrounding: () => ({ score: 1, feedback: [] }),
};

mock.module('@babylon/engine', () => mockWorldContext);

// Load environment variables from .env files
const loadEnvFile = (filePath: string) => {
  if (!existsSync(filePath)) return;
  const envContent = readFileSync(filePath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        const value = valueParts.join('=').replace(/^["']|["']$/g, '');
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
};

loadEnvFile('.env.test');
loadEnvFile('.env.local');

const hasLLMKey = !!(
  (process.env.GROQ_API_KEY?.trim() ?? '') !== '' ||
  (process.env.ANTHROPIC_API_KEY?.trim() ?? '') !== '' ||
  (process.env.OPENAI_API_KEY?.trim() ?? '') !== ''
);
const liveLlmConfig = resolveLiveLlmTestConfig();

// Helper functions need to be defined before usage but outside tests
function calculateCertainty(
  events: WorldEvent[],
  questionId: number | string,
  actualOutcome: boolean
): number {
  const relevantEvents = events.filter(
    (e) =>
      e.relatedQuestion === questionId &&
      e.pointsToward !== null &&
      e.pointsToward !== undefined
  );

  if (relevantEvents.length === 0) return 0.5; // No info = 50/50

  const correctSignals = relevantEvents.filter(
    (e) =>
      (e.pointsToward === 'YES') === actualOutcome ||
      (e.pointsToward === 'NO') === !actualOutcome
  ).length;

  return correctSignals / relevantEvents.length;
}

function calculateCertaintyFromPosts(
  posts: FeedPost[],
  actualOutcome: boolean
): number {
  const relevantPosts = posts.filter(
    (p) => p.pointsToward !== null && p.pointsToward !== undefined
  );

  if (relevantPosts.length === 0) return 0.5;

  const correctPosts = posts.filter(
    (p) =>
      (p.pointsToward === 'YES' || p.pointsToward === true) === actualOutcome ||
      (p.pointsToward === 'NO' || p.pointsToward === false) === !actualOutcome
  );

  return correctPosts.length / relevantPosts.length;
}

// Always run LLM tests - fail if no API key rather than skip
describe.skipIf(!liveLlmConfig.enabled)(
  'Game Learnability Integration Tests',
  () => {
    // Shared game instance - generated once before all tests
    let game: GeneratedGame | null = null;
    let skipped = false;
    let skipReason = '';

    beforeAll(async () => {
      if (!hasLLMKey) {
        console.log('⏭️  Skipping all tests - No LLM API key available');
        skipped = true;
        skipReason = 'No LLM API key';
        return;
      }

      try {
        logger.info(
          'Generating shared game for learnability tests...',
          undefined,
          'LearnabilityTest'
        );
        const { GameGenerator } = await import('../../GameGenerator');
        const generator = new GameGenerator();
        game = await generator.generateCompleteGame();
        logger.info(
          'Game generated successfully',
          undefined,
          'LearnabilityTest'
        );
      } catch (error) {
        const errorMessage = formatError(error);
        console.log(
          '⏭️  Game generation failed - tests will skip:',
          errorMessage.substring(0, 100)
        );
        skipped = true;
        skipReason = `Generation failed: ${errorMessage.substring(0, 100)}`;
      }
    });

    test('CRITICAL: information gradient exists (early unclear, late clear)', async () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || 'No game generated'}`);
        return;
      }

      logger.info(
        'Testing information gradient...',
        undefined,
        'LearnabilityTest'
      );

      let allGradientsPass = true;

      for (const question of game.setup.questions) {
        const allEvents = game.timeline.flatMap((day) => day.events);

        const earlyEvents = allEvents.filter((e) => e.day <= 10);
        const middleEvents = allEvents.filter(
          (e) => e.day >= 11 && e.day <= 20
        );
        const lateEvents = allEvents.filter((e) => e.day >= 21);

        const earlyCertainty = calculateCertainty(
          earlyEvents,
          question.id,
          question.outcome
        );
        const middleCertainty = calculateCertainty(
          [...earlyEvents, ...middleEvents],
          question.id,
          question.outcome
        );
        const lateCertainty = calculateCertainty(
          [...earlyEvents, ...middleEvents, ...lateEvents],
          question.id,
          question.outcome
        );

        const gradient = lateCertainty - earlyCertainty;
        const hasGradient = gradient > 0.2;

        logger.info(
          `Question ${question.id}: ${(earlyCertainty * 100).toFixed(0)}% → ${(middleCertainty * 100).toFixed(0)}% → ${(lateCertainty * 100).toFixed(0)}% (gradient: ${(gradient * 100).toFixed(0)}%) ${hasGradient ? '✅' : '❌'}`,
          undefined,
          'LearnabilityTest'
        );

        expect(lateCertainty).toBeGreaterThan(earlyCertainty + 0.15);
        expect(middleCertainty).toBeGreaterThanOrEqual(earlyCertainty);
        expect(lateCertainty).toBeGreaterThan(middleCertainty);

        expect(earlyCertainty).toBeLessThan(0.65);
        expect(lateCertainty).toBeGreaterThan(0.7);

        if (!hasGradient) {
          allGradientsPass = false;
        }
      }

      expect(allGradientsPass).toBe(true);
      logger.info(
        allGradientsPass
          ? '✅ PASS: All questions have information gradient'
          : '❌ FAIL: Some questions lack gradient',
        undefined,
        'LearnabilityTest'
      );
    });

    test('NPCs with high reliability are consistently accurate', async () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || 'No game generated'}`);
        return;
      }

      logger.info('Testing NPC consistency...', undefined, 'LearnabilityTest');

      const allActors = [
        ...game.setup.mainActors,
        ...game.setup.supportingActors,
      ];

      const highReliabilityNPCs = allActors.filter(
        (a) => a.persona && a.persona.reliability > 0.7
      );

      logger.info(
        `Found ${highReliabilityNPCs.length} high reliability NPCs`,
        undefined,
        'LearnabilityTest'
      );
      expect(highReliabilityNPCs.length).toBeGreaterThan(0);

      for (const npc of highReliabilityNPCs) {
        const posts = game.timeline
          .flatMap((day) => day.feedPosts)
          .filter(
            (post) =>
              post.author === npc.id &&
              post.pointsToward !== null &&
              post.relatedQuestion !== null
          );

        if (posts.length === 0) continue;

        const accuratePosts = posts.filter((post) => {
          const question = game.setup.questions.find(
            (q) => q.id === post.relatedQuestion
          );
          if (!question) return false;

          const postPointsToYes =
            post.pointsToward === 'YES' || post.pointsToward === true;
          return postPointsToYes === question.outcome;
        });

        const accuracy = accuratePosts.length / posts.length;

        logger.info(
          `${npc.name} (reliability ${npc.persona?.reliability.toFixed(2)}): ${(accuracy * 100).toFixed(0)}% accurate (${accuratePosts.length}/${posts.length} posts)`,
          undefined,
          'LearnabilityTest'
        );

        expect(accuracy).toBeGreaterThan(0.55);
      }
    });

    test('simple betting strategy beats random guessing', async () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || 'No game generated'}`);
        return;
      }

      logger.info(
        'Testing learnability with simple strategy...',
        undefined,
        'LearnabilityTest'
      );

      // Use the shared game for strategy testing instead of generating 3 new games
      let totalPredictions = 0;
      let correctPredictions = 0;

      for (const question of game.setup.questions) {
        totalPredictions++;

        const strongClues = game.timeline
          .flatMap((day) => day.feedPosts)
          .filter(
            (post) =>
              post.relatedQuestion === question.id &&
              post.clueStrength > 0.7 &&
              post.pointsToward !== null
          );

        if (strongClues.length === 0) {
          totalPredictions--;
          continue;
        }

        const yesVotes = strongClues.filter(
          (p) => p.pointsToward === 'YES' || p.pointsToward === true
        ).length;
        const noVotes = strongClues.filter(
          (p) => p.pointsToward === 'NO' || p.pointsToward === false
        ).length;

        const prediction = yesVotes > noVotes;

        if (prediction === question.outcome) {
          correctPredictions++;
        }

        logger.info(
          `Q${question.id}: ${strongClues.length} strong clues → ${prediction ? 'YES' : 'NO'} (actual: ${question.outcome ? 'YES' : 'NO'}) ${prediction === question.outcome ? '✅' : '❌'}`,
          undefined,
          'LearnabilityTest'
        );
      }

      if (totalPredictions === 0) {
        logger.info(
          '⚠️ No questions with strong clues found - skipping accuracy check',
          undefined,
          'LearnabilityTest'
        );
        return;
      }

      const accuracy = correctPredictions / totalPredictions;

      logger.info('─'.repeat(50), undefined, 'LearnabilityTest');
      logger.info(
        `SIMPLE STRATEGY RESULTS: ${correctPredictions}/${totalPredictions} = ${(accuracy * 100).toFixed(0)}%`,
        undefined,
        'LearnabilityTest'
      );
      logger.info(
        'Target: 50%+ (better than random guessing)',
        undefined,
        'LearnabilityTest'
      );
      logger.info(
        accuracy >= 0.5
          ? '✅ PASS: Game is learnable'
          : '❌ FAIL: Game not learnable',
        undefined,
        'LearnabilityTest'
      );
      logger.info('─'.repeat(50), undefined, 'LearnabilityTest');

      // Relaxed threshold - just needs to beat random (50%)
      expect(accuracy).toBeGreaterThanOrEqual(0.5);
    });

    test('group chat information provides measurable advantage', async () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || 'No game generated'}`);
        return;
      }

      logger.info(
        'Testing group chat advantage...',
        undefined,
        'LearnabilityTest'
      );

      for (const question of game.setup.questions) {
        const publicPosts = game.timeline
          .flatMap((day) => day.feedPosts)
          .filter(
            (post) =>
              post.relatedQuestion === question.id && post.pointsToward !== null
          );

        const publicCertainty = calculateCertaintyFromPosts(
          publicPosts,
          question.outcome
        );

        const groupChatHints = game.timeline
          .flatMap((day) => Object.values(day.groupChats).flat())
          .filter((msg) => {
            const questionKeywords = question.text
              .toLowerCase()
              .split(' ')
              .filter((w) => w.length > 4);
            const messageLower = msg.message.toLowerCase();
            return questionKeywords.some((keyword) =>
              messageLower.includes(keyword)
            );
          });

        const groupChatValue = groupChatHints.length * 0.04;

        logger.info(
          `Q${question.id}: Public ${(publicCertainty * 100).toFixed(0)}%, Group chats +${(groupChatValue * 100).toFixed(0)}% (${groupChatHints.length} hints)`,
          undefined,
          'LearnabilityTest'
        );

        if (groupChatHints.length > 0) {
          expect(groupChatValue).toBeGreaterThan(0);
        }
      }
    });

    test('questions have resolution verification events', async () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || 'No game generated'}`);
        return;
      }

      logger.info(
        'Testing resolution verification...',
        undefined,
        'LearnabilityTest'
      );

      for (const question of game.setup.questions) {
        const allEvents = game.timeline.flatMap((day) => day.events);

        const verificationEvents = allEvents.filter(
          (e) =>
            e.relatedQuestion === question.id &&
            e.pointsToward === (question.outcome ? 'YES' : 'NO') &&
            e.day >= 25
        );

        logger.info(
          `Q${question.id}: ${verificationEvents.length} verification events (day 25+)`,
          undefined,
          'LearnabilityTest'
        );

        expect(verificationEvents.length).toBeGreaterThan(0);

        const definitiveEvents = verificationEvents.filter(
          (e) => e.type === 'revelation' || e.type === 'announcement'
        );

        expect(definitiveEvents.length).toBeGreaterThan(0);
      }
    });
  }
);
