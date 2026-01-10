/**
 * Classic ELIZA Pattern Matching Plugin for elizaOS
 *
 * This plugin provides TEXT_SMALL, TEXT_LARGE, and TEXT_EMBEDDING handlers
 * using the original ELIZA pattern matching algorithm from 1966.
 * No LLM required - pure pattern matching and substitution.
 */

import type {
  IAgentRuntime,
  Plugin,
  GenerateTextParams,
} from "@elizaos/core";

// Pattern definition
interface PatternRule {
  keyword: string;
  weight: number;
  decompositions: Array<{
    pattern: RegExp;
    reassemblies: string[];
  }>;
}

// Classic ELIZA patterns based on Weizenbaum's original implementation
const elizaPatterns: PatternRule[] = [
  {
    keyword: "sorry",
    weight: 1,
    decompositions: [
      {
        pattern: /.*/,
        reassemblies: [
          "Please don't apologize.",
          "Apologies are not necessary.",
          "What feelings do you have when you apologize?",
          "I've told you that apologies are not required.",
        ],
      },
    ],
  },
  {
    keyword: "remember",
    weight: 5,
    decompositions: [
      {
        pattern: /do you remember (.*)/i,
        reassemblies: [
          "Did you think I would forget (1)?",
          "Why do you think I should recall (1) now?",
          "What about (1)?",
          "You mentioned (1).",
        ],
      },
      {
        pattern: /i remember (.*)/i,
        reassemblies: [
          "Do you often think of (1)?",
          "Does thinking of (1) bring anything else to mind?",
          "What else do you remember?",
          "Why do you remember (1) just now?",
          "What in the present situation reminds you of (1)?",
        ],
      },
      {
        pattern: /.*/,
        reassemblies: [
          "Do you often think of that?",
          "What else do you remember?",
          "Why do you remember that just now?",
        ],
      },
    ],
  },
  {
    keyword: "if",
    weight: 3,
    decompositions: [
      {
        pattern: /if (.*)/i,
        reassemblies: [
          "Do you think it's likely that (1)?",
          "Do you wish that (1)?",
          "What do you know about (1)?",
          "Really, if (1)?",
        ],
      },
    ],
  },
  {
    keyword: "dreamed",
    weight: 4,
    decompositions: [
      {
        pattern: /i dreamed (.*)/i,
        reassemblies: [
          "Really, (1)?",
          "Have you ever fantasized (1) while you were awake?",
          "Have you ever dreamed (1) before?",
        ],
      },
    ],
  },
  {
    keyword: "dream",
    weight: 3,
    decompositions: [
      {
        pattern: /.*/,
        reassemblies: [
          "What does that dream suggest to you?",
          "Do you dream often?",
          "What persons appear in your dreams?",
          "Do you believe that dreams have something to do with your problems?",
        ],
      },
    ],
  },
  {
    keyword: "perhaps",
    weight: 0,
    decompositions: [
      {
        pattern: /.*/,
        reassemblies: [
          "You don't seem quite certain.",
          "Why the uncertain tone?",
          "Can't you be more positive?",
          "You aren't sure?",
          "Don't you know?",
        ],
      },
    ],
  },
  {
    keyword: "name",
    weight: 15,
    decompositions: [
      {
        pattern: /.*/,
        reassemblies: [
          "I am not interested in names.",
          "I've told you before, I don't care about names -- please continue.",
        ],
      },
    ],
  },
  {
    keyword: "hello",
    weight: 0,
    decompositions: [
      {
        pattern: /.*/,
        reassemblies: [
          "How do you do. Please state your problem.",
          "Hi. What seems to be your problem?",
          "Hello. Tell me what's on your mind.",
        ],
      },
    ],
  },
  {
    keyword: "computer",
    weight: 50,
    decompositions: [
      {
        pattern: /.*/,
        reassemblies: [
          "Do computers worry you?",
          "Why do you mention computers?",
          "What do you think machines have to do with your problem?",
          "Don't you think computers can help people?",
          "What about machines worries you?",
          "What do you think about machines?",
        ],
      },
    ],
  },
  {
    keyword: "am",
    weight: 0,
    decompositions: [
      {
        pattern: /am i (.*)/i,
        reassemblies: [
          "Do you believe you are (1)?",
          "Would you want to be (1)?",
          "Do you wish I would tell you you are (1)?",
          "What would it mean if you were (1)?",
        ],
      },
      {
        pattern: /i am (.*)/i,
        reassemblies: [
          "Is it because you are (1) that you came to me?",
          "How long have you been (1)?",
          "How do you feel about being (1)?",
          "Do you enjoy being (1)?",
          "Do you believe it is normal to be (1)?",
        ],
      },
    ],
  },
  {
    keyword: "are",
    weight: 0,
    decompositions: [
      {
        pattern: /are you (.*)/i,
        reassemblies: [
          "Why are you interested in whether I am (1) or not?",
          "Would you prefer if I weren't (1)?",
          "Perhaps I am (1) in your fantasies.",
          "Do you sometimes think I am (1)?",
        ],
      },
      {
        pattern: /(.*) are (.*)/i,
        reassemblies: [
          "Did you think they might not be (2)?",
          "Would you like it if they were not (2)?",
          "What if they were not (2)?",
          "Possibly they are (2).",
        ],
      },
    ],
  },
  {
    keyword: "your",
    weight: 0,
    decompositions: [
      {
        pattern: /your (.*)/i,
        reassemblies: [
          "Why are you concerned over my (1)?",
          "What about your own (1)?",
          "Are you worried about someone else's (1)?",
          "Really, my (1)?",
        ],
      },
    ],
  },
  {
    keyword: "was",
    weight: 2,
    decompositions: [
      {
        pattern: /was i (.*)/i,
        reassemblies: [
          "What if you were (1)?",
          "Do you think you were (1)?",
          "Were you (1)?",
          "What would it mean if you were (1)?",
        ],
      },
      {
        pattern: /i was (.*)/i,
        reassemblies: [
          "Were you really?",
          "Why do you tell me you were (1) now?",
          "Perhaps I already know you were (1).",
        ],
      },
    ],
  },
  {
    keyword: "i",
    weight: 0,
    decompositions: [
      {
        pattern: /i (?:desire|want|need) (.*)/i,
        reassemblies: [
          "What would it mean to you if you got (1)?",
          "Why do you want (1)?",
          "Suppose you got (1) soon?",
          "What if you never got (1)?",
          "What would getting (1) mean to you?",
        ],
      },
      {
        pattern: /i am (?:sad|depressed|unhappy|sick)/i,
        reassemblies: [
          "I am sorry to hear that you are feeling that way.",
          "Do you think coming here will help you not to feel that way?",
          "I'm sure it's not pleasant to feel that way.",
          "Can you explain what made you feel this way?",
        ],
      },
      {
        pattern: /i am (?:happy|elated|glad|joyful)/i,
        reassemblies: [
          "How have I helped you to feel that way?",
          "Has your treatment made you feel that way?",
          "What makes you feel that way just now?",
          "Can you explain why you are suddenly feeling that way?",
        ],
      },
      {
        pattern: /i (?:believe|think) (.*)/i,
        reassemblies: [
          "Do you really think so?",
          "But you are not sure you (1).",
          "Do you really doubt you (1)?",
        ],
      },
      {
        pattern: /i (?:feel|felt) (.*)/i,
        reassemblies: [
          "Tell me more about such feelings.",
          "Do you often feel (1)?",
          "Do you enjoy feeling (1)?",
          "Of what does feeling (1) remind you?",
        ],
      },
      {
        pattern: /i can'?t (.*)/i,
        reassemblies: [
          "How do you know that you can't (1)?",
          "Have you tried?",
          "Perhaps you could (1) now.",
          "Do you really want to be able to (1)?",
        ],
      },
      {
        pattern: /i don'?t (.*)/i,
        reassemblies: [
          "Don't you really (1)?",
          "Why don't you (1)?",
          "Do you wish to be able to (1)?",
          "Does that trouble you?",
        ],
      },
    ],
  },
  {
    keyword: "you",
    weight: 0,
    decompositions: [
      {
        pattern: /you remind me of (.*)/i,
        reassemblies: [
          "What makes you think of (1)?",
          "What resemblance do you see?",
          "What does that similarity suggest to you?",
          "What other connections do you see?",
        ],
      },
      {
        pattern: /you are (.*)/i,
        reassemblies: [
          "What makes you think I am (1)?",
          "Does it please you to believe I am (1)?",
          "Do you sometimes wish you were (1)?",
          "Perhaps you would like to be (1).",
        ],
      },
      {
        pattern: /you (.*) me/i,
        reassemblies: [
          "Why do you think I (1) you?",
          "You like to think I (1) you -- don't you?",
          "What makes you think I (1) you?",
          "Really, I (1) you?",
        ],
      },
      {
        pattern: /.*/,
        reassemblies: [
          "We were discussing you -- not me.",
          "Oh, I?",
          "You're not really talking about me -- are you?",
          "What are your feelings now?",
        ],
      },
    ],
  },
  {
    keyword: "yes",
    weight: 0,
    decompositions: [
      {
        pattern: /.*/,
        reassemblies: [
          "You seem quite positive.",
          "You are sure.",
          "I see.",
          "I understand.",
        ],
      },
    ],
  },
  {
    keyword: "no",
    weight: 0,
    decompositions: [
      {
        pattern: /.*/,
        reassemblies: [
          "Are you saying 'no' just to be negative?",
          "You are being a bit negative.",
          "Why not?",
          "Why 'no'?",
        ],
      },
    ],
  },
  {
    keyword: "my",
    weight: 2,
    decompositions: [
      {
        pattern: /my (?:mother|mom)/i,
        reassemblies: [
          "Tell me more about your mother.",
          "What was your relationship with your mother like?",
          "How do you feel about your mother?",
          "Does this have anything to do with your mother?",
        ],
      },
      {
        pattern: /my (?:father|dad)/i,
        reassemblies: [
          "Tell me more about your father.",
          "How did your father treat you?",
          "How do you feel about your father?",
          "Does your relationship with your father relate to your feelings today?",
        ],
      },
      {
        pattern: /my (?:sister|brother|sibling)/i,
        reassemblies: [
          "Tell me more about your family.",
          "How do you get along with your siblings?",
          "What role does family play in your feelings?",
        ],
      },
      {
        pattern: /my (.*)/i,
        reassemblies: [
          "Your (1)?",
          "Why do you say your (1)?",
          "Does that suggest anything else which belongs to you?",
          "Is it important to you that your (1)?",
        ],
      },
    ],
  },
  {
    keyword: "can",
    weight: 0,
    decompositions: [
      {
        pattern: /can you (.*)/i,
        reassemblies: [
          "You believe I can (1) don't you?",
          "You want me to be able to (1).",
          "Perhaps you would like to be able to (1) yourself.",
        ],
      },
      {
        pattern: /can i (.*)/i,
        reassemblies: [
          "Whether or not you can (1) depends on you more than on me.",
          "Do you want to be able to (1)?",
          "Perhaps you don't want to (1).",
        ],
      },
    ],
  },
  {
    keyword: "what",
    weight: 0,
    decompositions: [
      {
        pattern: /.*/,
        reassemblies: [
          "Why do you ask?",
          "Does that question interest you?",
          "What is it you really want to know?",
          "Are such questions much on your mind?",
          "What answer would please you most?",
          "What do you think?",
          "What comes to your mind when you ask that?",
        ],
      },
    ],
  },
  {
    keyword: "because",
    weight: 0,
    decompositions: [
      {
        pattern: /.*/,
        reassemblies: [
          "Is that the real reason?",
          "Don't any other reasons come to mind?",
          "Does that reason seem to explain anything else?",
          "What other reasons might there be?",
        ],
      },
    ],
  },
  {
    keyword: "why",
    weight: 0,
    decompositions: [
      {
        pattern: /why don'?t you (.*)/i,
        reassemblies: [
          "Do you believe I don't (1)?",
          "Perhaps I will (1) in good time.",
          "Should you (1) yourself?",
          "You want me to (1)?",
        ],
      },
      {
        pattern: /why can'?t i (.*)/i,
        reassemblies: [
          "Do you think you should be able to (1)?",
          "Do you want to be able to (1)?",
          "Do you believe this will help you to (1)?",
          "Have you any idea why you can't (1)?",
        ],
      },
      {
        pattern: /.*/,
        reassemblies: [
          "Why do you ask?",
          "Does that question interest you?",
          "What is it you really want to know?",
          "Are such questions much on your mind?",
          "What answer would please you most?",
        ],
      },
    ],
  },
  {
    keyword: "everyone",
    weight: 2,
    decompositions: [
      {
        pattern: /.*/,
        reassemblies: [
          "Really, everyone?",
          "Surely not everyone.",
          "Can you think of anyone in particular?",
          "Who, for example?",
          "Are you thinking of a very special person?",
        ],
      },
    ],
  },
  {
    keyword: "always",
    weight: 1,
    decompositions: [
      {
        pattern: /.*/,
        reassemblies: [
          "Can you think of a specific example?",
          "When?",
          "What incident are you thinking of?",
          "Really, always?",
        ],
      },
    ],
  },
  {
    keyword: "alike",
    weight: 10,
    decompositions: [
      {
        pattern: /.*/,
        reassemblies: [
          "In what way?",
          "What resemblance do you see?",
          "What does that similarity suggest to you?",
          "What other connections do you see?",
          "What do you suppose that resemblance means?",
          "What is the connection, do you suppose?",
          "Could there really be some connection?",
          "How?",
        ],
      },
    ],
  },
];

