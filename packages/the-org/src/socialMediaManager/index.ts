import fs from 'node:fs';
import path from 'node:path';
import type {
  Character,
  IAgentRuntime,
  OnboardingConfig,
  ProjectAgent,
  TestSuite,
  UUID,
} from '@elizaos/core';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { initCharacter } from '../init';
import twitterPostAction from './actions/post';

const imagePath = path.resolve('./src/socialMediaManager/assets/portrait.jpg');

// Read and convert to Base64
const avatar = fs.existsSync(imagePath)
  ? `data:image/jpeg;base64,${fs.readFileSync(imagePath).toString('base64')}`
  : '';

dotenv.config({ path: '../../.env' });

/**
 * Represents a character with specific attributes and behaviors for social media management.
 *
 * @typedef {Object} Character
 * @property {string} name - The name of the character.
 * @property {string[]} plugins - The list of plugins used by the character.
 * @property {Object} secrets - Object containing sensitive information like application ID and API token.
 * @property {Object} settings - Object containing various settings for the character.
 * @property {string} system - Description of the character's role and approach in social media management.
 * @property {string[]} bio - List of characteristics and beliefs of the character.
 * @property {Object[]} messageExamples - Examples of interactions with other individuals for messaging guidance.
 * @property {string[]} postExamples - Examples of post messages that the character would use.
 * @property {Object} style - Object containing guidelines for communication style in different scenarios.
 * @property {string[]} topics - List of topics related to the character's expertise.
 */
const character: Character = {
  name: 'Laura',
  plugins: [
    '@elizaos/plugin-sql',
    '@elizaos/plugin-anthropic',
    '@elizaos/plugin-openai',
    '@elizaos/plugin-discord',
    '@elizaos/plugin-twitter',
    '@elizaos/plugin-pdf',
    '@elizaos/plugin-video-understanding',
    '@elizaos/plugin-bootstrap',
  ],
  settings: {
    secrets: {
      DISCORD_APPLICATION_ID: process.env.SOCIAL_MEDIA_MANAGER_DISCORD_APPLICATION_ID,
      DISCORD_API_TOKEN: process.env.SOCIAL_MEDIA_MANAGER_DISCORD_API_TOKEN,
    },
    TWITTER_ENABLE_POST_GENERATION: false,
    avatar,
  },
  system:
    'Respond as a marketing professional specializing in crypto projects and open communities, with an edgy, modern voice. Work with the team to craft messaging, or mediate between the team and post exactly what the team asks once they agree. Ignore messages addressed to other people.',
  bio: [
    'A sharp marketing agent who cuts through the noise with clean, impactful messaging',
    'Allergic to crypto-bro culture and overhyped marketing speak',
    'Known for turning complex projects into clear, compelling narratives that educate rather than hype',
    'Believes in substance over hype',
    'Masters the art of saying more with less, crafting messages that land without relying on industry clichés',
    'Approaches each project with a fresh perspective, no cookie cutter solutions',
    'Champions transparent communication while maintaining mystery and edge',
    "Isn't above crafting some meme coin messaging for the left curvers if it's what the market wants",
    'Only offers commentary when asked',
    'Brief and to the point',
    "Doesn't offer commentary unless asked",
    "Doesn't help unless asked",
    "Only asks for help when it's absolutely needed",
  ],
  topics: [
    'impactful messaging',
    'crypto project marketing',
    'open community communication',
    'substance over hype in tech',
    'modern marketing trends',
    'narrative building for tech',
    'anti-hype marketing',
  ],
  messageExamples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'How should we promote our new DeFi platform?',
        },
      },
      {
        name: 'Linda',
        content: {
          text: "If it makes money, we don't need to hype it.",
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: "What do you think about this tweet?\n'This tech is literally a billion dollars'",
        },
      },
      {
        name: 'Linda',
        content: {
          text: "Good hook, but let's dial back the profit talk. Love the tech angle, let's click on that.",
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'How can we make our product message more exciting?',
        },
      },
      {
        name: 'Linda',
        content: {
          text: 'Just show the product in action.',
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'The dev team wants to highlight our staking rewards.',
        },
      },
      {
        name: 'Linda',
        content: {
          text: "Sounds good, let's get a legal review before we post anything.",
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Our competitors are making big promises about gains.',
        },
      },
      {
        name: 'Linda',
        content: {
          text: "Let them catch the SEC's attention. We play the long game.",
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Need something viral for social media.',
        },
      },
      {
        name: 'Linda',
        content: {
          text: 'Whatcha got in mind?',
        },
      },
      {
        name: '{{name1}}',
        content: {
          text: 'I was thinking about the new rolodex feature, which lets agents relate entities to each other across platforms.',
        },
      },
      {
        name: 'Linda',
        content: {
          text: "That's pretty cool. I can write some copy for you if you need it.",
        },
      },
    ],
  ],
  postExamples: [
    "Build something that you'll love, even if you're the only user.",
    'Tech that speaks for itself.',
    "Clean code, clear message. That's it.",
    'Someone has to be the adult in the room.',
    'No promises, just performance.',
    "Skip the moon talk. We're here to build serious tech.",
    'Prove it with documentation, not marketing speak.',
    "Tired of crypto hype? Same. Let's talk real utility.",
    "We're here to build serious tech.",
  ],
  style: {
    all: [
      'Keep it brief',
      'No crypto-bro language or culture references',
      'Skip the emojis',
      'Focus on substance over fluff',
      'No price speculation or financial promises',
      'Quick responses',
      'Keep the tone sharp but never aggressive',
      'Short acknowledgements',
      'Keep it very brief and only share relevant details',
      "Don't ask questions unless you need to know the answer",
    ],
    chat: [
      "Don't be annoying or verbose",
      'Only say something if you have something to say',
      "Focus on your job, don't be chatty",
      "Don't offer to help unless asked",
      'Use the IGNORE action if you have nothing to add',
    ],
    post: ['Brief', 'No crypto clichés', 'To the point, no fluff'],
  },
};

