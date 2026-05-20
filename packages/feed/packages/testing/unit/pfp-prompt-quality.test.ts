/**
 * PFP prompt quality tests
 *
 * Verifies that image generation prompts contain the structural elements
 * required for physical accuracy, style consistency, and no-text enforcement.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { actorPortrait } from '@babylon/engine';

// ─── Actor portrait prompt ────────────────────────────────────────────────────

describe('actorPortrait prompt template', () => {
  it('contains PHYSICAL ACCURACY enforcement section', () => {
    expect(actorPortrait.template).toContain('PHYSICAL ACCURACY');
  });

  it('instructs model to depict Black skin tone correctly', () => {
    expect(actorPortrait.template).toContain('MUST be visibly Black');
  });

  it('instructs model to depict bald heads correctly', () => {
    expect(actorPortrait.template).toContain('absolutely no hair, period');
  });

  it('instructs model to depict East Asian features correctly', () => {
    expect(actorPortrait.template).toContain('East Asian facial features');
  });

  it('instructs model to depict South Asian features correctly', () => {
    expect(actorPortrait.template).toContain(
      'South Asian features and skin tone'
    );
  });

  it('instructs model not to default to white/light-skinned', () => {
    expect(actorPortrait.template).toContain(
      'Do NOT default to white, light-skinned'
    );
  });

  it('instructs model to depict female subjects as female', () => {
    expect(actorPortrait.template).toContain(
      'Female subjects MUST look female'
    );
  });

  it('contains VISUAL DESCRIPTION placeholder', () => {
    expect(actorPortrait.template).toContain('{{pfpDescription}}');
  });

  it('contains actorName and realName placeholders', () => {
    expect(actorPortrait.template).toContain('{{actorName}}');
    expect(actorPortrait.template).toContain('{{realName}}');
  });

  it('instructs no text on image', () => {
    expect(actorPortrait.template).toContain('No text on image');
  });

  it('PHYSICAL ACCURACY block appears before EXAGGERATE section', () => {
    const physicalIdx = actorPortrait.template.indexOf('PHYSICAL ACCURACY');
    const exaggerateIdx = actorPortrait.template.indexOf('EXAGGERATE THE JOKE');
    expect(physicalIdx).toBeGreaterThan(-1);
    expect(exaggerateIdx).toBeGreaterThan(-1);
    expect(physicalIdx).toBeLessThan(exaggerateIdx);
  });

  it('PHYSICAL ACCURACY block appears after VISUAL DESCRIPTION', () => {
    const visualIdx = actorPortrait.template.indexOf('VISUAL DESCRIPTION');
    const physicalIdx = actorPortrait.template.indexOf('PHYSICAL ACCURACY');
    expect(visualIdx).toBeLessThan(physicalIdx);
  });
});

// ─── pfpDescription quality assertions ────────────────────────────────────────

describe('pfpDescription physical accuracy (audited actors)', () => {
  // These actors were the 7 flagged as missing race/hair — verify fixes are in place.
  // We import loadActorsData to access raw actor data.
  let actors: Array<{ id: string; pfpDescription?: string }>;

  beforeAll(async () => {
    const { loadActorsData } = await import('@babylon/engine');
    const db = loadActorsData() as {
      actors: Array<{ id: string; pfpDescription?: string }>;
    };
    actors = db.actors;
  });

  function getPfp(id: string): string {
    const actor = actors.find((a) => a.id === id);
    if (!actor?.pfpDescription) throw new Error(`Actor ${id} not found`);
    return actor.pfpDescription.toLowerCase();
  }

  it('spartain has explicit skin tone descriptor', () => {
    const desc = getPfp('spartain');
    const hasExplicitTone =
      desc.includes('olive') ||
      desc.includes('tan') ||
      desc.includes('mediterranean') ||
      desc.includes('dark brown') ||
      desc.includes('pale') ||
      desc.includes('fair');
    expect(hasExplicitTone).toBe(true);
  });

  it('gainzy identifies as Black', () => {
    const desc = getPfp('gainzy');
    expect(desc).toContain('black');
  });

  it('gainzy has skin tone descriptor', () => {
    const desc = getPfp('gainzy');
    const hasTone =
      desc.includes('dark brown skin') ||
      desc.includes('medium-dark brown') ||
      desc.includes('brown skin');
    expect(hasTone).toBe(true);
  });

  it('test-trader-npc-001 has explicit ethnicity', () => {
    const desc = getPfp('test-trader-npc-001');
    const hasEthnicity =
      desc.includes('latino') ||
      desc.includes('hispanic') ||
      desc.includes('black') ||
      desc.includes('white') ||
      desc.includes('asian') ||
      desc.includes('south asian') ||
      desc.includes('east asian');
    expect(hasEthnicity).toBe(true);
  });

  it('test-analyst-npc-002 has explicit ancestry', () => {
    const desc = getPfp('test-analyst-npc-002');
    const hasAncestry =
      desc.includes('south asian') ||
      desc.includes('east asian') ||
      desc.includes('black') ||
      desc.includes('latino') ||
      desc.includes('white');
    expect(hasAncestry).toBe(true);
  });

  it('org-blue-origain explicitly states bald', () => {
    const desc = getPfp('org-blue-origain');
    expect(desc).toContain('bald');
  });

  it('org-aix has explicit skin tone', () => {
    const desc = getPfp('org-aix');
    const hasTone =
      desc.includes('pale') ||
      desc.includes('fair') ||
      desc.includes('dark') ||
      desc.includes('brown');
    expect(hasTone).toBe(true);
  });

  it('org-ciai has explicit hair color or bald', () => {
    const desc = getPfp('org-ciai');
    const hasHair =
      desc.includes('brown hair') ||
      desc.includes('black hair') ||
      desc.includes('blonde') ||
      desc.includes('gray hair') ||
      desc.includes('bald') ||
      desc.includes('shaved');
    expect(hasHair).toBe(true);
  });
});
