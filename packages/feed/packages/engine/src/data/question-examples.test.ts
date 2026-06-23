import { describe, expect, it } from 'vitest';
import { getQuestionExamples } from './question-examples';

describe('getQuestionExamples', () => {
  it('returns only well-formed question examples', () => {
    const examples = getQuestionExamples();

    expect(examples.length).toBeGreaterThan(0);
    expect(examples.every((line) => line.startsWith('Will '))).toBe(true);
    expect(examples.every((line) => line.endsWith('?'))).toBe(true);
  });

  it('filters out section headings and malformed lines', () => {
    const examples = getQuestionExamples();

    expect(examples).not.toContain('Crypto Degeneracy & Financial Absurdity');
    expect(
      examples.some((line) =>
        line.includes(
          'Will AIlon Musk successfully land a SpAIceX rocket on the roof of the MetAI headquarters as a "friendly prank"'
        )
      )
    ).toBe(true);
    expect(
      examples.some((line) =>
        line.includes(
          `Will Mark Zuckerborg's challenge to a "Metaverse Deathmatch" actually be accepted by Sim Cook`
        )
      )
    ).toBe(true);
  });
});
