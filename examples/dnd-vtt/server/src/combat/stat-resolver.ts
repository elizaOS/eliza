/**
 * Extracts real combat stats from character sheets for the orchestrator.
 */

import type { CharacterSheet, Item, DamageType } from '../types';
import { getAbilityMod } from '../types';

interface ResolvedWeapon {
  name: string;
  attackBonus: number;
  damageDice: string;
  damageType: DamageType;
  isRanged: boolean;
  isMagical: boolean;
  properties: string[];
}

interface ResolvedSpell {
  name: string;
  level: number;
  attackBonus: number;
  damageDice: string;
  damageType: DamageType;
  isAttack: boolean;
  isHealing: boolean;
  healingDice: string;
  saveDC: number;
}

interface CombatStats {
  primaryWeapon: ResolvedWeapon;
  weapons: ResolvedWeapon[];
  stealthModifier: number;
  perceptionModifier: number;
  athleticsModifier: number;
  acrobaticsModifier: number;
  spellAttackBonus: number;
  spellSaveDC: number;
  spells: ResolvedSpell[];
  spellSlots: Record<number, { current: number; max: number }>;
  proficiencyBonus: number;
}

function getAbilityModFromSheet(sheet: CharacterSheet, ability: string): number {
  const abilities = sheet.abilities as Record<string, { score: number; modifier: number } | number>;
  const val = abilities[ability];
  if (val === undefined) return 0;
  if (typeof val === 'number') return getAbilityMod(val);
  return val.modifier;
}

function isFinesse(weapon: Item): boolean {
  if (Array.isArray(weapon.properties)) {
    return weapon.properties.some(p => typeof p === 'string' && p.toLowerCase() === 'finesse');
  }
  return false;
}

function isRanged(weapon: Item): boolean {
  if (weapon.range) return true;
  if (Array.isArray(weapon.properties)) {
    return weapon.properties.some(p =>
      typeof p === 'string' && (p.toLowerCase() === 'ammunition' || p.toLowerCase() === 'thrown')
    );
  }
  return false;
}

function resolveWeapon(sheet: CharacterSheet, weapon: Item): ResolvedWeapon {
  const profBonus = sheet.proficiencyBonus ?? 2;
  const strMod = getAbilityModFromSheet(sheet, 'strength');
  const dexMod = getAbilityModFromSheet(sheet, 'dexterity');

  const abilityMod = isFinesse(weapon) ? Math.max(strMod, dexMod)
    : isRanged(weapon) ? dexMod
    : strMod;

  const attackBonus = abilityMod + profBonus;
  const baseDamage = weapon.damage ?? '1d4';
  const damageDice = abilityMod !== 0
    ? `${baseDamage}${abilityMod >= 0 ? '+' : ''}${abilityMod}`
    : baseDamage;

  return {
    name: weapon.name,
    attackBonus,
    damageDice,
    damageType: (weapon.damageType as DamageType) ?? 'bludgeoning',
    isRanged: isRanged(weapon),
    isMagical: false,
    properties: Array.isArray(weapon.properties)
      ? weapon.properties.filter((p): p is string => typeof p === 'string')
      : [],
  };
}

const SPELLCASTING_ABILITY: Record<string, string> = {
  Wizard: 'intelligence', Cleric: 'wisdom', Druid: 'wisdom', Ranger: 'wisdom',
  Bard: 'charisma', Sorcerer: 'charisma', Warlock: 'charisma', Paladin: 'charisma',
};

export function resolveCombatStats(sheet: CharacterSheet): CombatStats {
  const profBonus = sheet.proficiencyBonus ?? 2;
  const dexMod = getAbilityModFromSheet(sheet, 'dexterity');
  const wisMod = getAbilityModFromSheet(sheet, 'wisdom');
  const strMod = getAbilityModFromSheet(sheet, 'strength');

  const equipment = sheet.equipment as { weapons?: Item[] } | Item[] | undefined;
  let weaponItems: Item[] = [];
  if (Array.isArray(equipment)) {
    weaponItems = equipment.filter(e => e.damage);
  } else if (equipment && 'weapons' in equipment && Array.isArray(equipment.weapons)) {
    weaponItems = equipment.weapons;
  }

  const weapons = weaponItems.map(w => resolveWeapon(sheet, w));
  const primaryWeapon = weapons.find(w => !w.isRanged) ?? weapons[0] ?? {
    name: 'Unarmed Strike',
    attackBonus: strMod + profBonus,
    damageDice: `1${strMod > 0 ? `+${strMod}` : ''}`,
    damageType: 'bludgeoning' as DamageType,
    isRanged: false,
    isMagical: false,
    properties: [],
  };

  const skills = (sheet.skills ?? {}) as Record<string, number>;

  const spellAbility = sheet.spellcastingAbility ?? SPELLCASTING_ABILITY[sheet.class] ?? null;
  const spellMod = spellAbility ? getAbilityModFromSheet(sheet, spellAbility) : 0;

  return {
    primaryWeapon,
    weapons,
    stealthModifier: skills.stealth ?? dexMod,
    perceptionModifier: skills.perception ?? wisMod,
    athleticsModifier: skills.athletics ?? strMod,
    acrobaticsModifier: skills.acrobatics ?? dexMod,
    spellAttackBonus: spellMod + profBonus,
    spellSaveDC: 8 + spellMod + profBonus,
    spells: (sheet.spellsKnown ?? []).map(spell => ({
      name: spell.name,
      level: spell.level,
      attackBonus: spellMod + profBonus,
      damageDice: spell.damage ?? '',
      damageType: (spell.damageType as DamageType) ?? 'force',
      isAttack: spell.attack === true,
      isHealing: !!spell.healing,
      healingDice: spell.healing ?? '',
      saveDC: 8 + spellMod + profBonus,
    })),
    spellSlots: sheet.spellSlots ?? {},
    proficiencyBonus: profBonus,
  };
}

export function findSpell(stats: CombatStats, spellName: string): ResolvedSpell | undefined {
  return stats.spells.find(s => s.name.toLowerCase() === spellName.toLowerCase());
}

export function hasSpellSlot(stats: CombatStats, level: number): boolean {
  const slot = stats.spellSlots[level];
  return !!slot && slot.current > 0;
}
