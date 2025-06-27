/**
 * Skill Definitions - RuneScape-like skill system
 * Defines all skills, experience tables, and requirements
 */

export enum SkillType {
  // Combat Skills
  ATTACK = 'attack',
  STRENGTH = 'strength',
  DEFENCE = 'defence',
  MAGIC = 'magic',
  RANGED = 'ranged',
  PRAYER = 'prayer',

  // Gathering Skills
  WOODCUTTING = 'woodcutting',
  MINING = 'mining',
  FISHING = 'fishing',

  // Crafting Skills
  SMITHING = 'smithing',
  COOKING = 'cooking',
  CRAFTING = 'crafting',
  FLETCHING = 'fletching',

  // Other Skills
  AGILITY = 'agility',
  THIEVING = 'thieving',
  HITPOINTS = 'hitpoints',
}

export interface SkillDefinition {
  type: SkillType
  name: string
  description: string
  isCombat: boolean
  maxLevel: number
  baseXP: number
  multiplier: number
}

export interface SkillAction {
  id: string
  skillType: SkillType
  name: string
  description: string
  levelRequired: number
  xpGained: number
  baseTime: number // milliseconds
  requirements?: {
    items?: { itemId: number; quantity: number }[]
    tools?: number[]
  }
  produces?: {
    itemId: number
    quantity: number
    chance?: number
  }[]
}

// RuneScape XP Table (levels 1-99)
export const XP_TABLE: number[] = [
  0, 83, 174, 276, 388, 512, 650, 801, 969, 1154, 1358, 1584, 1833, 2107, 2411, 2746, 3115, 3523, 3973, 4470, 5018,
  5624, 6291, 7028, 7842, 8740, 9730, 10824, 12031, 13363, 14833, 16456, 18247, 20224, 22406, 24815, 27473, 30408,
  33648, 37224, 41171, 45529, 50339, 55649, 61512, 67983, 75127, 83014, 91721, 101333, 111945, 123660, 136594, 150872,
  166636, 184040, 203254, 224466, 247886, 273742, 302288, 333804, 368599, 407015, 449428, 496254, 547953, 605032,
  668051, 737627, 814445, 899257, 992895, 1096278, 1210421, 1336443, 1475581, 1629200, 1798808, 1986068, 2192818,
  2421087, 2673114, 2951373, 3258594, 3597792, 3972294, 4385776, 4842295, 5346332, 5902831, 6517253, 7195629, 7944614,
  8771558, 9684577, 10692629, 11805606, 13034431,
]

