import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { SamTTSService, type SamTTSOptions } from '../services/SamTTSService';

/**
 * SAY_ALOUD Action
 *
 * Makes the agent speak text aloud using the SAM speech synthesizer.
 * The audio is sent through the hardware bridge to the user's speakers.
 */
export const sayAloudAction: Action = {
  name: 'SAY_ALOUD',
  description: 'Make the agent speak text aloud using SAM retro speech synthesizer',

  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Can you say hello out loud?' },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll say hello using my SAM voice.",
          action: 'SAY_ALOUD',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Please read this message aloud: Welcome to ElizaOS' },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll read that message aloud for you now.",
          action: 'SAY_ALOUD',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Speak in a higher voice' },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll adjust my voice settings and speak in a higher pitch.",
          action: 'SAY_ALOUD',
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const text = message.content.text.toLowerCase();

    // Trigger words and phrases for speech synthesis
    const speechTriggers = [
      'say aloud',
      'speak',
      'read aloud',
      'say out loud',
      'voice',
      'speak this',
      'say this',
      'read this',
      'announce',
      'proclaim',
      'tell everyone',
      'speak up',
      'use your voice',
      'talk to me',
      'higher voice',
      'lower voice',
      'change voice',
      'robotic voice',
      'retro voice',
    ];

    // Check if message contains speech-related triggers
    const hasSpeechTrigger = speechTriggers.some((trigger) => text.includes(trigger));

    // Also check if the user is asking agent to vocalize something
    const hasVocalizationIntent =
      text.includes('can you say') ||
      text.includes('please say') ||
      text.includes('i want to hear') ||
      text.includes('let me hear') ||
      text.match(/say ["'].*["']/) !== null ||
      text.match(/speak ["'].*["']/) !== null;

    return hasSpeechTrigger || hasVocalizationIntent;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<void> => {
    logger.info('[SAY_ALOUD] Processing speech request...');

    // Get SAM TTS service
    const samService = (runtime as { getService: (serviceType: string) => unknown }).getService(
      'SAM_TTS'
    ) as SamTTSService | null;

    if (!samService) {
      logger.warn('[SAY_ALOUD] SAM TTS service not available');
      callback({
        text: 'Sorry, I cannot speak aloud right now. The text-to-speech service is not available.',
        action: 'SAY_ALOUD',
        error: 'SAM TTS service not available',
      });
      return;
    }

    // Extract text to speak from the message
    const textToSpeak = extractTextToSpeak(message.content.text);

    // Extract voice options from the message
    const voiceOptions = extractVoiceOptions(message.content.text);

    logger.info(`[SAY_ALOUD] Speaking: "${textToSpeak}"`);
    logger.info('[SAY_ALOUD] Voice options:', voiceOptions);

    // Synthesize and play the speech
    const audioBuffer = await samService.speakText(textToSpeak, voiceOptions);

    logger.info('[SAY_ALOUD] ✅ Speech synthesis completed successfully');

    callback({
      text: `I spoke aloud using my SAM voice: "${textToSpeak}"`,
      action: 'SAY_ALOUD',
      audioData: Array.from(audioBuffer), // Convert Uint8Array to regular array for JSON
    });
  },
};

/**
 * Extract text to speak from user message
 */
function extractTextToSpeak(messageText: string): string {
  // Clean the input
  const text = messageText.toLowerCase().trim();

  // Patterns to extract quoted text
  const quotedPatterns = [
    /say ["']([^"']+)["']/,
    /speak ["']([^"']+)["']/,
    /read ["']([^"']+)["']/,
    /announce ["']([^"']+)["']/,
    /["']([^"']+)["']/,
  ];

  // Try to find quoted text first
  for (const pattern of quotedPatterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1];
    }
  }

  // Patterns to extract text after keywords
  const afterKeywordPatterns = [
    /(?:say|speak|read)\s+(?:aloud\s+)?(?:this\s+)?:?\s*(.+)$/,
    /(?:can you|please)\s+(?:say|speak|read)\s+(?:aloud\s+)?(.+)$/,
    /(?:i want to hear|let me hear)\s+(.+)$/,
    /(?:read this|say this|speak this)\s*:?\s*(.+)$/,
  ];

  // Try to find text after keywords
  for (const pattern of afterKeywordPatterns) {
    const match = text.match(pattern);
    if (match) {
      let extractedText = match[1].trim();

      // Clean up common trailing words
      extractedText = extractedText
        .replace(/\s+out loud$/, '')
        .replace(/\s+aloud$/, '')
        .replace(/\s+please$/, '')
        .trim();

      return extractedText;
    }
  }

  // If no specific text found but speech is requested, use a default response
  const speechKeywords = ['say aloud', 'speak', 'use your voice', 'talk to me'];
  if (speechKeywords.some((keyword) => text.includes(keyword))) {
    return 'Hello! I am speaking using my SAM voice synthesizer.';
  }

  return '';
}

/**
 * Extract voice configuration options from user message
 */
function extractVoiceOptions(messageText: string): SamTTSOptions {
  const text = messageText.toLowerCase();
  const options: SamTTSOptions = {};

  // Pitch modifications
  if (text.includes('higher voice') || text.includes('high pitch') || text.includes('squeaky')) {
    options.pitch = 100; // Higher pitch
  } else if (
    text.includes('lower voice') ||
    text.includes('low pitch') ||
    text.includes('deep voice')
  ) {
    options.pitch = 30; // Lower pitch
  }

  // Speed modifications
  if (text.includes('faster') || text.includes('quickly') || text.includes('speed up')) {
    options.speed = 120; // Faster speech
  } else if (text.includes('slower') || text.includes('slowly') || text.includes('slow down')) {
    options.speed = 40; // Slower speech
  }

  // Voice character modifications
  if (text.includes('robotic') || text.includes('robot voice')) {
    options.throat = 200; // More robotic
    options.mouth = 50; // Sharper articulation
  } else if (text.includes('smooth') || text.includes('natural')) {
    options.throat = 100; // Smoother
    options.mouth = 150; // Softer articulation
  }

  return options;
}
