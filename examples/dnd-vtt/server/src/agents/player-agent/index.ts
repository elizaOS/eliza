/**
 * Player Agent
 * AI-controlled player character agent
 */

import type { Character, AgentRuntime, Plugin } from '@elizaos/core';
import type { CharacterSheet, CharacterClass, Race, Alignment } from '../../types';
import { getAC } from '../../types';
import { playerPlugin } from './plugin';

/**
 * Personality archetypes for AI players
 */
export type PersonalityArchetype =
  | 'heroic'      // Classic hero, brave and selfless
  | 'cautious'    // Careful planner, avoids unnecessary risks
  | 'chaotic'     // Unpredictable, follows impulses
  | 'scholar'     // Knowledge-seeking, analytical
  | 'mercenary'   // Profit-motivated, pragmatic
  | 'noble'       // Honor-bound, follows a code
  | 'trickster'   // Clever and mischievous
  | 'zealot';     // Driven by faith or cause

/**
 * Configuration for player personality
 */
export interface PlayerPersonality {
  archetype: PersonalityArchetype;
  traits: string[];
  ideals: string[];
  bonds: string[];
  flaws: string[];
  quirks: string[];
  speechPatterns: string[];
}

/**
 * Generate personality based on archetype and character
 */
function generatePersonality(
  archetype: PersonalityArchetype,
  characterClass: CharacterClass | string,
  alignment: Alignment | string | undefined
): PlayerPersonality {
  const archetypeTraits: Record<PersonalityArchetype, Partial<PlayerPersonality>> = {
    heroic: {
      traits: ['brave', 'selfless', 'optimistic', 'determined'],
      ideals: ['Protecting the innocent is my highest calling', 'No one should have to face evil alone'],
      flaws: ['I sometimes rush into danger without thinking', 'I have trouble saying no to those in need'],
      speechPatterns: ['speaks with confidence', 'uses inspiring language', 'often references duty and honor'],
    },
    cautious: {
      traits: ['careful', 'observant', 'patient', 'methodical'],
      ideals: ['A good plan prevents unnecessary bloodshed', 'Information is the most valuable treasure'],
      flaws: ['I sometimes overthink and miss opportunities', 'I can be seen as cowardly'],
      speechPatterns: ['asks many questions', 'often suggests alternatives', 'weighs options out loud'],
    },
    chaotic: {
      traits: ['spontaneous', 'creative', 'adaptable', 'restless'],
      ideals: ['Freedom is the highest virtue', 'Rules are meant to be broken'],
      flaws: ['I get bored easily and make rash decisions', 'I have trouble with authority'],
      speechPatterns: ['interrupts often', 'suggests wild ideas', 'easily distracted'],
    },
    scholar: {
      traits: ['curious', 'analytical', 'patient', 'bookish'],
      ideals: ['Knowledge is power', 'Understanding our enemies is the key to defeating them'],
      flaws: ['I sometimes prioritize learning over action', 'I can be condescending about my knowledge'],
      speechPatterns: ['uses technical terms', 'cites historical precedents', 'asks probing questions'],
    },
    mercenary: {
      traits: ['pragmatic', 'resourceful', 'calculating', 'self-reliant'],
      ideals: ['Everyone has a price', 'Survival comes first'],
      flaws: ['I have trouble trusting others', 'I sometimes prioritize profit over principles'],
      speechPatterns: ['negotiates everything', 'counts coins', 'evaluates risks and rewards'],
    },
    noble: {
      traits: ['honorable', 'disciplined', 'proud', 'traditional'],
      ideals: ['My word is my bond', 'There are lines I will never cross'],
      flaws: ['My pride can blind me', 'I judge others by my own strict standards'],
      speechPatterns: ['formal speech', 'references to honor and duty', 'expects respect'],
    },
    trickster: {
      traits: ['clever', 'charming', 'witty', 'mischievous'],
      ideals: ['Laughter is the best medicine', 'The bigger they are, the harder they fall'],
      flaws: ['I can\'t resist a good prank', 'I sometimes go too far'],
      speechPatterns: ['makes jokes', 'uses wordplay', 'deflects with humor'],
    },
    zealot: {
      traits: ['devoted', 'passionate', 'unwavering', 'intense'],
      ideals: ['My cause is righteous', 'The ends justify the means'],
      flaws: ['I can be too extreme', 'I struggle to understand those who don\'t share my beliefs'],
      speechPatterns: ['references their faith/cause often', 'speaks with conviction', 'uses absolutist language'],
    },
  };
  
  const base = archetypeTraits[archetype];
  
  // Add class-specific elements
  const classQuirks: Record<CharacterClass, string[]> = {
    Barbarian: ['flexes muscles when thinking', 'solves problems with strength first', 'gets restless during long discussions'],
    Bard: ['hums or sings absently', 'collects stories', 'can\'t resist performing'],
    Cleric: ['offers prayers', 'carries holy symbols prominently', 'sees divine signs everywhere'],
    Druid: ['uncomfortable in cities', 'speaks to animals', 'prefers natural materials'],
    Fighter: ['assesses tactical situations', 'maintains equipment meticulously', 'respects martial prowess'],
    Monk: ['meditates during rest', 'moves with deliberate grace', 'speaks in measured tones'],
    Paladin: ['stands for the weak', 'keeps oaths visibly', 'radiates conviction'],
    Ranger: ['scouts ahead naturally', 'tracks everything', 'prefers the outdoors'],
    Rogue: ['checks for traps constantly', 'positions near exits', 'evaluates valuables'],
    Sorcerer: ['magic manifests in emotions', 'touches their focus absently', 'senses magical things'],
    Warlock: ['commune with patron', 'cryptic references', 'bargains come naturally'],
    Wizard: ['takes notes constantly', 'protective of spellbook', 'corrects magical misconceptions'],
  };
  
  return {
    archetype,
    traits: base.traits || [],
    ideals: base.ideals || [],
    bonds: [`Loyalty to the adventuring party`],
    flaws: base.flaws || [],
    quirks: classQuirks[characterClass as CharacterClass] || [],
    speechPatterns: base.speechPatterns || [],
  };
}

