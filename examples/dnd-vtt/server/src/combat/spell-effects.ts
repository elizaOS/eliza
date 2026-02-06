/**
 * Spell effect resolution for non-attack, non-healing spells.
 * Maps spell names to their mechanical effects (conditions, AC bonuses, etc).
 */

import type { Combatant, CombatEncounter } from './combat-state';
import type { ConditionName } from '../types';
import { updateCombatant } from './combat-manager';
import { rollD8 } from '../dice';

interface SpellEffect {
  /** Apply the effect to caster and/or targets. Returns description of what happened. */
  apply(
    encounter: CombatEncounter,
    caster: Combatant,
    targets: Combatant[],
  ): { encounter: CombatEncounter; description: string };
}

const SPELL_EFFECTS: Record<string, SpellEffect> = {
  'shield': {
    apply(encounter, caster) {
      // +5 AC until start of caster's next turn
      const updated: Combatant = {
        ...caster,
        ac: caster.ac + 5,
        conditions: [...caster.conditions, {
          condition: 'shielded' as ConditionName,
          name: 'Shielded' as ConditionName,
          source: 'Shield spell',
          duration: { type: 'turns', value: 1, endsAt: 'start_of_turn' },
        }],
      };
      return {
        encounter: updateCombatant(encounter, updated),
        description: `${caster.name} casts Shield! AC increased to ${updated.ac} until their next turn.`,
      };
    },
  },

  'shield of faith': {
    apply(encounter, caster, targets) {
      const target = targets[0] ?? caster;
      const updated: Combatant = {
        ...target,
        ac: target.ac + 2,
        concentratingOn: 'Shield of Faith',
        conditions: [...target.conditions, {
          condition: 'shield_of_faith' as ConditionName,
          name: 'Shield of Faith' as ConditionName,
          source: caster.name,
          duration: { type: 'minutes', value: 10 },
        }],
      };
      const enc = updateCombatant(encounter, updated);
      // Mark caster as concentrating
      const casterUpdated = { ...caster, concentratingOn: 'Shield of Faith' };
      return {
        encounter: target.id === caster.id ? enc : updateCombatant(enc, casterUpdated),
        description: `${caster.name} casts Shield of Faith on ${target.name}. AC increased by 2 (now ${updated.ac}).`,
      };
    },
  },

  'bless': {
    apply(encounter, caster, targets) {
      // Up to 3 targets get +1d4 to attack rolls and saving throws
      const blessed = targets.slice(0, 3);
      let enc = encounter;
      for (const t of blessed) {
        const updated: Combatant = {
          ...t,
          conditions: [...t.conditions, {
            condition: 'blessed' as ConditionName,
            name: 'Blessed' as ConditionName,
            source: caster.name,
            duration: { type: 'minutes', value: 1 },
          }],
        };
        enc = updateCombatant(enc, updated);
      }
      const casterUpdated = { ...caster, concentratingOn: 'Bless' };
      enc = updateCombatant(enc, casterUpdated);
      const names = blessed.map(t => t.name).join(', ');
      return {
        encounter: enc,
        description: `${caster.name} casts Bless on ${names}! They gain +1d4 to attack rolls and saving throws.`,
      };
    },
  },

  'guidance': {
    apply(encounter, caster, targets) {
      const target = targets[0] ?? caster;
      const updated: Combatant = {
        ...target,
        conditions: [...target.conditions, {
          condition: 'guided' as ConditionName,
          name: 'Guidance' as ConditionName,
          source: caster.name,
          duration: { type: 'turns', value: 1, endsAt: 'end_of_turn' },
        }],
      };
      return {
        encounter: updateCombatant(encounter, updated),
        description: `${caster.name} casts Guidance on ${target.name}. They gain +1d4 to their next ability check.`,
      };
    },
  },

  'sleep': {
    apply(encounter, caster) {
      // Roll 5d8 HP of creatures affected, starting from lowest HP
      let remainingHP = 0;
      for (let i = 0; i < 5; i++) {
        remainingHP += rollD8();
      }
      const totalRolled = remainingHP;

      // Sort enemies by current HP (ascending), skip undead/constructs
      const enemies = encounter.initiativeOrder
        .filter(c => c.type !== caster.type && c.hp.current > 0)
        .sort((a, b) => a.hp.current - b.hp.current);

      let enc = encounter;
      const slept: string[] = [];
      for (const enemy of enemies) {
        if (remainingHP >= enemy.hp.current) {
          remainingHP -= enemy.hp.current;
          const updated: Combatant = {
            ...enemy,
            conditions: [...enemy.conditions, {
              condition: 'unconscious' as ConditionName,
              name: 'Unconscious' as ConditionName,
              source: 'Sleep spell',
              duration: { type: 'minutes', value: 1 },
            }],
          };
          enc = updateCombatant(enc, updated);
          slept.push(enemy.name);
        }
      }

      const desc = slept.length > 0
        ? `${caster.name} casts Sleep (${totalRolled} HP). ${slept.join(', ')} fall${slept.length === 1 ? 's' : ''} unconscious!`
        : `${caster.name} casts Sleep (${totalRolled} HP) but no creatures are affected.`;

      return { encounter: enc, description: desc };
    },
  },

  'spare the dying': {
    apply(encounter, _caster, targets) {
      const target = targets[0];
      if (!target || target.hp.current > 0) {
        return { encounter, description: `The target is not dying.` };
      }
      const updated: Combatant = {
        ...target,
        deathSaves: { successes: 3, failures: target.deathSaves?.failures ?? 0 },
      };
      return {
        encounter: updateCombatant(encounter, updated),
        description: `${target.name} is stabilized by Spare the Dying.`,
      };
    },
  },
};

/**
 * Apply a spell's mechanical effect. Returns null if the spell has no registered effect.
 */
export function applySpellEffect(
  spellName: string,
  encounter: CombatEncounter,
  caster: Combatant,
  targets: Combatant[],
): { encounter: CombatEncounter; description: string } | null {
  const effect = SPELL_EFFECTS[spellName.toLowerCase()];
  if (!effect) return null;
  return effect.apply(encounter, caster, targets);
}
