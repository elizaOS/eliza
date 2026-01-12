import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { SamTTSService } from "../services/SamTTSService";
import { type SamTTSOptions, SPEECH_TRIGGERS, VOCALIZATION_PATTERNS } from "../types";

function extractTextToSpeak(messageText: string): string {
  const text = messageText.toLowerCase().trim();

  const quotedPatterns = [
    /say ["']([^"']+)["']/,
    /speak ["']([^"']+)["']/,
    /read ["']([^"']+)["']/,
    /announce ["']([^"']+)["']/,
    /["']([^"']+)["']/,
  ];

  for (const pattern of quotedPatterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }

  const keywordPatterns = [
    /(?:say|speak|read)\s+(?:aloud\s+)?(?:this\s+)?:?\s*(.+)$/,
    /(?:can you|please)\s+(?:say|speak|read)\s+(?:aloud\s+)?(.+)$/,
    /(?:i want to hear|let me hear)\s+(.+)$/,
    /(?:read this|say this|speak this)\s*:?\s*(.+)$/,
  ];

  for (const pattern of keywordPatterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1]
        .replace(/\s+out loud$/, "")
        .replace(/\s+aloud$/, "")
        .replace(/\s+please$/, "")
        .trim();
    }
  }

  return text;
}

function extractVoiceOptions(messageText: string): Partial<SamTTSOptions> {
  const text = messageText.toLowerCase();
  const options: Partial<SamTTSOptions> = {};

  if (text.includes("higher voice") || text.includes("high pitch") || text.includes("squeaky")) {
    options.pitch = 100;
  } else if (
    text.includes("lower voice") ||
    text.includes("low pitch") ||
    text.includes("deep voice")
  ) {
    options.pitch = 30;
  }

  if (text.includes("faster") || text.includes("quickly") || text.includes("speed up")) {
    options.speed = 120;
  } else if (text.includes("slower") || text.includes("slowly") || text.includes("slow down")) {
    options.speed = 40;
  }

  if (text.includes("robotic") || text.includes("robot voice")) {
    options.throat = 200;
    options.mouth = 50;
  } else if (text.includes("smooth") || text.includes("natural")) {
    options.throat = 100;
    options.mouth = 150;
  }

  return options;
}

export const sayAloudAction: Action = {
  name: "SAY_ALOUD",
  description: "Speak text aloud using SAM retro speech synthesizer",

  examples: [
    [
      { name: "{{user1}}", content: { text: "Can you say hello out loud?" } },
      {
        name: "{{agent}}",
        content: {
          text: "I'll say hello using my SAM voice.",
          action: "SAY_ALOUD",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Please read this message aloud: Welcome to ElizaOS" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll read that message aloud for you now.",
          action: "SAY_ALOUD",
        },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "Speak in a higher voice" } },
      {
        name: "{{agent}}",
        content: { text: "I'll speak in a higher pitch.", action: "SAY_ALOUD" },
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const text = message.content.text.toLowerCase();

    const hasTrigger = SPEECH_TRIGGERS.some((trigger) => text.includes(trigger));
    const hasIntent =
      VOCALIZATION_PATTERNS.some((pattern) => text.includes(pattern)) ||
      /say ["'].*["']/.test(text) ||
      /speak ["'].*["']/.test(text);

    return hasTrigger || hasIntent;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    logger.info("[SAY_ALOUD] Processing speech request");

    const samService = runtime.getService("SAM_TTS") as SamTTSService;

    const textToSpeak = extractTextToSpeak(message.content.text);
    const voiceOptions = extractVoiceOptions(message.content.text);

    logger.info(`[SAY_ALOUD] Speaking: "${textToSpeak}"`);

    const audioBuffer = await samService.speakText(textToSpeak, voiceOptions);

    callback?.({
      text: `I spoke: "${textToSpeak}"`,
      action: "SAY_ALOUD",
      audioData: Array.from(audioBuffer),
    });

    return { success: true, text: `Spoke: "${textToSpeak}"` };
  },
};
