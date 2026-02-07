/**
 * D&D 5e Conditions
 * Status effects that can apply to creatures
 */

// Base condition names (lowercase canonical form)
type BaseConditionName =
  | 'blinded' | 'charmed' | 'deafened' | 'frightened' | 'grappled'
  | 'incapacitated' | 'invisible' | 'paralyzed' | 'petrified' | 'poisoned'
  | 'prone' | 'restrained' | 'stunned' | 'unconscious' | 'exhaustion';

// Allow both lowercase and PascalCase for compatibility
export type ConditionName = BaseConditionName | Capitalize<BaseConditionName>;

export type ConditionEffectType =
  | 'advantage' | 'disadvantage' | 'auto_fail' | 'auto_success'
  | 'speed_zero' | 'speed_modifier' | 'resistance' | 'immunity'
  | 'incapacitated' | 'cant_speak' | 'cant_move' | 'drops_items'
  | 'falls_prone' | 'unaware' | 'crit_on_hit';

export interface ConditionEffect {
  type: ConditionEffectType;
  target?: string;
  value?: number;
  condition?: string;
}

export interface ConditionDefinition {
  name: ConditionName;
  displayName: string;
  description: string;
  effects: ConditionEffect[];
}

export interface ConditionDuration {
  type: 'rounds' | 'turns' | 'minutes' | 'hours' | 'permanent' | 'until_save' | 'until_dispelled';
  value?: number;
  endsAt?: 'start_of_turn' | 'end_of_turn';
  saveDC?: number;
  saveAbility?: string;
  roundsRemaining?: number;
}

export interface ActiveCondition {
  // Support both field names for compatibility with different modules
  condition?: ConditionName;
  name?: ConditionName;
  sourceId?: string;
  source?: string;
  duration?: number | ConditionDuration | { type: string; description?: string };
  exhaustionLevel?: number;
  level?: number; // Alias for exhaustionLevel
  saveDC?: number;
  saveAbility?: string;
  saveInfo?: { dc: number; ability: string; endOfTurn?: boolean };
  appliedAt?: number | Date;
}

/** Get the condition name from an ActiveCondition (handles both field names) */
export const getConditionName = (c: ActiveCondition): ConditionName => 
  (c.condition ?? c.name) as ConditionName;

/** Get the source ID from an ActiveCondition (handles both field names) */
export const getConditionSource = (c: ActiveCondition): string => 
  c.sourceId ?? c.source ?? 'unknown';

/** Normalize condition name to lowercase */
export const normalizeCondition = (name: string | undefined): BaseConditionName => 
  (name ?? '').toLowerCase() as BaseConditionName;

/** Get condition definition (case-insensitive) */
export const getCondition = (name: string): ConditionDefinition | undefined =>
  CONDITIONS[normalizeCondition(name)];

