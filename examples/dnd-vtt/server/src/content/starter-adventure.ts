/**
 * Starter Adventure Content
 * "The Goblin Den" - A classic introductory adventure for testing
 */

import type { Campaign, Location, NPC, Quest, CharacterSheet, Monster } from '../types';
import { SRD_MONSTERS, cloneMonster } from '../data';

/**
 * The Starter Campaign: The Village of Millbrook
 */
export const starterCampaign: Omit<Campaign, 'id' | 'createdAt' | 'updatedAt'> = {
  name: 'The Goblin Den',
  description: `The peaceful village of Millbrook has been plagued by goblin raids. Livestock is missing, 
travelers have been attacked on the roads, and the villagers live in fear. The local authorities have 
put out a call for adventurers to deal with the threat once and for all.

Your party has answered that call. Can you find the goblin lair and put an end to their menace?`,
  setting: 'Generic Fantasy (Forgotten Realms compatible)',
  tone: 'Heroic adventure with moments of tension and humor',
  themes: ['Good vs Evil', 'Protecting the Innocent', 'Teamwork'],
  startingLocationId: 'millbrook-village',
  sessionCount: 0,
  totalPlayTime: 0,
  status: 'active',
};

/**
 * Locations
 */
export const starterLocations: Array<Omit<Location, 'id' | 'campaignId'>> = [
  {
    name: 'Millbrook Village',
    description: `A quaint farming village nestled in a green valley. Thatched-roof cottages line the main road, 
and the smell of fresh bread drifts from the bakery. Despite its peaceful appearance, an air of worry 
hangs over the villagers.`,
    type: 'village',
    tags: ['peaceful', 'farming', 'threatened', 'friendly'],
    npcs: [],
    pointsOfInterest: [
      { name: 'The Rusty Tankard Inn', description: 'A cozy inn where travelers rest and locals share news' },
      { name: 'Village Square', description: 'The heart of the village with a well and notice board' },
      { name: 'General Store', description: 'Run by Merchant Gareth, stocks basic adventuring supplies' },
    ],
    availableServices: ['Inn & Tavern', 'General Store', 'Blacksmith', 'Temple of Chauntea'],
    dangerLevel: 1,
    isDiscovered: true,
    visitCount: 0,
  },
  {
    name: 'The Forest Road',
    description: `A winding dirt road that cuts through Briarwood Forest. Ancient oaks tower overhead, 
their branches forming a canopy that blocks much of the sunlight. The recent goblin attacks have made 
this once-safe route treacherous.`,
    type: 'wilderness',
    tags: ['forest', 'dangerous', 'ambush-prone'],
    npcs: [],
    pointsOfInterest: [
      { name: 'Overturned Merchant Cart', description: 'Evidence of a recent goblin attack' },
      { name: 'Hidden Trail', description: 'A barely visible path leading deeper into the forest' },
    ],
    availableServices: [],
    dangerLevel: 3,
    isDiscovered: false,
    visitCount: 0,
  },
  {
    name: 'The Goblin Den',
    description: `A natural cave system hidden in a rocky hillside. The entrance is obscured by thick 
brambles, and the stench of goblins is unmistakable. Crude watchtowers flank the entrance, and the 
sounds of guttural goblin speech echo from within.`,
    type: 'dungeon',
    tags: ['cave', 'dangerous', 'enemy-base'],
    npcs: [],
    pointsOfInterest: [
      { name: 'Main Entrance', description: 'Guarded by goblin sentries' },
      { name: 'Secret Tunnel', description: 'A hidden back entrance (DC 15 Perception to find)' },
      { name: 'Treasure Room', description: 'Where the goblins store their stolen goods' },
      { name: 'Chieftain\'s Chamber', description: 'Lair of Grishnak the goblin boss' },
    ],
    availableServices: [],
    dangerLevel: 4,
    isDiscovered: false,
    visitCount: 0,
  },
];

/**
 * NPCs
 */