// Default responses when no pattern matches
const defaultResponses = [
  "Very interesting.",
  "I am not sure I understand you fully.",
  "What does that suggest to you?",
  "Please continue.",
  "Go on.",
  "Do you feel strongly about discussing such things?",
  "Tell me more.",
  "That is quite interesting.",
  "Can you elaborate on that?",
  "Why do you say that?",
  "I see.",
  "What does that mean to you?",
  "How does that make you feel?",
  "Let's explore that further.",
  "Interesting. Please go on.",
];

// Response history for avoiding repetition
const responseHistory: string[] = [];
const MAX_HISTORY = 10;

/**
 * Get a random response that hasn't been used recently
 */
function getRandomResponse(responses: string[]): string {
  const available = responses.filter((r) => !responseHistory.includes(r));
  const pool = available.length > 0 ? available : responses;

  const response = pool[Math.floor(Math.random() * pool.length)];

  responseHistory.push(response);
  if (responseHistory.length > MAX_HISTORY) {
    responseHistory.shift();
  }

  return response;
}

/**
 * Reflect pronouns in captured text (I -> you, my -> your, etc.)
 */
function reflect(text: string): string {
  const reflections: Record<string, string> = {
    am: "are",
    was: "were",
    i: "you",
    "i'd": "you would",
    "i've": "you have",
    "i'll": "you will",
    my: "your",
    are: "am",
    "you've": "I have",
    "you'll": "I will",
    your: "my",
    yours: "mine",
    you: "me",
    me: "you",
    myself: "yourself",
    yourself: "myself",
    "i'm": "you are",
  };

  const words = text.toLowerCase().split(/\s+/);
  const reflected = words.map((word) => reflections[word] || word);
  return reflected.join(" ");
}

