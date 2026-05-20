/**
 * Content Quality Gate Unit Tests
 *
 * Tests the write-side quality gate that validates content before DB insertion.
 * The gate runs structure + entity + grounding/coherence checks.
 *
 * Pure unit tests — no DB. Embedding-based grounding degrades gracefully
 * when OPENAI_API_KEY is absent, so these tests exercise the structural
 * and entity layers that run synchronously.
 */

import { describe, expect, test } from 'bun:test';
import { ContentQualityGate } from '@feed/engine';

describe('ContentQualityGate.validateParody', () => {
  test('grounded parody passes', async () => {
    const original = 'Tesla stock surges on record Q4 deliveries';
    const parody =
      'Teslaroid stock surges on record Q4 delivery drones becoming sentient';

    const result = await ContentQualityGate.validateParody(original, parody);
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThan(0);
    expect(result.reasons).toHaveLength(0);
  });

  test('verbatim copy fails structure check', async () => {
    const original = 'Apple announces iPhone 17 with new features';
    const parody = 'Apple announces iPhone 17 with new features';

    const result = await ContentQualityGate.validateParody(original, parody);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('Verbatim copy'))).toBe(true);
  });

  test('too-short parody fails structure check', async () => {
    const original = 'Major tech company launches new product line';
    const parody = 'Short';

    const result = await ContentQualityGate.validateParody(original, parody);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('Too short'))).toBe(true);
  });

  test('too-long parody fails structure check', async () => {
    const original = 'Brief headline';
    const parody = 'A'.repeat(600);

    const result = await ContentQualityGate.validateParody(original, parody);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('Too long'))).toBe(true);
  });

  test('parody with content body validates coherence of body too', async () => {
    const original = 'SpaceX launches Starship successfully';
    const parody = 'SpaceXYZ launches Starship into parallel dimension';
    const body =
      'The rocket disappeared into a portal, witnesses report. Scientists are baffled by the new physics involved.';

    const result = await ContentQualityGate.validateParody(
      original,
      parody,
      body
    );
    // Should run coherence check on body without crashing
    expect(typeof result.passed).toBe('boolean');
    expect(typeof result.score).toBe('number');
  });
});

describe('ContentQualityGate.validateWorldFact', () => {
  test('coherent fact without source passes', async () => {
    const fact =
      'The prediction markets are showing increased activity around upcoming product launches in the tech sector.';

    const result = await ContentQualityGate.validateWorldFact(fact);
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  test('grounded fact with source context passes', async () => {
    const fact =
      'The prediction market activity around AI regulation has increased after the government released a new framework for oversight.';
    const source =
      'Government released new AI regulation framework. Prediction market activity surges on the news. Increased interest in oversight policy.';

    const result = await ContentQualityGate.validateWorldFact(fact, source);
    expect(result.passed).toBe(true);
  });

  test('too-short fact fails structure check', async () => {
    const fact = 'Short fact.';

    const result = await ContentQualityGate.validateWorldFact(fact);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('Too short'))).toBe(true);
  });

  test('fact with many invented entities fails entity check', async () => {
    const fact =
      'John Fakerson and Clara Invented announced that the Bogus Foundation will partner with Hallucinated Corp to build something.';

    const result = await ContentQualityGate.validateWorldFact(fact);
    // Entity check should flag multiple unknown proper nouns
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('unknown entities'))).toBe(
      true
    );
  });
});

describe('ContentQualityGate.validateArticle', () => {
  test('grounded article passes', async () => {
    const article =
      'The recent announcement from OpenAGI about their new reasoning model has sent shockwaves through the tech industry. Analysts predict this could reshape the competitive landscape, as rivals scramble to match the breakthrough capabilities demonstrated in early benchmarks. Market observers note that this development aligns with the broader trend of accelerating AI advancement.';
    const source =
      'OpenAGI announces breakthrough reasoning model. Industry analysts react. Competitors respond to the news.';

    const result = await ContentQualityGate.validateArticle(article, source);
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  test('too-short article fails structure check', async () => {
    const article = 'This is too short to be an article.';
    const source = 'Some event happened in the tech world.';

    const result = await ContentQualityGate.validateArticle(article, source);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('Too short'))).toBe(true);
  });
});