export const CONDITIONS: Record<BaseConditionName, ConditionDefinition> = {
  blinded: {
    name: 'blinded',
    displayName: 'Blinded',
    description: "Can't see. Auto-fails sight checks. Attacks against have advantage, own attacks have disadvantage.",
    effects: [
      { type: 'auto_fail', target: 'sight_checks' },
      { type: 'disadvantage', target: 'attack_rolls' },
      { type: 'advantage', target: 'attacks_against' },
    ],
  },
  charmed: {
    name: 'charmed',
    displayName: 'Charmed',
    description: "Can't attack or target the charmer with harmful effects. Charmer has advantage on social checks.",
    effects: [{ type: 'advantage', target: 'social_checks_by_charmer' }],
  },
  deafened: {
    name: 'deafened',
    displayName: 'Deafened',
    description: "Can't hear. Auto-fails hearing checks.",
    effects: [{ type: 'auto_fail', target: 'hearing_checks' }],
  },
  frightened: {
    name: 'frightened',
    displayName: 'Frightened',
    description: "Disadvantage on ability checks and attacks while fear source is visible. Can't move closer to source.",
    effects: [
      { type: 'disadvantage', target: 'ability_checks', condition: 'source_visible' },
      { type: 'disadvantage', target: 'attack_rolls', condition: 'source_visible' },
      { type: 'cant_move', condition: 'toward_source' },
    ],
  },
  grappled: {
    name: 'grappled',
    displayName: 'Grappled',
    description: "Speed becomes 0. Ends if grappler is incapacitated or creature is moved out of reach.",
    effects: [{ type: 'speed_zero' }],
  },
  incapacitated: {
    name: 'incapacitated',
    displayName: 'Incapacitated',
    description: "Can't take actions or reactions.",
    effects: [{ type: 'incapacitated' }],
  },
  invisible: {
    name: 'invisible',
    displayName: 'Invisible',
    description: "Impossible to see. Heavily obscured for hiding. Attacks against have disadvantage, own attacks have advantage.",
    effects: [
      { type: 'advantage', target: 'attack_rolls' },
      { type: 'disadvantage', target: 'attacks_against' },
    ],
  },
  paralyzed: {
    name: 'paralyzed',
    displayName: 'Paralyzed',
    description: "Incapacitated, can't move or speak. Auto-fails STR/DEX saves. Attacks against have advantage. Melee hits are crits.",
    effects: [
      { type: 'incapacitated' },
      { type: 'cant_move' },
      { type: 'cant_speak' },
      { type: 'auto_fail', target: 'strength_saves' },
      { type: 'auto_fail', target: 'dexterity_saves' },
      { type: 'advantage', target: 'attacks_against' },
      { type: 'crit_on_hit', condition: 'within 5 feet' },
    ],
  },
  petrified: {
    name: 'petrified',
    displayName: 'Petrified',
    description: "Turned to stone. Incapacitated, unaware. Auto-fails STR/DEX saves. Resistance to all damage. Immune to poison/disease.",
    effects: [
      { type: 'incapacitated' },
      { type: 'cant_move' },
      { type: 'cant_speak' },
      { type: 'unaware' },
      { type: 'auto_fail', target: 'strength_saves' },
      { type: 'auto_fail', target: 'dexterity_saves' },
      { type: 'advantage', target: 'attacks_against' },
      { type: 'resistance', target: 'all_damage' },
      { type: 'immunity', target: 'poison' },
      { type: 'immunity', target: 'disease' },
    ],
  },
  poisoned: {
    name: 'poisoned',
    displayName: 'Poisoned',
    description: "Disadvantage on attack rolls and ability checks.",
    effects: [
      { type: 'disadvantage', target: 'attack_rolls' },
      { type: 'disadvantage', target: 'ability_checks' },
    ],
  },
  prone: {
    name: 'prone',
    displayName: 'Prone',
    description: "Can only crawl. Disadvantage on attacks. Melee attacks against have advantage, ranged have disadvantage.",
    effects: [
      { type: 'disadvantage', target: 'attack_rolls' },
      { type: 'advantage', target: 'attacks_against', condition: 'within 5 feet' },
      { type: 'disadvantage', target: 'attacks_against', condition: 'beyond 5 feet' },
    ],
  },
  restrained: {
    name: 'restrained',
    displayName: 'Restrained',
    description: "Speed 0. Attacks against have advantage, own attacks have disadvantage. Disadvantage on DEX saves.",
    effects: [
      { type: 'speed_zero' },
      { type: 'advantage', target: 'attacks_against' },
      { type: 'disadvantage', target: 'attack_rolls' },
      { type: 'disadvantage', target: 'dexterity_saves' },
    ],
  },
  stunned: {
    name: 'stunned',
    displayName: 'Stunned',
    description: "Incapacitated, can't move, can barely speak. Auto-fails STR/DEX saves. Attacks against have advantage.",
    effects: [
      { type: 'incapacitated' },
      { type: 'cant_move' },
      { type: 'auto_fail', target: 'strength_saves' },
      { type: 'auto_fail', target: 'dexterity_saves' },
      { type: 'advantage', target: 'attacks_against' },
    ],
  },
  unconscious: {
    name: 'unconscious',
    displayName: 'Unconscious',
    description: "Incapacitated, can't move/speak, unaware. Drops items, falls prone. Auto-fails STR/DEX saves. Melee hits are crits.",
    effects: [
      { type: 'incapacitated' },
      { type: 'cant_move' },
      { type: 'cant_speak' },
      { type: 'unaware' },
      { type: 'drops_items' },
      { type: 'falls_prone' },
      { type: 'auto_fail', target: 'strength_saves' },
      { type: 'auto_fail', target: 'dexterity_saves' },
      { type: 'advantage', target: 'attacks_against' },
      { type: 'crit_on_hit', condition: 'within 5 feet' },
    ],
  },
  exhaustion: {
    name: 'exhaustion',
    displayName: 'Exhaustion',
    description: "Levels 1-6. L1: Disadvantage on checks. L2: Half speed. L3: Disadvantage on attacks/saves. L4: Half HP max. L5: Speed 0. L6: Death.",
    effects: [],
  },
};