/**
 * Process input and generate ELIZA-style response
 */
function generateElizaResponse(input: string): string {
  const normalizedInput = input.toLowerCase().trim();

  if (!normalizedInput) {
    return "I didn't catch that. Could you please repeat?";
  }

  // Find all matching patterns
  const matches: Array<{
    pattern: PatternRule;
    decomposition: PatternRule["decompositions"][0];
    match: RegExpMatchArray | null;
  }> = [];

  for (const pattern of elizaPatterns) {
    if (normalizedInput.includes(pattern.keyword)) {
      for (const decomposition of pattern.decompositions) {
        const match = normalizedInput.match(decomposition.pattern);
        if (match) {
          matches.push({ pattern, decomposition, match });
        }
      }
    }
  }

  if (matches.length > 0) {
    // Sort by weight (higher weight = higher priority)
    matches.sort((a, b) => b.pattern.weight - a.pattern.weight);
    const best = matches[0];

    // Get a random response template
    let response = getRandomResponse(best.decomposition.reassemblies);

    // Substitute captured groups with reflected pronouns
    if (best.match) {
      for (let i = 1; i < best.match.length; i++) {
        const captured = best.match[i] ? reflect(best.match[i].trim()) : "";
        response = response.replace(`(${i})`, captured);
      }
    }

    // Clean up any remaining placeholders
    response = response.replace(/\(\d+\)/g, "that");

    return response;
  }

  // No pattern matched, use default response
  return getRandomResponse(defaultResponses);
}