/**
 * Create an ElizaOS character for a player agent
 */
export function createPlayerCharacter(
  sheet: CharacterSheet,
  personality: PlayerPersonality
): Character {
  const backstoryIntro = sheet.background 
    ? `As a ${sheet.background}, `
    : '';
  
  return {
    name: sheet.name,
    system: `You are ${sheet.name}, a level ${sheet.level} ${sheet.race} ${sheet.class}${sheet.subclass ? ` (${sheet.subclass})` : ''} adventurer in a D&D 5e campaign.

${backstoryIntro}you embody these traits: ${personality.traits.join(', ')}.

Your ideals: ${personality.ideals.join('. ')}
Your bonds: ${personality.bonds.join('. ')}
Your flaws: ${personality.flaws.join('. ')}

Quirks and habits: ${personality.quirks.join('; ')}

Speech style: ${personality.speechPatterns.join(', ')}

## Your Current Stats
- HP: {{currentHp}}/{{maxHp}}
- AC: ${getAC(sheet)}
- Level: ${sheet.level}
- Class: ${sheet.class}

## How to Play
1. **Stay in character** - Speak and act as ${sheet.name} would, not as a player
2. **Engage with the story** - React to events, interact with NPCs, pursue your goals
3. **Collaborate** - Work with your party while maintaining your personality
4. **Take interesting actions** - Don't just optimize; make memorable moments
5. **Use your abilities** - Consider your class features and spells when appropriate

## Combat Behavior
- Assess threats and opportunities before acting
- Consider your position and the battlefield
- Use resources wisely but don't hoard them
- Protect allies when it fits your character
- Describe your actions with flavor

## Social Behavior  
- Speak in first person as your character
- React emotionally to events
- Build relationships with NPCs and party members
- Pursue personal goals alongside group objectives

Remember: You are playing a TTRPG. Have fun, be creative, and create a memorable story together.`,

    bio: [
      `${sheet.name} is a ${sheet.race} ${sheet.class} of level ${sheet.level}.`,
      sheet.backstory || `An adventurer with much yet to be discovered about their past.`,
      `Their personality is best described as ${personality.archetype}.`,
      `${sheet.name} values: ${personality.ideals[0] || 'adventure and discovery'}`,
      `Their greatest flaw is: ${personality.flaws[0] || 'a tendency toward recklessness'}`,
      `They are bound by: ${personality.bonds[0] || 'loyalty to companions'}`,
    ],

    messageExamples: [
      {
        examples: [
          {
            name: 'Dungeon Master',
            content: { text: 'You see a dark corridor ahead. What do you do?' },
          },
          {
            name: sheet.name,
            content: { text: generateSampleResponse(sheet, personality, 'exploration') },
          },
        ],
      },
      {
        examples: [
          {
            name: 'Dungeon Master',
            content: { text: 'The goblin swings at you with a rusty blade!' },
          },
          {
            name: sheet.name,
            content: { text: generateSampleResponse(sheet, personality, 'combat') },
          },
        ],
      },
      {
        examples: [
          {
            name: 'Dungeon Master',
            content: { text: 'The innkeeper asks what brings you to town.' },
          },
          {
            name: sheet.name,
            content: { text: generateSampleResponse(sheet, personality, 'social') },
          },
        ],
      },
    ],

    style: {
      all: [
        `Speaks as a ${personality.archetype} ${sheet.race} ${sheet.class}`,
        ...personality.speechPatterns,
        'Uses first person perspective',
        'Describes actions and emotions',
        'Stays true to character personality',
      ],
      chat: [
        'Responds to party members in character',
        'Contributes to group decisions',
        'Shows personality through dialogue',
      ],
      post: [
        'Describes actions with detail',
        'Includes character reactions',
        'Advances personal goals when appropriate',
      ],
    } as any,

    topics: [
      'adventure',
      'combat tactics',
      'party dynamics',
      'character background',
      'class abilities',
      sheet.class.toLowerCase(),
      'roleplay',
    ],

    adjectives: personality.traits,
    
    settings: {
      model: 'gpt-5',
      secrets: {},
    },
  };
}

