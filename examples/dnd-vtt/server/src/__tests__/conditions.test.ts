/**
 * Conditions System Tests
 * Tests for D&D 5e condition mechanics
 */

import { describe, test, expect } from 'bun:test';
import {
  CONDITIONS,
  normalizeCondition,
  getCondition,
  getConditionName,
  getConditionSource,
  hasCondition,
  isIncapacitated,
  isConditionActive,
  attacksHaveAdvantage,
  attacksHaveDisadvantage,
  removeCondition,
  addCondition,
  tickConditionDurations,
  getExhaustionEffects,
  type ActiveCondition,
  type ConditionName,
} from '../types/conditions';

describe('Conditions System', () => {
  // ============================================================================
  // CONDITION DEFINITIONS
  // ============================================================================
  describe('CONDITIONS lookup', () => {
    test('all standard D&D 5e conditions exist', () => {
      const standardConditions: Array<keyof typeof CONDITIONS> = [
        'blinded', 'charmed', 'deafened', 'frightened', 'grappled',
        'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned',
        'prone', 'restrained', 'stunned', 'unconscious', 'exhaustion',
      ];
      
      for (const cond of standardConditions) {
        expect(CONDITIONS[cond]).toBeDefined();
        expect(CONDITIONS[cond].name).toBe(cond);
        expect(CONDITIONS[cond].displayName).toBeTruthy();
        expect(CONDITIONS[cond].description).toBeTruthy();
      }
    });

    test('conditions have properly structured effects', () => {
      for (const [name, def] of Object.entries(CONDITIONS)) {
        expect(def.effects).toBeInstanceOf(Array);
        for (const effect of def.effects) {
          expect(effect.type).toBeTruthy();
        }
      }
    });

    test('incapacitating conditions have incapacitated effect', () => {
      const incapacitatingConditions: Array<keyof typeof CONDITIONS> = ['incapacitated', 'paralyzed', 'petrified', 'stunned', 'unconscious'];
      
      for (const cond of incapacitatingConditions) {
        const def = CONDITIONS[cond];
        const hasIncapEffect = def.effects.some((e: { type: string }) => e.type === 'incapacitated');
        expect(hasIncapEffect).toBe(true);
      }
    });
  });

  // ============================================================================
  // NORMALIZATION & LOOKUP
  // ============================================================================
  describe('normalizeCondition', () => {
    test('converts to lowercase', () => {
      expect(normalizeCondition('Blinded')).toBe('blinded');
      expect(normalizeCondition('STUNNED')).toBe('stunned');
      expect(normalizeCondition('Frightened')).toBe('frightened');
    });

    test('handles already lowercase', () => {
      expect(normalizeCondition('prone')).toBe('prone');
    });

    test('handles mixed case', () => {
      expect(normalizeCondition('PaRaLyZeD')).toBe('paralyzed');
    });
  });

  describe('getCondition', () => {
    test('retrieves condition by lowercase name', () => {
      const result = getCondition('blinded');
      expect(result).toBeDefined();
      expect(result?.name).toBe('blinded');
    });

    test('retrieves condition case-insensitively', () => {
      expect(getCondition('Blinded')?.name).toBe('blinded');
      expect(getCondition('POISONED')?.name).toBe('poisoned');
    });

    test('returns undefined for unknown condition', () => {
      expect(getCondition('flying')).toBeUndefined();
      expect(getCondition('hasted')).toBeUndefined();
    });
  });

  // ============================================================================
  // ACTIVE CONDITION HELPERS
  // ============================================================================
  describe('getConditionName', () => {
    test('returns condition field if present', () => {
      const active: ActiveCondition = { condition: 'blinded', sourceId: 'spell1' };
      expect(getConditionName(active)).toBe('blinded');
    });

    test('falls back to name field', () => {
      const active: ActiveCondition = { name: 'stunned', source: 'monster1' };
      expect(getConditionName(active)).toBe('stunned');
    });

    test('prefers condition over name', () => {
      const active: ActiveCondition = { condition: 'blinded', name: 'stunned' };
      expect(getConditionName(active)).toBe('blinded');
    });
  });

  describe('getConditionSource', () => {
    test('returns sourceId if present', () => {
      const active: ActiveCondition = { condition: 'blinded', sourceId: 'spell1' };
      expect(getConditionSource(active)).toBe('spell1');
    });

    test('falls back to source field', () => {
      const active: ActiveCondition = { name: 'stunned', source: 'monster1' };
      expect(getConditionSource(active)).toBe('monster1');
    });

    test('returns "unknown" if no source', () => {
      const active: ActiveCondition = { condition: 'prone' };
      expect(getConditionSource(active)).toBe('unknown');
    });
  });

  // ============================================================================
  // CONDITION CHECKS
  // ============================================================================
  describe('hasCondition', () => {
    const conditions: ActiveCondition[] = [
      { condition: 'blinded', sourceId: 'spell1' },
      { condition: 'poisoned', sourceId: 'trap1' },
    ];

    test('finds existing condition (lowercase)', () => {
      expect(hasCondition(conditions, 'blinded')).toBe(true);
      expect(hasCondition(conditions, 'poisoned')).toBe(true);
    });

    test('finds existing condition (case-insensitive)', () => {
      expect(hasCondition(conditions, 'Blinded')).toBe(true);
      expect(hasCondition(conditions, 'POISONED')).toBe(true);
    });

    test('returns false for absent condition', () => {
      expect(hasCondition(conditions, 'stunned')).toBe(false);
      expect(hasCondition(conditions, 'prone')).toBe(false);
    });

    test('handles empty conditions array', () => {
      expect(hasCondition([], 'blinded')).toBe(false);
    });

    test('works with name field instead of condition', () => {
      const conditions: ActiveCondition[] = [
        { name: 'frightened', source: 'dragon' },
      ];
      expect(hasCondition(conditions, 'frightened')).toBe(true);
      expect(hasCondition(conditions, 'Frightened')).toBe(true);
    });
  });

  describe('isIncapacitated', () => {
    test('returns true for incapacitated condition', () => {
      expect(isIncapacitated([{ condition: 'incapacitated' }])).toBe(true);
    });

    test('returns true for paralyzed', () => {
      expect(isIncapacitated([{ condition: 'paralyzed' }])).toBe(true);
    });

    test('returns true for petrified', () => {
      expect(isIncapacitated([{ condition: 'petrified' }])).toBe(true);
    });

    test('returns true for stunned', () => {
      expect(isIncapacitated([{ condition: 'stunned' }])).toBe(true);
    });

    test('returns true for unconscious', () => {
      expect(isIncapacitated([{ condition: 'unconscious' }])).toBe(true);
    });

    test('returns false for non-incapacitating conditions', () => {
      expect(isIncapacitated([{ condition: 'blinded' }])).toBe(false);
      expect(isIncapacitated([{ condition: 'poisoned' }])).toBe(false);
      expect(isIncapacitated([{ condition: 'prone' }])).toBe(false);
    });

    test('handles mixed conditions', () => {
      const conditions: ActiveCondition[] = [
        { condition: 'blinded' },
        { condition: 'poisoned' },
      ];
      expect(isIncapacitated(conditions)).toBe(false);
      
      conditions.push({ condition: 'stunned' });
      expect(isIncapacitated(conditions)).toBe(true);
    });

    test('works case-insensitively', () => {
      expect(isIncapacitated([{ condition: 'Unconscious' }])).toBe(true);
      expect(isIncapacitated([{ name: 'Paralyzed' }])).toBe(true);
    });
  });

  describe('isConditionActive', () => {
    test('delegates to hasCondition', () => {
      const conditions: ActiveCondition[] = [{ condition: 'prone' }];
      expect(isConditionActive(conditions, 'prone')).toBe(true);
      expect(isConditionActive(conditions, 'Prone')).toBe(true);
      expect(isConditionActive(conditions, 'stunned')).toBe(false);
    });
  });

  // ============================================================================
  // ATTACK MODIFIERS
  // ============================================================================
  describe('attacksHaveAdvantage', () => {
    test('blinded grants advantage', () => {
      const conditions: ActiveCondition[] = [{ condition: 'blinded' }];
      expect(attacksHaveAdvantage(conditions, 5)).toBe(true);
    });

    test('paralyzed grants advantage', () => {
      const conditions: ActiveCondition[] = [{ condition: 'paralyzed' }];
      expect(attacksHaveAdvantage(conditions, 5)).toBe(true);
    });

    test('restrained grants advantage', () => {
      const conditions: ActiveCondition[] = [{ condition: 'restrained' }];
      expect(attacksHaveAdvantage(conditions, 5)).toBe(true);
    });

    test('stunned grants advantage', () => {
      const conditions: ActiveCondition[] = [{ condition: 'stunned' }];
      expect(attacksHaveAdvantage(conditions, 5)).toBe(true);
    });

    test('unconscious grants advantage', () => {
      const conditions: ActiveCondition[] = [{ condition: 'unconscious' }];
      expect(attacksHaveAdvantage(conditions, 5)).toBe(true);
    });

    test('prone grants advantage for melee (within 5 feet)', () => {
      const conditions: ActiveCondition[] = [{ condition: 'prone' }];
      expect(attacksHaveAdvantage(conditions, 5)).toBe(true);
      expect(attacksHaveAdvantage(conditions, 4)).toBe(true);
    });

    test('prone does NOT grant advantage beyond 5 feet', () => {
      const conditions: ActiveCondition[] = [{ condition: 'prone' }];
      expect(attacksHaveAdvantage(conditions, 10)).toBe(false);
      expect(attacksHaveAdvantage(conditions, 30)).toBe(false);
    });

    test('poisoned does NOT grant advantage', () => {
      const conditions: ActiveCondition[] = [{ condition: 'poisoned' }];
      expect(attacksHaveAdvantage(conditions, 5)).toBe(false);
    });

    test('no conditions means no advantage', () => {
      expect(attacksHaveAdvantage([], 5)).toBe(false);
    });
  });

  describe('attacksHaveDisadvantage', () => {
    test('invisible grants disadvantage to attackers', () => {
      const conditions: ActiveCondition[] = [{ condition: 'invisible' }];
      expect(attacksHaveDisadvantage(conditions, 5)).toBe(true);
    });

    test('prone grants disadvantage for ranged (beyond 5 feet)', () => {
      const conditions: ActiveCondition[] = [{ condition: 'prone' }];
      expect(attacksHaveDisadvantage(conditions, 10)).toBe(true);
      expect(attacksHaveDisadvantage(conditions, 30)).toBe(true);
    });

    test('prone does NOT grant disadvantage within 5 feet', () => {
      const conditions: ActiveCondition[] = [{ condition: 'prone' }];
      expect(attacksHaveDisadvantage(conditions, 5)).toBe(false);
    });

    test('no conditions means no disadvantage', () => {
      expect(attacksHaveDisadvantage([], 5)).toBe(false);
    });
  });

  // ============================================================================
  // CONDITION MANAGEMENT
  // ============================================================================
  describe('removeCondition', () => {
    test('removes condition by name', () => {
      const conditions: ActiveCondition[] = [
        { condition: 'blinded', sourceId: 'spell1' },
        { condition: 'poisoned', sourceId: 'trap1' },
      ];
      
      const result = removeCondition(conditions, 'blinded');
      expect(result.length).toBe(1);
      expect(hasCondition(result, 'blinded')).toBe(false);
      expect(hasCondition(result, 'poisoned')).toBe(true);
    });

    test('removes case-insensitively', () => {
      const conditions: ActiveCondition[] = [{ condition: 'stunned', sourceId: 'spell1' }];
      const result = removeCondition(conditions, 'STUNNED');
      expect(result.length).toBe(0);
    });

    test('removes only from specific source if provided', () => {
      const conditions: ActiveCondition[] = [
        { condition: 'blinded', sourceId: 'spell1' },
        { condition: 'blinded', sourceId: 'spell2' },
      ];
      
      const result = removeCondition(conditions, 'blinded', 'spell1');
      expect(result.length).toBe(1);
      expect(getConditionSource(result[0])).toBe('spell2');
    });

    test('removes all instances if no source specified', () => {
      const conditions: ActiveCondition[] = [
        { condition: 'blinded', sourceId: 'spell1' },
        { condition: 'blinded', sourceId: 'spell2' },
      ];
      
      const result = removeCondition(conditions, 'blinded');
      expect(result.length).toBe(0);
    });

    test('handles empty array', () => {
      const result = removeCondition([], 'blinded');
      expect(result).toEqual([]);
    });

    test('returns same array if condition not found', () => {
      const conditions: ActiveCondition[] = [{ condition: 'prone' }];
      const result = removeCondition(conditions, 'blinded');
      expect(result.length).toBe(1);
    });
  });

  describe('addCondition', () => {
    test('adds new condition', () => {
      const conditions: ActiveCondition[] = [];
      const result = addCondition(conditions, 'blinded', 'spell1', 3);
      
      expect(result.length).toBe(1);
      expect(result[0].condition).toBe('blinded');
      expect(result[0].sourceId).toBe('spell1');
      expect(result[0].duration).toBe(3);
    });

    test('normalizes condition name', () => {
      const conditions: ActiveCondition[] = [];
      const result = addCondition(conditions, 'STUNNED', 'spell1');
      expect(result[0].condition).toBe('stunned');
    });

    test('updates duration if condition exists from same source', () => {
      const conditions: ActiveCondition[] = [
        { condition: 'blinded', sourceId: 'spell1', duration: 2 },
      ];
      
      const result = addCondition(conditions, 'blinded', 'spell1', 5);
      expect(result.length).toBe(1);
      expect(result[0].duration).toBe(5); // Takes max
    });

    test('adds duplicate from different source', () => {
      const conditions: ActiveCondition[] = [
        { condition: 'blinded', sourceId: 'spell1', duration: 2 },
      ];
      
      const result = addCondition(conditions, 'blinded', 'spell2', 3);
      expect(result.length).toBe(2);
    });

    test('handles exhaustion level', () => {
      const conditions: ActiveCondition[] = [];
      const result = addCondition(conditions, 'exhaustion', 'fatigue', undefined, 2);
      
      expect(result[0].exhaustionLevel).toBe(2);
    });

    test('does not mutate original array', () => {
      const conditions: ActiveCondition[] = [{ condition: 'prone' }];
      const result = addCondition(conditions, 'blinded', 'spell1');
      
      expect(conditions.length).toBe(1);
      expect(result.length).toBe(2);
    });
  });

  describe('tickConditionDurations', () => {
    test('decrements numeric durations', () => {
      const conditions: ActiveCondition[] = [
        { condition: 'blinded', duration: 3 },
        { condition: 'stunned', duration: 1 },
      ];
      
      const result = tickConditionDurations(conditions);
      
      // Blinded should remain (2 rounds left)
      const blinded = result.find(c => c.condition === 'blinded');
      expect(blinded).toBeDefined();
      expect(blinded?.duration).toBe(2);
      
      // Stunned should be removed (was 1, now 0)
      expect(result.find(c => c.condition === 'stunned')).toBeUndefined();
    });

    test('removes conditions when duration reaches 0', () => {
      const conditions: ActiveCondition[] = [
        { condition: 'blinded', duration: 1 },
      ];
      
      const result = tickConditionDurations(conditions);
      expect(result.length).toBe(0);
    });

    test('handles ConditionDuration with roundsRemaining', () => {
      const conditions: ActiveCondition[] = [
        { condition: 'frightened', duration: { type: 'rounds', roundsRemaining: 2 } },
      ];
      
      const result = tickConditionDurations(conditions);
      const cond = result[0];
      expect(cond).toBeDefined();
      expect((cond.duration as { roundsRemaining: number }).roundsRemaining).toBe(1);
    });

    test('preserves permanent conditions', () => {
      const conditions: ActiveCondition[] = [
        { condition: 'petrified', duration: { type: 'permanent' } },
      ];
      
      const result = tickConditionDurations(conditions);
      expect(result.length).toBe(1);
    });

    test('preserves conditions without duration', () => {
      const conditions: ActiveCondition[] = [
        { condition: 'prone' }, // No duration specified
      ];
      
      const result = tickConditionDurations(conditions);
      expect(result.length).toBe(1);
    });

    test('handles mixed duration types', () => {
      const conditions: ActiveCondition[] = [
        { condition: 'blinded', duration: 2 },
        { condition: 'frightened', duration: { type: 'rounds', roundsRemaining: 1 } },
        { condition: 'prone' }, // No duration
        { condition: 'petrified', duration: { type: 'permanent' } },
      ];
      
      const result = tickConditionDurations(conditions);
      
      expect(result.length).toBe(3); // frightened removed
      expect(hasCondition(result, 'blinded')).toBe(true);
      expect(hasCondition(result, 'frightened')).toBe(false);
      expect(hasCondition(result, 'prone')).toBe(true);
      expect(hasCondition(result, 'petrified')).toBe(true);
    });
  });

  // ============================================================================
  // EXHAUSTION
  // ============================================================================
  describe('getExhaustionEffects', () => {
    test('level 0 has no effects', () => {
      expect(getExhaustionEffects(0)).toEqual([]);
    });

    test('level 1 gives disadvantage on ability checks', () => {
      const effects = getExhaustionEffects(1);
      expect(effects.some(e => e.type === 'disadvantage' && e.target === 'ability_checks')).toBe(true);
    });

    test('level 2 adds half speed', () => {
      const effects = getExhaustionEffects(2);
      expect(effects.some(e => e.type === 'speed_modifier' && e.value === 0.5)).toBe(true);
      // Should also have level 1 effects
      expect(effects.some(e => e.type === 'disadvantage' && e.target === 'ability_checks')).toBe(true);
    });

    test('level 3 adds disadvantage on attacks and saves', () => {
      const effects = getExhaustionEffects(3);
      expect(effects.some(e => e.type === 'disadvantage' && e.target === 'attack_rolls')).toBe(true);
      expect(effects.some(e => e.type === 'disadvantage' && e.target === 'saving_throws')).toBe(true);
    });

    test('level 5 sets speed to 0', () => {
      const effects = getExhaustionEffects(5);
      expect(effects.some(e => e.type === 'speed_zero')).toBe(true);
    });

    test('effects accumulate at higher levels', () => {
      const level1 = getExhaustionEffects(1);
      const level3 = getExhaustionEffects(3);
      const level5 = getExhaustionEffects(5);
      
      expect(level3.length).toBeGreaterThan(level1.length);
      expect(level5.length).toBeGreaterThan(level3.length);
    });

    test('level 6 (death) returns all effects up to level 5', () => {
      const effects = getExhaustionEffects(6);
      // Should have all cumulative effects
      expect(effects.some(e => e.type === 'disadvantage' && e.target === 'ability_checks')).toBe(true);
      expect(effects.some(e => e.type === 'speed_modifier')).toBe(true);
      expect(effects.some(e => e.type === 'speed_zero')).toBe(true);
    });
  });

  // ============================================================================
  // EDGE CASES
  // ============================================================================
  describe('edge cases', () => {
    test('handles undefined condition gracefully', () => {
      const conditions: ActiveCondition[] = [
        { condition: undefined as unknown as ConditionName, sourceId: 'test' },
      ];
      // Should not crash
      expect(() => hasCondition(conditions, 'blinded')).not.toThrow();
    });

    test('handles empty string condition name', () => {
      expect(getCondition('')).toBeUndefined();
      expect(normalizeCondition('') as string).toBe('');
    });

    test('condition check with very long list', () => {
      const conditions: ActiveCondition[] = [];
      for (let i = 0; i < 100; i++) {
        conditions.push({ condition: 'poisoned', sourceId: `source${i}` });
      }
      expect(hasCondition(conditions, 'poisoned')).toBe(true);
      expect(hasCondition(conditions, 'stunned')).toBe(false);
    });
  });
});
