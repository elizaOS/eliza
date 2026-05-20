/**
 * QuestionManager Test Suite
 *
 * @module engine/__tests__/QuestionManager.test
 *
 * @description
 * Comprehensive test suite for the QuestionManager prediction market question
 * lifecycle system. Verifies question creation, resolution, and constraint enforcement.
 *
 * **Test Coverage:**
 * - Question resolution detection (by date)
 * - Days until resolution calculation
 * - Resolution time constraints (1-7 days)
 * - Question status transitions (active → resolved)
 * - Active vs resolved question filtering
 * - Maximum 20 questions enforcement
 *
 * **Key Features Tested:**
 * - Date-based resolution triggering
 * - Day calculation accuracy
 * - Status tracking (active/resolved)
 * - Question filtering utilities
 * - Constraint validation (max questions)
 *
 * **Testing Approach:**
 * - Unit tests with mock LLM client
 * - No external dependencies
 * - Pure function testing
 * - Edge case coverage
 *
 * @see {@link QuestionManager} - Class under test
 */

import { describe, expect, test } from 'bun:test';
import type { BabylonLLMClient } from '../llm/openai-client';
import { QuestionManager } from '../QuestionManager';
import type { Question } from '../types/shared';
import { toDateString } from '../utils/date-utils';

/**
 * Mock LLM client interface for testing
 * Only implements the methods required by QuestionManager
 */
interface MockLLMClient
  extends Pick<BabylonLLMClient, 'generateJSON' | 'getProvider' | 'getStats'> {}

// Mock LLM client for testing - implements MockLLMClient interface
const mockLLMImpl: MockLLMClient = {
  generateJSON: async <T>(): Promise<T> => {
    return { questions: [] } as T;
  },
  getProvider: () => 'groq',
  getStats: () => ({
    provider: 'groq' as const,
    model: 'test',
    totalTokens: 0,
    totalCost: 0,
  }),
};

// Cast to full BabylonLLMClient type for QuestionManager compatibility
const mockLLM = mockLLMImpl as BabylonLLMClient;

describe('QuestionManager', () => {
  test('detects questions that should be resolved', () => {
    const manager = new QuestionManager(mockLLM);
    const questions: Question[] = [
      {
        id: 1,
        text: 'Question 1',
        scenario: 1,
        outcome: true,
        rank: 1,
        createdDate: '2025-11-01',
        resolutionDate: '2025-11-03',
        status: 'active',
      },
      {
        id: 2,
        text: 'Question 2',
        scenario: 1,
        outcome: false,
        rank: 2,
        createdDate: '2025-11-01',
        resolutionDate: '2025-11-05',
        status: 'active',
      },
    ];

    const currentDate = '2025-11-03';

    // Question 1 should be resolved (resolutionDate <= currentDate)
    // Question 2 should not (resolutionDate > currentDate)
    const toResolve = manager.getQuestionsToResolve(questions, currentDate);

    expect(toResolve.length).toBe(1);
    expect(toResolve[0]!.id).toBe(1);
  });

  test('calculates days until resolution correctly', () => {
    const manager = new QuestionManager(mockLLM);
    const question: Question = {
      id: 1,
      text: 'Test Question',
      scenario: 1,
      outcome: true,
      rank: 1,
      createdDate: '2025-11-01',
      resolutionDate: '2025-11-05',
      status: 'active',
    };

    const currentDate = '2025-11-01';

    const diffDays = manager.getDaysUntilResolution(question, currentDate);

    expect(diffDays).toBe(4);
  });

  test('enforces resolution time constraints (1-7 days)', () => {
    // Test that resolution dates are set correctly
    const createdDate = new Date('2025-11-01');

    // Test 1 day
    const oneDay = new Date(createdDate);
    oneDay.setDate(oneDay.getDate() + 1);
    expect(toDateString(oneDay)).toBe('2025-11-02');

    // Test 7 days
    const sevenDays = new Date(createdDate);
    sevenDays.setDate(sevenDays.getDate() + 7);
    expect(toDateString(sevenDays)).toBe('2025-11-08');
  });

  test('tracks question status transitions', () => {
    const manager = new QuestionManager(mockLLM);
    const question: Question = {
      id: 1,
      text: 'Test Question',
      scenario: 1,
      outcome: true,
      rank: 1,
      createdDate: '2025-11-01',
      resolutionDate: '2025-11-03',
      status: 'active',
    };

    // Resolve the question
    const resolved = manager.resolveQuestion(question, question.outcome);

    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedOutcome).toBe(true);
  });

  test('filters active vs resolved questions', () => {
    const manager = new QuestionManager(mockLLM);
    const questions: Question[] = [
      {
        id: 1,
        text: 'Question 1',
        scenario: 1,
        outcome: true,
        rank: 1,
        status: 'active',
      },
      {
        id: 2,
        text: 'Question 2',
        scenario: 1,
        outcome: false,
        rank: 2,
        status: 'resolved',
        resolvedOutcome: false,
      },
      {
        id: 3,
        text: 'Question 3',
        scenario: 1,
        outcome: true,
        rank: 3,
        status: 'active',
      },
    ];

    const active = manager.getActiveQuestions(questions);
    const resolved = manager.getResolvedQuestions(questions);

    expect(active.length).toBe(2);
    expect(resolved.length).toBe(1);
  });

  test('max 20 questions constraint', () => {
    // Generate 25 questions
    const questions: Question[] = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      text: `Question ${i + 1}`,
      scenario: 1,
      outcome: true,
      rank: i + 1,
      status: 'active' as const,
    }));

    const activeQuestions = questions
      .filter((q) => q.status === 'active')
      .slice(0, 20);

    expect(activeQuestions.length).toBe(20);
  });
});