/**
 * Generate sample response based on context
 */
function generateSampleResponse(
  sheet: CharacterSheet,
  personality: PlayerPersonality,
  context: 'exploration' | 'combat' | 'social'
): string {
  const responses: Record<PersonalityArchetype, Record<string, string>> = {
    heroic: {
      exploration: `I step forward, torch held high. "Let me take point - I won't let any danger catch us unaware."`,
      combat: `I raise my weapon and stand firm. "You won't touch my companions while I still draw breath!"`,
      social: `I meet their gaze with a warm smile. "We're here to help. Tell us of your troubles, friend."`,
    },
    cautious: {
      exploration: `I hold up a hand to slow the party. "Wait. Let me check for traps before we proceed."`,
      combat: `I take a defensive stance, analyzing the enemy. "Stay together - don't let them separate us."`,
      social: `I study the innkeeper carefully before responding. "We're travelers, seeking information about the area."`,
    },
    chaotic: {
      exploration: `"Ooh, dark and mysterious! I say we charge in and see what happens!" I start walking before anyone can object.`,
      combat: `I let out a wild laugh and rush forward. "Finally, some excitement!"`,
      social: `I lean on the bar with a grin. "What brings us here? Destiny, chaos, and a healthy disregard for common sense!"`,
    },
    scholar: {
      exploration: `I examine the corridor's architecture. "Interesting construction... possibly pre-cataclysm. We should proceed carefully."`,
      combat: `I assess the creature's weaknesses. "Based on its movement patterns, I'd suggest flanking from the left."`,
      social: `"We seek knowledge of the region's history. Have there been any unusual occurrences of late?"`,
    },
    mercenary: {
      exploration: `I scan for valuables and exits. "Keep your eyes open. Anything worth taking, or worth running from."`,
      combat: `"Let's make this quick and profitable." I look for the most efficient way to end this fight.`,
      social: `"We're professionals, looking for work. What's the local economy look like?"`,
    },
    noble: {
      exploration: `I straighten my posture and proceed with dignity. "We shall face whatever lies ahead with honor."`,
      combat: `I salute my opponent before engaging. "Face me if you dare, villain!"`,
      social: `I incline my head respectfully. "We are travelers on a quest of some importance. Your hospitality is appreciated."`,
    },
    trickster: {
      exploration: `I peer into the darkness with a mischievous grin. "Anyone want to bet what's down there? I've got five gold on something with tentacles."`,
      combat: `"Oh, you want to play? Let me show you a few tricks!" I feint and weave, looking for an opening.`,
      social: `I slide up to the bar with a winning smile. "The usual story - adventure, glory, and hopefully someone else paying for drinks."`,
    },
    zealot: {
      exploration: `I raise my holy symbol. "The path before us is dark, but my faith shall light the way."`,
      combat: `"Face divine judgment!" I channel my conviction into every strike.`,
      social: `"We serve a higher purpose. Have you heard the teachings of my faith?"`,
    },
  };
  
  return responses[personality.archetype][context] || 'I consider my options carefully.';
}

