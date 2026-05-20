/**
 * Tests for PFP generation CLI flag parsing and user-pfp prompt builder.
 *
 * We test pure logic units in isolation — no fal.ai calls, no file I/O.
 */

import { beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { parseFlagValue } from '../../../apps/cli/src/cli-utils';

// ─── parseFlagValue (cli-utils) ───────────────────────────────────────────────

describe('parseFlagValue', () => {
  it('returns undefined when flag is absent', () => {
    expect(parseFlagValue(['--force'], '--actor')).toBeUndefined();
  });

  it('returns undefined for empty args', () => {
    expect(parseFlagValue([], '--actor')).toBeUndefined();
  });

  it('returns the value following the flag', () => {
    expect(parseFlagValue(['--actor', 'ailon-musk'], '--actor')).toBe(
      'ailon-musk'
    );
  });

  it('returns the value when other flags are also present', () => {
    expect(
      parseFlagValue(['--force', '--actor', 'jeff-baizos'], '--actor')
    ).toBe('jeff-baizos');
  });

  it('returns the org value when both --actor and --org are provided', () => {
    expect(
      parseFlagValue(['--actor', 'ailon-musk', '--org', 'org-aix'], '--org')
    ).toBe('org-aix');
  });

  it('exits with code 1 when flag has no following value', () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(
      () => undefined as never
    );
    parseFlagValue(['--actor'], '--actor');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('exits with code 1 when next token is another flag', () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(
      () => undefined as never
    );
    parseFlagValue(['--actor', '--force'], '--actor');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

// ─── buildPrompt + array quality (generate-user-pfps.ts) ─────────────────────

describe('buildPrompt (user PFP preset generator)', () => {
  let buildPrompt: (
    subject: string,
    background: string,
    theme: string,
    style: string
  ) => string;
  let SUBJECTS: string[];
  let STYLES: string[];

  beforeAll(async () => {
    const mod = await import('../../../scripts/generate-user-pfps');
    buildPrompt = mod.buildPrompt;
    SUBJECTS = mod.SUBJECTS;
    STYLES = mod.STYLES;
  });

  it('produces a non-empty string', () => {
    const result = buildPrompt(
      'a fox',
      'a deep midnight blue',
      'elegant and regal',
      '3D Pixar render'
    );
    expect(result.length).toBeGreaterThan(20);
  });

  it('includes the subject in the output', () => {
    const result = buildPrompt(
      'a dragon',
      'outer space with nebulae',
      'cosmic and celestial',
      'oil painting'
    );
    expect(result).toContain('a dragon');
  });

  it('includes the style in the output', () => {
    const result = buildPrompt(
      'a lion',
      'a golden sunset gradient',
      'bold and powerful',
      'watercolor painting'
    );
    expect(result).toContain('watercolor painting');
  });

  it('includes the background in the output', () => {
    const result = buildPrompt(
      'a phoenix',
      'a field of wildflowers',
      'warm and inviting',
      'cel-shaded cartoon'
    );
    expect(result).toContain('a field of wildflowers');
  });

  it('includes no-text enforcement', () => {
    const result = buildPrompt(
      'a wolf',
      'a deep midnight blue',
      'mysterious and atmospheric',
      'digital concept art'
    );
    expect(result.toLowerCase()).toContain('no text');
    expect(result.toLowerCase()).toContain('no watermarks');
    expect(result.toLowerCase()).toContain('no logos');
  });

  it('specifies square crop and centered composition', () => {
    const result = buildPrompt(
      'an eagle',
      'a stark white minimalist backdrop',
      'crisp and modern',
      'vector flat design'
    );
    expect(result).toContain('square crop');
    expect(result.toLowerCase()).toContain('centered composition');
  });

  it('SUBJECTS array contains no cringe/meme entries', () => {
    const banned = ['skull', 'plague doctor', 'doge', 'distracted boyfriend'];
    for (const bad of banned) {
      const found = SUBJECTS.some((s) => s.toLowerCase().includes(bad));
      expect(found).toBe(false);
    }
  });

  it('STYLES array contains no dated/meme styles', () => {
    const banned = [
      'retro 8-bit',
      'glitch art static',
      'psychedelic and trippy',
    ];
    for (const bad of banned) {
      const found = STYLES.some((s) => s.toLowerCase().includes(bad));
      expect(found).toBe(false);
    }
  });

  it('SUBJECTS array is large enough for 150 unique combos', () => {
    expect(SUBJECTS.length).toBeGreaterThanOrEqual(40);
  });
});