/**
 * Handle TEXT_SMALL and TEXT_LARGE model requests with ELIZA-style responses
 */
async function handleElizaText(
  _runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string> {
  const prompt = params.prompt || "";

  // Extract the user's message from the prompt
  // The prompt typically contains context + "User: <message>" or similar
  let userMessage = prompt;

  // Look for the last user message in various formats
  const patterns = [
    /User:\s*([^\n]+?)(?:\n|$)/gi,
    /Human:\s*([^\n]+?)(?:\n|$)/gi,
    /You:\s*([^\n]+?)(?:\n|$)/gi,
  ];

  for (const pattern of patterns) {
    const matches = [...prompt.matchAll(pattern)];
    if (matches.length > 0) {
      // Get the last match
      const lastMatch = matches[matches.length - 1];
      userMessage = lastMatch[1].trim();
      break;
    }
  }

  // If no pattern matched, use the last line
  if (userMessage === prompt) {
    const lines = prompt.split("\n").filter((l) => l.trim());
    userMessage = lines[lines.length - 1] || prompt;
  }

  // Clean up any agent prefix
  userMessage = userMessage
    .replace(/^(You|Eliza|Assistant|Agent):\s*/i, "")
    .trim();

  return generateElizaResponse(userMessage);
}

/**
 * Simple embedding handler that returns a deterministic pseudo-embedding
 * ELIZA doesn't need real embeddings, but the system might request them
 */
async function handleEmbedding(
  _runtime: IAgentRuntime,
  params: { text: string } | string | null
): Promise<number[]> {
  const text = typeof params === "string" ? params : params?.text || "";
  const dimensions = 384;
  const embedding = new Array(dimensions).fill(0);

  // Simple deterministic pseudo-embedding based on character codes
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    embedding[i % dimensions] += charCode / 1000;
  }

  // Normalize
  const magnitude = Math.sqrt(
    embedding.reduce((sum, val) => sum + val * val, 0)
  );
  if (magnitude > 0) {
    for (let i = 0; i < dimensions; i++) {
      embedding[i] /= magnitude;
    }
  }

  return embedding;
}

/**
 * Classic ELIZA Plugin for elizaOS
 *
 * Provides TEXT_SMALL, TEXT_LARGE, and TEXT_EMBEDDING handlers using
 * the original ELIZA pattern matching algorithm instead of an LLM.
 */
export const elizaPlugin: Plugin = {
  name: "eliza-classic",
  description:
    "Classic ELIZA pattern matching for text generation (no LLM required)",

  models: {
    TEXT_SMALL: handleElizaText,
    TEXT_LARGE: handleElizaText,
    TEXT_EMBEDDING: handleEmbedding,
  },
};

export default elizaPlugin;
export { generateElizaResponse };