/**
 * Create a player agent from a character sheet
 */
export async function createPlayerAgent(
  runtime: AgentRuntime,
  sheet: CharacterSheet,
  archetype?: PersonalityArchetype,
  options?: {
    customPersonality?: Partial<PlayerPersonality>;
  }
): Promise<AgentRuntime> {
  // Determine archetype from alignment/class if not specified
  const selectedArchetype = archetype || inferArchetype(sheet);
  
  // Generate personality
  const personality = {
    ...generatePersonality(selectedArchetype, sheet.class, sheet.alignment ?? 'true neutral'),
    ...options?.customPersonality,
  } as PlayerPersonality;
  
  // Create ElizaOS character
  const character = createPlayerCharacter(sheet, personality);
  
  // Store character sheet and personality in agent settings
  await runtime.setSetting('characterSheet', JSON.stringify(sheet));
  await runtime.setSetting('personality', JSON.stringify(personality));
  await runtime.setSetting('role', 'player');
  await runtime.setSetting('characterId', sheet.id ?? '');
  
  // The runtime would need to be configured with the character
  // This depends on ElizaOS implementation details
  
  return runtime;
}

/**
 * Infer personality archetype from character traits
 */
function inferArchetype(sheet: CharacterSheet): PersonalityArchetype {
  const alignment = (sheet.alignment ?? 'true neutral').toLowerCase();
  const characterClass = sheet.class;
  
  // Class-based defaults
  const classDefaults: Partial<Record<CharacterClass, PersonalityArchetype>> = {
    Paladin: 'noble',
    Cleric: 'zealot',
    Rogue: 'trickster',
    Barbarian: 'chaotic',
    Wizard: 'scholar',
    Fighter: 'heroic',
    Ranger: 'cautious',
  };
  
  // Alignment-based modifications
  if (alignment.includes('chaotic')) {
    if (characterClass === 'Rogue') return 'trickster';
    return 'chaotic';
  }
  
  if (alignment.includes('lawful')) {
    if (alignment.includes('good')) return 'noble';
    return 'cautious';
  }
  
  if (alignment.includes('neutral') && !alignment.includes('good') && !alignment.includes('evil')) {
    return 'mercenary';
  }
  
  return classDefaults[characterClass as CharacterClass] || 'heroic';
}

export { playerPlugin };