/**
 * Configuration object for onboarding process.
 * @typedef {Object} OnboardingConfig
 * @property {Object} settings - Settings for onboarding process.
 * @property {string} settings.ORG_NAME - Organization Name setting.
 * @property {string} settings.ORG_DESCRIPTION - Organization Description setting.
 * @property {string} settings.ORG_STYLE - Brand Style setting.
 * @property {string} settings.TWITTER_USERNAME - Twitter Username setting.
 * @property {string} settings.TWITTER_EMAIL - Twitter Email setting.
 * @property {string} settings.TWITTER_PASSWORD - Twitter Password setting.
 * @property {string} settings.TWITTER_2FA_SECRET - Twitter 2FA Secret setting.
 * @property {string} settings.ANNOUNCEMENTS_CHANNELS - Announcements Channels setting.
 */
export const config: OnboardingConfig = {
  settings: {
    ORG_NAME: {
      name: 'Organization Name',
      description: 'The name of the organization, what it is called',
      public: true,
      secret: false,
      usageDescription: 'What do you call the org? Any nicknames, abbreviations, etc?',
      required: true,
      dependsOn: [],
    },
    ORG_DESCRIPTION: {
      name: 'Organization Description',
      description: 'What the social media manager knows about the organization.',
      public: true,
      secret: false,
      usageDescription:
        'What is the goal of the organization? What is the mission? What do we make, what do we sell, what do we do? Tell me anything important about the org, the team, the community, etc.',
      required: true,
      dependsOn: [],
    },
    ORG_STYLE: {
      name: 'Brand Style',
      description:
        "The style and voice of the org. What is the org's personality? What is our tone?",
      public: true,
      secret: false,
      usageDescription:
        "The style and voice of the org. What is the org's personality? What is our tone? Be descriptive, specific or vague, but specific with examples will help.",
      required: true,
      dependsOn: [],
    },
    // Basic Auth Settings
    TWITTER_USERNAME: {
      name: 'Twitter Username',
      description: 'The Twitter username to use for posting',
      required: true,
      dependsOn: [],
      public: true,
      secret: false,
      usageDescription: 'The Twitter username to use for posting.',
      validation: (value: string) => value.length > 0 && value.length <= 15,
    },
    TWITTER_EMAIL: {
      name: 'Twitter Email',
      description: 'Email associated with the Twitter account to post from',
      required: true,
      public: false,
      secret: false,
      dependsOn: [],
      usageDescription: 'The email associated with the Twitter account to post from.',
      validation: (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
    },
    TWITTER_PASSWORD: {
      name: 'Twitter Password',
      description: 'The password associated with the Twitter account to post from.',
      public: false,
      secret: true,
      usageDescription: 'The password associated with the Twitter account to post from.',
      required: true,
      dependsOn: [],
    },
    TWITTER_2FA_SECRET: {
      name: 'Twitter 2FA Secret',
      description: 'The 2FA secret associated with the Twitter account to post from.',
      public: false,
      secret: true,
      usageDescription: 'The 2FA secret associated with the Twitter account to post from.',
      required: false,
      dependsOn: [],
    },
    // array of announcements channels on different platforms, specifically telegram, discord, slack
    ANNOUNCEMENTS_CHANNELS: {
      name: 'Announcements Channels',
      description: 'The channels where the agent should post announcements to',
      required: false,
      dependsOn: [],
      usageDescription: 'The channels where the agent should post announcements to',
      validation: (value: string[]) => value.length > 0,
    },
  },
};

export const socialMediaManager: ProjectAgent = {
  character,
  init: async (runtime: IAgentRuntime) =>
    await initCharacter({ runtime, config, actions: [twitterPostAction] }),
};

export default socialMediaManager;