export const starterNPCs: Array<Omit<NPC, 'id' | 'campaignId'>> = [
  {
    name: 'Mayor Aldric Thornwood',
    race: 'Human',
    type: 'quest_giver',
    occupation: 'Mayor',
    personality: 'A portly, worried man who genuinely cares for his village. He wrings his hands nervously but speaks with conviction about protecting his people.',
    motivation: 'To save Millbrook from the goblin threat at any cost',
    currentLocationId: 'millbrook-village',
    partyDisposition: 60,
    isHostile: false,
    isAlive: true,
    hp: { current: 8, max: 8, temp: 0 },
    ac: 10,
    interactionCount: 0,
  },
  {
    name: 'Mira the Innkeeper',
    race: 'Human',
    type: 'merchant',
    occupation: 'Innkeeper',
    personality: 'A warm, motherly woman with a knowing smile. She hears all the village gossip and is happy to share with friendly adventurers.',
    motivation: 'To keep her inn prosperous and her guests happy',
    currentLocationId: 'millbrook-village',
    partyDisposition: 65,
    isHostile: false,
    isAlive: true,
    hp: { current: 6, max: 6, temp: 0 },
    ac: 10,
    interactionCount: 0,
  },
  {
    name: 'Old Tomas',
    race: 'Human',
    type: 'informant',
    occupation: 'Retired Hunter',
    personality: 'A grizzled old man with one eye. He spends his days in the tavern, telling stories of his youth. He knows the forest better than anyone.',
    motivation: 'To relive his glory days through the adventures of others',
    currentLocationId: 'millbrook-village',
    partyDisposition: 50,
    isHostile: false,
    isAlive: true,
    hp: { current: 5, max: 5, temp: 0 },
    ac: 10,
    interactionCount: 0,
  },
  {
    name: 'Grishnak',
    race: 'Goblin',
    type: 'enemy',
    occupation: 'Goblin Boss',
    personality: 'Cruel and cunning for a goblin. He rules through fear and has ambitions of building a goblin kingdom.',
    motivation: 'To grow his tribe\'s power and wealth through raiding',
    currentLocationId: 'goblin-den',
    partyDisposition: 0,
    isHostile: true,
    isAlive: true,
    hp: { current: 21, max: 21, temp: 0 },
    ac: 17,
    challengeRating: 1,
    interactionCount: 0,
  },
];

/**
 * Quests
 */
export const starterQuests: Array<Omit<Quest, 'id' | 'campaignId'>> = [
  {
    name: 'The Goblin Menace',
    description: 'Investigate the goblin attacks and put an end to their raids on Millbrook Village.',
    type: 'main',
    giver: 'Mayor Aldric Thornwood',
    objectives: [
      { id: 'investigate', description: 'Speak with villagers about the attacks', completed: false },
      { id: 'find-lair', description: 'Locate the goblin lair', completed: false },
      { id: 'defeat-boss', description: 'Defeat the goblin leader', completed: false },
      { id: 'return', description: 'Return to the Mayor with proof of success', completed: false },
    ],
    rewards: {
      experience: 300,
      gold: 50,
      items: ['Potion of Healing'],
    },
    status: 'available',
    importance: 8,
  },
  {
    name: 'Lost Livestock',
    description: 'Farmer Jeb\'s prize pig went missing during the last raid. Find it if possible.',
    type: 'side',
    giver: 'Farmer Jeb',
    objectives: [
      { id: 'find-pig', description: 'Find the missing pig', completed: false },
      { id: 'return-pig', description: 'Return the pig to Farmer Jeb', completed: false },
    ],
    rewards: {
      experience: 50,
      gold: 10,
    },
    status: 'available',
    importance: 3,
  },
];

/**
 * Pre-generated AI Party Members
 */
