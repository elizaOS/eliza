import { describe, expect, test } from 'bun:test';
import { GameGenerator } from '@feed/engine';
import type { Organization, Question, Scenario } from '@feed/shared';

type TestableGameGenerator = {
  llm: {
    generateJSON: () => Promise<unknown>;
  };
  generateQuestions: (
    scenarios: Scenario[],
    organizations: Organization[]
  ) => Promise<Question[]>;
};

function asTestableGameGenerator(
  generator: GameGenerator
): TestableGameGenerator {
  return generator as unknown as TestableGameGenerator;
}

function buildGeneratorWithQuestionsResponse(
  response: unknown
): TestableGameGenerator {
  const generator = asTestableGameGenerator(new GameGenerator('test-key'));
  generator.llm = {
    generateJSON: async () => response,
  };

  return generator;
}

function buildScenarios(): Scenario[] {
  return [
    {
      id: 1,
      title: 'Scenario One',
      description: 'The first scenario',
      mainActors: ['actor-1'],
      involvedOrganizations: ['org-1'],
      theme: 'market structure',
    },
    {
      id: 2,
      title: 'Scenario Two',
      description: 'The second scenario',
      mainActors: ['actor-2'],
      involvedOrganizations: ['org-2'],
      theme: 'narrative shift',
    },
  ];
}

function buildOrganizations(): Organization[] {
  return [
    {
      id: 'org-1',
      name: 'Org One',
      description: 'The first organization',
      type: 'company',
      canBeInvolved: true,
    },
    {
      id: 'org-2',
      name: 'Org Two',
      description: 'The second organization',
      type: 'media',
      canBeInvolved: true,
    },
  ];
}

describe('GameGenerator question normalization', () => {
  test('derives scenario ids from grouped question responses', async () => {
    const generator = buildGeneratorWithQuestionsResponse([
      {
        questions: [
          {
            text: 'Will scenario one resolve positively?',
            questionNumber: '1',
          },
        ],
      },
      {
        questions: [
          {
            text: 'Will scenario two resolve positively?',
            questionNumber: 2,
          },
        ],
      },
    ]);

    const questions = await generator.generateQuestions(
      buildScenarios(),
      buildOrganizations()
    );

    expect(questions).toHaveLength(2);
    expect(questions[0]?.scenario).toBe(1);
    expect(questions[0]?.scenarioId).toBe(1);
    expect(questions[0]?.questionNumber).toBe(1);
    expect(questions[1]?.scenario).toBe(2);
    expect(questions[1]?.scenarioId).toBe(2);
    expect(questions[1]?.questionNumber).toBe(2);
  });

  test('rejects questions that do not identify a scenario', async () => {
    const generator = buildGeneratorWithQuestionsResponse({
      questions: [
        {
          text: 'This question omitted a scenario reference',
          questionNumber: 1,
        },
      ],
    });

    await expect(
      generator.generateQuestions(buildScenarios(), buildOrganizations())
    ).rejects.toThrow(/without scenario/);
  });

  test('rejects questions that reference scenarios outside the generated set', async () => {
    const generator = buildGeneratorWithQuestionsResponse({
      questions: [
        {
          text: 'This question points at a missing scenario',
          scenario: 3,
          questionNumber: 1,
        },
      ],
    });

    await expect(
      generator.generateQuestions(buildScenarios(), buildOrganizations())
    ).rejects.toThrow(/outside range 1-2/);
  });
});