const INCAPACITATING = ['incapacitated', 'paralyzed', 'petrified', 'stunned', 'unconscious'];

/** Get exhaustion effects by level */
export function getExhaustionEffects(level: number): ConditionEffect[] {
  const effects: ConditionEffect[] = [];
  if (level >= 1) effects.push({ type: 'disadvantage', target: 'ability_checks' });
  if (level >= 2) effects.push({ type: 'speed_modifier', value: 0.5 });
  if (level >= 3) {
    effects.push({ type: 'disadvantage', target: 'attack_rolls' });
    effects.push({ type: 'disadvantage', target: 'saving_throws' });
  }
  if (level >= 5) effects.push({ type: 'speed_zero' });
  return effects;
}

/** Check if creature has a specific condition (case-insensitive) */
export function hasCondition(conditions: ActiveCondition[], name: string): boolean {
  const normalized = normalizeCondition(name);
  return conditions.some(c => normalizeCondition(getConditionName(c)) === normalized);
}

/** Check if creature is incapacitated from any source */
export function isIncapacitated(conditions: ActiveCondition[]): boolean {
  return conditions.some(c => INCAPACITATING.includes(normalizeCondition(getConditionName(c))));
}

/** Check if condition is active (case-insensitive) */
export function isConditionActive(conditions: ActiveCondition[], name: string): boolean {
  return hasCondition(conditions, name);
}

/** Check if attacks have advantage against creature */
export function attacksHaveAdvantage(conditions: ActiveCondition[], distance: number): boolean {
  for (const c of conditions) {
    const def = getCondition(getConditionName(c));
    if (!def) continue;
    for (const effect of def.effects) {
      if (effect.type === 'advantage' && effect.target === 'attacks_against') {
        if (!effect.condition) return true;
        if (effect.condition === 'within 5 feet' && distance <= 5) return true;
      }
    }
  }
  return false;
}

/** Check if attacks have disadvantage against creature */
export function attacksHaveDisadvantage(conditions: ActiveCondition[], distance: number): boolean {
  for (const c of conditions) {
    const def = getCondition(getConditionName(c));
    if (!def) continue;
    for (const effect of def.effects) {
      if (effect.type === 'disadvantage' && effect.target === 'attacks_against') {
        if (!effect.condition) return true;
        if (effect.condition === 'beyond 5 feet' && distance > 5) return true;
      }
    }
  }
  return false;
}

/** Remove a condition */
export function removeCondition(
  conditions: ActiveCondition[],
  name: string,
  sourceId?: string
): ActiveCondition[] {
  const normalized = normalizeCondition(name);
  return conditions.filter(c => {
    const cName = normalizeCondition(getConditionName(c));
    const cSource = getConditionSource(c);
    if (cName !== normalized) return true;
    if (sourceId && cSource !== sourceId) return true;
    return false;
  });
}

/** Add a condition (updates duration if already exists from same source) */
export function addCondition(
  conditions: ActiveCondition[],
  name: string,
  sourceId: string,
  duration?: number | ConditionDuration,
  exhaustionLevel?: number
): ActiveCondition[] {
  const normalized = normalizeCondition(name);
  const existing = conditions.find(c => 
    normalizeCondition(getConditionName(c)) === normalized && getConditionSource(c) === sourceId
  );
  
  if (existing) {
    if (typeof duration === 'number' && typeof existing.duration === 'number') {
      existing.duration = Math.max(existing.duration, duration);
    }
    return conditions;
  }
  
  return [...conditions, { condition: normalized, sourceId, duration, exhaustionLevel }];
}

/** Tick condition durations at end of round (returns remaining conditions) */
export function tickConditionDurations(conditions: ActiveCondition[]): ActiveCondition[] {
  return conditions.filter(c => {
    if (typeof c.duration === 'number') {
      c.duration--;
      return c.duration > 0;
    }
    if (typeof c.duration === 'object' && 'roundsRemaining' in c.duration && c.duration.roundsRemaining !== undefined) {
      c.duration.roundsRemaining--;
      return c.duration.roundsRemaining > 0;
    }
    return true; // Permanent or special durations persist
  });
}