export const starterParty: Array<Omit<CharacterSheet, 'id' | 'campaignId'>> = [
  {
    name: 'Thordak Ironforge',
    race: 'Dwarf',
    class: 'Fighter',
    level: 1,
    background: 'Soldier',
    alignment: 'Lawful Good',
    experiencePoints: 0,
    abilities: {
      strength: { score: 16, modifier: 3 },
      dexterity: { score: 12, modifier: 1 },
      constitution: { score: 15, modifier: 2 },
      intelligence: { score: 10, modifier: 0 },
      wisdom: { score: 13, modifier: 1 },
      charisma: { score: 8, modifier: -1 },
    },
    hp: { current: 12, max: 12, temp: 0 },
    ac: 18,
    speed: 25,
    proficiencyBonus: 2,
    skills: {
      athletics: 5,
      intimidation: 1,
      perception: 3,
    },
    savingThrows: ['str', 'con'],
    proficiencies: {
      armor: ['Light', 'Medium', 'Heavy', 'Shields'],
      weapons: ['Simple', 'Martial'],
      tools: ['Smith\'s tools'],
      languages: ['Common', 'Dwarvish'],
    },
    equipment: {
      weapons: [
        { name: 'Battleaxe', type: 'weapon', damage: '1d8', damageType: 'slashing', properties: ['versatile'] },
        { name: 'Handaxe', type: 'weapon', damage: '1d6', damageType: 'slashing', properties: ['light', 'thrown'] },
      ],
      armor: { name: 'Chain Mail', type: 'armor', ac: 16 },
      shield: { name: 'Shield', type: 'armor', acBonus: 2 },
      inventory: [
        { name: 'Explorer\'s Pack', type: 'gear', quantity: 1 },
        { name: 'Torch', type: 'gear', quantity: 5 },
      ],
      currency: { gp: 10, sp: 5, cp: 10 },
    },
    hitDice: { current: 1, max: 1 },
    isAI: true,
    backstory: 'A veteran of the mountain wars, Thordak left his clan to seek adventure and prove his worth beyond the mountains.',
  },
  {
    name: 'Lyria Moonshadow',
    race: 'Elf',
    class: 'Wizard',
    level: 1,
    background: 'Sage',
    alignment: 'Neutral Good',
    experiencePoints: 0,
    abilities: {
      strength: { score: 8, modifier: -1 },
      dexterity: { score: 14, modifier: 2 },
      constitution: { score: 12, modifier: 1 },
      intelligence: { score: 17, modifier: 3 },
      wisdom: { score: 13, modifier: 1 },
      charisma: { score: 10, modifier: 0 },
    },
    hp: { current: 7, max: 7, temp: 0 },
    ac: 12,
    speed: 30,
    proficiencyBonus: 2,
    skills: {
      arcana: 5,
      history: 5,
      investigation: 5,
      perception: 3,
    },
    savingThrows: ['int', 'wis'],
    proficiencies: {
      armor: [],
      weapons: ['Daggers', 'Darts', 'Slings', 'Quarterstaffs', 'Light Crossbows'],
      tools: [],
      languages: ['Common', 'Elvish', 'Draconic', 'Celestial'],
    },
    equipment: {
      weapons: [
        { name: 'Quarterstaff', type: 'weapon', damage: '1d6', damageType: 'bludgeoning', properties: ['versatile'] },
      ],
      inventory: [
        { name: 'Spellbook', type: 'gear', quantity: 1 },
        { name: 'Component Pouch', type: 'gear', quantity: 1 },
        { name: 'Scholar\'s Pack', type: 'gear', quantity: 1 },
      ],
      currency: { gp: 15, sp: 0, cp: 0 },
    },
    hitDice: { current: 1, max: 1 },
    spellSlots: { 1: { current: 2, max: 2 } },
    spellsKnown: [
      { name: 'Fire Bolt', level: 0, school: 'Evocation', castingTime: '1 action', range: '120 feet', damage: '1d10', damageType: 'fire', attack: true },
      { name: 'Mage Hand', level: 0, school: 'Conjuration', castingTime: '1 action', range: '30 feet' },
      { name: 'Light', level: 0, school: 'Evocation', castingTime: '1 action', range: 'Touch' },
      { name: 'Magic Missile', level: 1, school: 'Evocation', castingTime: '1 action', range: '120 feet', damage: '1d4+1' },
      { name: 'Shield', level: 1, school: 'Abjuration', castingTime: '1 reaction', range: 'Self' },
      { name: 'Sleep', level: 1, school: 'Enchantment', castingTime: '1 action', range: '90 feet' },
    ],
    isAI: true,
    backstory: 'A scholar from the Elven archives, Lyria seeks ancient knowledge lost to time and the thrill of discovery.',
  },
  {
    name: 'Brother Aldwin',
    race: 'Human',
    class: 'Cleric',
    level: 1,
    subclass: 'Life Domain',
    background: 'Acolyte',
    alignment: 'Lawful Good',
    experiencePoints: 0,
    abilities: {
      strength: { score: 14, modifier: 2 },
      dexterity: { score: 10, modifier: 0 },
      constitution: { score: 13, modifier: 1 },
      intelligence: { score: 10, modifier: 0 },
      wisdom: { score: 16, modifier: 3 },
      charisma: { score: 12, modifier: 1 },
    },
    hp: { current: 9, max: 9, temp: 0 },
    ac: 18,
    speed: 30,
    proficiencyBonus: 2,
    skills: {
      insight: 5,
      medicine: 5,
      persuasion: 3,
      religion: 2,
    },
    savingThrows: ['wis', 'cha'],
    proficiencies: {
      armor: ['Light', 'Medium', 'Heavy', 'Shields'],
      weapons: ['Simple'],
      tools: [],
      languages: ['Common', 'Celestial'],
    },
    equipment: {
      weapons: [
        { name: 'Mace', type: 'weapon', damage: '1d6', damageType: 'bludgeoning' },
      ],
      armor: { name: 'Chain Mail', type: 'armor', ac: 16 },
      shield: { name: 'Shield', type: 'armor', acBonus: 2 },
      inventory: [
        { name: 'Holy Symbol', type: 'gear', quantity: 1 },
        { name: 'Priest\'s Pack', type: 'gear', quantity: 1 },
        { name: 'Healer\'s Kit', type: 'gear', quantity: 1 },
      ],
      currency: { gp: 15, sp: 0, cp: 0 },
    },
    hitDice: { current: 1, max: 1 },
    spellSlots: { 1: { current: 2, max: 2 } },
    spellsKnown: [
      { name: 'Sacred Flame', level: 0, school: 'Evocation', castingTime: '1 action', range: '60 feet', damage: '1d8', damageType: 'radiant', savingThrow: 'dex' },
      { name: 'Guidance', level: 0, school: 'Divination', castingTime: '1 action', range: 'Touch' },
      { name: 'Spare the Dying', level: 0, school: 'Necromancy', castingTime: '1 action', range: 'Touch' },
      { name: 'Cure Wounds', level: 1, school: 'Evocation', castingTime: '1 action', range: 'Touch', healing: '1d8+3' },
      { name: 'Bless', level: 1, school: 'Enchantment', castingTime: '1 action', range: '30 feet' },
      { name: 'Shield of Faith', level: 1, school: 'Abjuration', castingTime: '1 bonus action', range: '60 feet' },
    ],
    isAI: true,
    backstory: 'A devoted priest of Lathander, Brother Aldwin seeks to bring light to dark places and healing to those in need.',
  },
  {
    name: 'Whisper',
    race: 'Halfling',
    class: 'Rogue',
    level: 1,
    background: 'Criminal',
    alignment: 'Chaotic Good',
    experiencePoints: 0,
    abilities: {
      strength: { score: 8, modifier: -1 },
      dexterity: { score: 17, modifier: 3 },
      constitution: { score: 12, modifier: 1 },
      intelligence: { score: 13, modifier: 1 },
      wisdom: { score: 10, modifier: 0 },
      charisma: { score: 14, modifier: 2 },
    },
    hp: { current: 9, max: 9, temp: 0 },
    ac: 14,
    speed: 25,
    proficiencyBonus: 2,
    skills: {
      acrobatics: 5,
      deception: 4,
      perception: 2,
      sleight_of_hand: 5,
      stealth: 7,
    },
    expertise: ['stealth', 'sleight_of_hand'],
    savingThrows: ['dex', 'int'],
    proficiencies: {
      armor: ['Light'],
      weapons: ['Simple', 'Hand Crossbows', 'Longswords', 'Rapiers', 'Shortswords'],
      tools: ['Thieves\' tools', 'Dice set'],
      languages: ['Common', 'Halfling', 'Thieves\' Cant'],
    },
    equipment: {
      weapons: [
        { name: 'Shortsword', type: 'weapon', damage: '1d6', damageType: 'piercing', properties: ['finesse', 'light'] },
        { name: 'Shortbow', type: 'weapon', damage: '1d6', damageType: 'piercing', properties: ['ammunition', 'two-handed'], range: '80/320' },
        { name: 'Dagger', type: 'weapon', damage: '1d4', damageType: 'piercing', properties: ['finesse', 'light', 'thrown'] },
      ],
      armor: { name: 'Leather Armor', type: 'armor', ac: 11 },
      inventory: [
        { name: 'Thieves\' Tools', type: 'tool', quantity: 1 },
        { name: 'Burglar\'s Pack', type: 'gear', quantity: 1 },
        { name: 'Arrows', type: 'gear', quantity: 20 },
      ],
      currency: { gp: 15, sp: 0, cp: 0 },
    },
    hitDice: { current: 1, max: 1 },
    isAI: true,
    backstory: 'Once a street urchin, Whisper learned to survive by her wits. Now she uses those skills for good... mostly.',
  },
];

