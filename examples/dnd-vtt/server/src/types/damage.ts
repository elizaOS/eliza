/**
 * D&D 5e Damage Types
 * All damage types and resistance/immunity/vulnerability handling
 */

export type DamageType =
  | 'acid'
  | 'bludgeoning'
  | 'cold'
  | 'fire'
  | 'force'
  | 'lightning'
  | 'necrotic'
  | 'piercing'
  | 'poison'
  | 'psychic'
  | 'radiant'
  | 'slashing'
  | 'thunder';

export const DAMAGE_TYPES: DamageType[] = [
  'acid',
  'bludgeoning',
  'cold',
  'fire',
  'force',
  'lightning',
  'necrotic',
  'piercing',
  'poison',
  'psychic',
  'radiant',
  'slashing',
  'thunder',
];

export const PHYSICAL_DAMAGE_TYPES: DamageType[] = [
  'bludgeoning',
  'piercing',
  'slashing',
];

export const MAGICAL_DAMAGE_TYPES: DamageType[] = [
  'acid',
  'cold',
  'fire',
  'force',
  'lightning',
  'necrotic',
  'poison',
  'psychic',
  'radiant',
  'thunder',
];

export interface DamageTypeDefinition {
  name: DamageType;
  displayName: string;
  description: string;
}

export const DAMAGE_TYPE_DEFINITIONS: Record<DamageType, DamageTypeDefinition> = {
  acid: {
    name: 'acid',
    displayName: 'Acid',
    description: 'Corrosive spray of acid or digestive enzymes.',
  },
  bludgeoning: {
    name: 'bludgeoning',
    displayName: 'Bludgeoning',
    description: 'Blunt force attacks such as from a mace, falling, or constriction.',
  },
  cold: {
    name: 'cold',
    displayName: 'Cold',
    description: 'Infernal chill from an ice storm or freezing breath.',
  },
  fire: {
    name: 'fire',
    displayName: 'Fire',
    description: 'Flames, dragon\'s breath, or many spells.',
  },
  force: {
    name: 'force',
    displayName: 'Force',
    description: 'Pure magical energy focused into a damaging form. Most force effects are spells like magic missile and spiritual weapon.',
  },
  lightning: {
    name: 'lightning',
    displayName: 'Lightning',
    description: 'Electrical damage from a lightning bolt spell or blue dragon\'s breath.',
  },
  necrotic: {
    name: 'necrotic',
    displayName: 'Necrotic',
    description: 'Dealt by certain undead and spells like chill touch. Withers matter and soul.',
  },
  piercing: {
    name: 'piercing',
    displayName: 'Piercing',
    description: 'Puncturing and impaling attacks including spears, bites, and arrows.',
  },
  poison: {
    name: 'poison',
    displayName: 'Poison',
    description: 'Venomous stings and toxic gas from a green dragon\'s breath.',
  },
  psychic: {
    name: 'psychic',
    displayName: 'Psychic',
    description: 'Mental abilities such as a mind flayer\'s psionic blast.',
  },
  radiant: {
    name: 'radiant',
    displayName: 'Radiant',
    description: 'Holy light or searing divine power from spells like flame strike or an angel\'s weapons.',
  },
  slashing: {
    name: 'slashing',
    displayName: 'Slashing',
    description: 'Swords, axes, and monsters\' claws deal slashing damage.',
  },
  thunder: {
    name: 'thunder',
    displayName: 'Thunder',
    description: 'A concussive burst of sound from spells like thunderwave or shatter.',
  },
};

export type DamageModifierType = 'resistance' | 'immunity' | 'vulnerability';

export interface DamageModifier {
  type: DamageModifierType;
  damageType: DamageType | 'all' | 'nonmagical_physical';
  condition?: string; // e.g., "from nonmagical attacks"
}

export interface DamageInstance {
  amount: number;
  type: DamageType;
  isMagical: boolean;
}

/**
 * Calculate final damage after applying resistances, immunities, and vulnerabilities
 */
export function calculateFinalDamage(
  damage: DamageInstance,
  modifiers: DamageModifier[]
): number {
  let finalAmount = damage.amount;
  
  // Check for immunity first (reduces to 0)
  for (const modifier of modifiers) {
    if (modifier.type !== 'immunity') continue;
    
    if (matchesDamageType(damage, modifier)) {
      return 0;
    }
  }
  
  // Check for resistance (halves damage, rounded down)
  let hasResistance = false;
  for (const modifier of modifiers) {
    if (modifier.type !== 'resistance') continue;
    
    if (matchesDamageType(damage, modifier)) {
      hasResistance = true;
      break;
    }
  }
  
  // Check for vulnerability (doubles damage)
  let hasVulnerability = false;
  for (const modifier of modifiers) {
    if (modifier.type !== 'vulnerability') continue;
    
    if (matchesDamageType(damage, modifier)) {
      hasVulnerability = true;
      break;
    }
  }
  
  // Apply vulnerability first (doubles), then resistance (halves)
  // If both apply, they cancel out
  if (hasVulnerability && !hasResistance) {
    finalAmount = finalAmount * 2;
  } else if (hasResistance && !hasVulnerability) {
    finalAmount = Math.floor(finalAmount / 2);
  }
  
  return finalAmount;
}

/**
 * Check if a damage modifier applies to a damage instance
 */
function matchesDamageType(damage: DamageInstance, modifier: DamageModifier): boolean {
  if (modifier.damageType === 'all') {
    return true;
  }
  
  if (modifier.damageType === 'nonmagical_physical') {
    return PHYSICAL_DAMAGE_TYPES.includes(damage.type) && !damage.isMagical;
  }
  
  return modifier.damageType === damage.type;
}

/**
 * Calculate total damage from multiple damage instances
 */
export function calculateTotalDamage(
  damages: DamageInstance[],
  modifiers: DamageModifier[]
): { total: number; breakdown: { type: DamageType; original: number; final: number }[] } {
  const breakdown: { type: DamageType; original: number; final: number }[] = [];
  let total = 0;
  
  for (const damage of damages) {
    const finalAmount = calculateFinalDamage(damage, modifiers);
    breakdown.push({
      type: damage.type,
      original: damage.amount,
      final: finalAmount,
    });
    total += finalAmount;
  }
  
  return { total, breakdown };
}

/**
 * Common damage resistance configurations
 */
export const COMMON_RESISTANCES = {
  nonmagicalPhysical: {
    type: 'resistance' as const,
    damageType: 'nonmagical_physical' as const,
  },
  fire: {
    type: 'resistance' as const,
    damageType: 'fire' as const,
  },
  cold: {
    type: 'resistance' as const,
    damageType: 'cold' as const,
  },
  poison: {
    type: 'resistance' as const,
    damageType: 'poison' as const,
  },
};

export const COMMON_IMMUNITIES = {
  poison: {
    type: 'immunity' as const,
    damageType: 'poison' as const,
  },
  psychic: {
    type: 'immunity' as const,
    damageType: 'psychic' as const,
  },
  nonmagicalPhysical: {
    type: 'immunity' as const,
    damageType: 'nonmagical_physical' as const,
  },
};
