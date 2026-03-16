/**
 * Shared utilities for serializing combat/character data to client-friendly formats.
 */

import type { ActiveCondition, CharacterSheet } from '../types';

export function getCondName(cond: ActiveCondition): string {
  const name = cond.condition ?? cond.name ?? '';
  return typeof name === 'string' ? name : '';
}

export function extractConditionNames(conditions: ActiveCondition[]): string[] {
  return conditions.map(getCondName).filter(Boolean);
}

export function hasCondByName(conditions: ActiveCondition[], target: string): boolean {
  const lower = target.toLowerCase();
  return conditions.some(c => getCondName(c).toLowerCase() === lower);
}

interface NormalizedHP { current: number; max: number; temp: number }

export function normalizeHP(sheet: CharacterSheet): NormalizedHP {
  const hp = sheet.hp ?? sheet.hitPoints;
  if (!hp) return { current: 1, max: 1, temp: 0 };
  return {
    current: hp.current,
    max: hp.max,
    temp: (hp as unknown as Record<string, number>).temporary ?? (hp as unknown as Record<string, number>).temp ?? 0,
  };
}

export function buildCharacterPayload(sheet: CharacterSheet) {
  const hp = normalizeHP(sheet);
  return {
    id: sheet.id,
    name: sheet.name,
    race: sheet.race,
    class: sheet.class,
    level: sheet.level,
    hp,
    ac: sheet.ac ?? sheet.armorClass ?? 10,
    speed: sheet.speed ?? 30,
    conditions: extractConditionNames(sheet.conditions ?? []),
    spellSlots: sheet.spellSlots,
  };
}