export const SKILL_DEFINITIONS: Record<SkillType, SkillDefinition> = {
  [SkillType.ATTACK]: {
    type: SkillType.ATTACK,
    name: 'Attack',
    description: 'Determines which weapons you can wield',
    isCombat: true,
    maxLevel: 99,
    baseXP: 4,
    multiplier: 1,
  },
  [SkillType.STRENGTH]: {
    type: SkillType.STRENGTH,
    name: 'Strength',
    description: 'Increases your melee damage',
    isCombat: true,
    maxLevel: 99,
    baseXP: 4,
    multiplier: 1,
  },
  [SkillType.DEFENCE]: {
    type: SkillType.DEFENCE,
    name: 'Defence',
    description: 'Determines which armor you can wear',
    isCombat: true,
    maxLevel: 99,
    baseXP: 4,
    multiplier: 1,
  },
  [SkillType.MAGIC]: {
    type: SkillType.MAGIC,
    name: 'Magic',
    description: 'Determines which spells you can cast',
    isCombat: true,
    maxLevel: 99,
    baseXP: 2,
    multiplier: 1,
  },
  [SkillType.RANGED]: {
    type: SkillType.RANGED,
    name: 'Ranged',
    description: 'Determines which ranged weapons you can use',
    isCombat: true,
    maxLevel: 99,
    baseXP: 4,
    multiplier: 1,
  },
  [SkillType.PRAYER]: {
    type: SkillType.PRAYER,
    name: 'Prayer',
    description: 'Allows use of prayers for combat bonuses',
    isCombat: true,
    maxLevel: 99,
    baseXP: 5,
    multiplier: 1,
  },
  [SkillType.HITPOINTS]: {
    type: SkillType.HITPOINTS,
    name: 'Hitpoints',
    description: 'Determines your life points',
    isCombat: true,
    maxLevel: 99,
    baseXP: 4,
    multiplier: 1.33,
  },
  [SkillType.WOODCUTTING]: {
    type: SkillType.WOODCUTTING,
    name: 'Woodcutting',
    description: 'Allows you to cut down trees',
    isCombat: false,
    maxLevel: 99,
    baseXP: 25,
    multiplier: 1,
  },
  [SkillType.MINING]: {
    type: SkillType.MINING,
    name: 'Mining',
    description: 'Allows you to mine ores from rocks',
    isCombat: false,
    maxLevel: 99,
    baseXP: 17.5,
    multiplier: 1,
  },
  [SkillType.FISHING]: {
    type: SkillType.FISHING,
    name: 'Fishing',
    description: 'Allows you to catch fish',
    isCombat: false,
    maxLevel: 99,
    baseXP: 10,
    multiplier: 1,
  },
  [SkillType.SMITHING]: {
    type: SkillType.SMITHING,
    name: 'Smithing',
    description: 'Allows you to smelt ores and smith equipment',
    isCombat: false,
    maxLevel: 99,
    baseXP: 12.5,
    multiplier: 1,
  },
  [SkillType.COOKING]: {
    type: SkillType.COOKING,
    name: 'Cooking',
    description: 'Allows you to cook food',
    isCombat: false,
    maxLevel: 99,
    baseXP: 30,
    multiplier: 1,
  },
  [SkillType.CRAFTING]: {
    type: SkillType.CRAFTING,
    name: 'Crafting',
    description: 'Allows you to craft items from materials',
    isCombat: false,
    maxLevel: 99,
    baseXP: 17.5,
    multiplier: 1,
  },
  [SkillType.FLETCHING]: {
    type: SkillType.FLETCHING,
    name: 'Fletching',
    description: 'Allows you to make ranged weapons and ammo',
    isCombat: false,
    maxLevel: 99,
    baseXP: 15,
    multiplier: 1,
  },
  [SkillType.AGILITY]: {
    type: SkillType.AGILITY,
    name: 'Agility',
    description: 'Increases run energy and unlocks shortcuts',
    isCombat: false,
    maxLevel: 99,
    baseXP: 7.5,
    multiplier: 1,
  },
  [SkillType.THIEVING]: {
    type: SkillType.THIEVING,
    name: 'Thieving',
    description: 'Allows you to steal from NPCs and chests',
    isCombat: false,
    maxLevel: 99,
    baseXP: 8.5,
    multiplier: 1,
  },
}

// Skill utility functions
export function getXPForLevel(level: number): number {
  if (level < 1) {
    return 0
  }
  if (level > 99) {
    return XP_TABLE[98]
  }
  return XP_TABLE[level - 1]
}

export function getLevelForXP(xp: number): number {
  for (let i = 98; i >= 0; i--) {
    if (xp >= XP_TABLE[i]) {
      return i + 1
    }
  }
  return 1
}

export function getXPToNextLevel(currentXP: number): number {
  const currentLevel = getLevelForXP(currentXP)
  if (currentLevel >= 99) {
    return 0
  }

  const nextLevelXP = getXPForLevel(currentLevel + 1)
  return nextLevelXP - currentXP
}

export function getCombatLevel(skills: Record<SkillType, { level: number }>): number {
  const attack = skills[SkillType.ATTACK]?.level || 1
  const strength = skills[SkillType.STRENGTH]?.level || 1
  const defence = skills[SkillType.DEFENCE]?.level || 1
  const hitpoints = skills[SkillType.HITPOINTS]?.level || 10
  const prayer = skills[SkillType.PRAYER]?.level || 1
  const ranged = skills[SkillType.RANGED]?.level || 1
  const magic = skills[SkillType.MAGIC]?.level || 1

  const base = 0.25 * (defence + hitpoints + Math.floor(prayer / 2))
  const melee = 0.325 * (attack + strength)
  const range = 0.325 * (ranged + Math.floor(ranged / 2))
  const mage = 0.325 * (magic + Math.floor(magic / 2))

  return Math.floor(base + Math.max(melee, range, mage))
}