/**
 * Get monsters for encounters
 */
export function getStarterMonsters(): { 
  goblinSentries: Monster[];
  goblinRaiders: Monster[];
  goblinBoss: Monster;
} {
  const goblinTemplate = SRD_MONSTERS.goblin;
  
  return {
    goblinSentries: [
      cloneMonster(goblinTemplate, 'Goblin Sentry 1'),
      cloneMonster(goblinTemplate, 'Goblin Sentry 2'),
    ],
    goblinRaiders: [
      cloneMonster(goblinTemplate, 'Goblin Raider 1'),
      cloneMonster(goblinTemplate, 'Goblin Raider 2'),
      cloneMonster(goblinTemplate, 'Goblin Raider 3'),
      cloneMonster(goblinTemplate, 'Goblin Raider 4'),
    ],
    goblinBoss: {
      ...SRD_MONSTERS.goblin,
      id: 'goblin-boss-grishnak',
      name: 'Grishnak the Goblin Boss',
      hp: { current: 21, max: 21, temp: 0 },
      ac: 17,
      armorType: 'chain shirt, shield',
      challengeRating: 1,
      experiencePoints: 200,
      actions: [
        ...SRD_MONSTERS.goblin.actions,
        {
          name: 'Multiattack',
          description: 'Grishnak makes two attacks with his scimitar.',
        },
        {
          name: 'Redirect Attack',
          description: 'When a creature Grishnak can see targets him with an attack, Grishnak chooses another goblin within 5 feet of him. The two goblins swap places, and the chosen goblin becomes the target instead.',
          recharge: 'Recharge 5-6',
        },
      ],
      specialAbilities: [
        {
          name: 'Nimble Escape',
          description: 'Grishnak can take the Disengage or Hide action as a bonus action on each of his turns.',
        },
        {
          name: 'Boss\'s Command',
          description: 'Goblins within 30 feet of Grishnak have advantage on attack rolls while Grishnak is not incapacitated.',
        },
      ],
    },
  };
}

/**
 * Opening narration for the adventure
 */
export const openingNarration = `The road to Millbrook was longer than you expected. As the sun begins to set, painting the sky in shades of orange and purple, the small farming village finally comes into view.

Thatched roofs peek above a low wooden palisade, and the smell of woodsmoke mixes with the earthy scent of freshly tilled fields. A wooden sign by the road reads "Welcome to Millbrook - Population 87" though someone has crossed out the number and written "84" beside it.

As you approach the village gate, a worried-looking guard waves you through, his eyes scanning the treeline behind you.

"Adventurers, are you? Thank the gods. The Mayor's been asking for help for weeks now. You'll find him at the village square, no doubt wringing his hands as usual."

He gestures toward the center of town, where a modest stone building flies a faded banner bearing the village crest.

"Mind the roads after dark. The goblins have grown bold."

What do you do?`;
