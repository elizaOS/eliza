/**
 * Classic ELIZA Pattern Matching Plugin
 * 
 * This plugin implements the original ELIZA pattern matching algorithm
 * from Joseph Weizenbaum's 1966 program. It uses keyword-based pattern
 * matching and transformation rules instead of an LLM.
 */

import type {
  IAgentRuntime,
  Plugin,
  GenerateTextParams,
} from "@elizaos/core";

// ELIZA patterns - classic patterns from the original implementation
interface Pattern {
  keyword: string;
  weight: number;
  rules: Array<{
    pattern: RegExp;
    responses: string[];
  }>;
}

const elizaPatterns: Pattern[] = [
  {
    keyword: "sorry",
    weight: 1,
    rules: [
      {
        pattern: /.*/,
        responses: [
          "Please don't apologize.",
          "Apologies are not necessary.",
          "What feelings do you have when you apologize?",
          "I've told you that apologies are not required."
        ]
      }
    ]
  },
  {
    keyword: "remember",
    weight: 5,
    rules: [
      {
        pattern: /do you remember (.*)/i,
        responses: [
          "Did you think I would forget $1?",
          "Why do you think I should recall $1 now?",
          "What about $1?",
          "You mentioned $1."
        ]
      },
      {
        pattern: /i remember (.*)/i,
        responses: [
          "Do you often think of $1?",
          "Does thinking of $1 bring anything else to mind?",
          "What else do you remember?",
          "Why do you remember $1 just now?",
          "What in the present situation reminds you of $1?",
          "What is the connection between me and $1?"
        ]
      }
    ]
  },
  {
    keyword: "if",
    weight: 3,
    rules: [
      {
        pattern: /if (.*)/i,
        responses: [
          "Do you think it's likely that $1?",
          "Do you wish that $1?",
          "What do you know about $1?",
          "Really, if $1?"
        ]
      }
    ]
  },
  {
    keyword: "dreamed",
    weight: 4,
    rules: [
      {
        pattern: /i dreamed (.*)/i,
        responses: [
          "Really, $1?",
          "Have you ever fantasized $1 while you were awake?",
          "Have you ever dreamed $1 before?",
          "What does that dream suggest to you?"
        ]
      }
    ]
  },
  {
    keyword: "dream",
    weight: 3,
    rules: [
      {
        pattern: /.*/,
        responses: [
          "What does that dream suggest to you?",
          "Do you dream often?",
          "What persons appear in your dreams?",
          "Do you believe that dreams have something to do with your problems?"
        ]
      }
    ]
  },
  {
    keyword: "perhaps",
    weight: 0,
    rules: [
      {
        pattern: /.*/,
        responses: [
          "You don't seem quite certain.",
          "Why the uncertain tone?",
          "Can't you be more positive?",
          "You aren't sure?",
          "Don't you know?"
        ]
      }
    ]
  },
  {
    keyword: "name",
    weight: 15,
    rules: [
      {
        pattern: /.*/,
        responses: [
          "I am not interested in names.",
          "I've told you before, I don't care about names -- please continue."
        ]
      }
    ]
  },
  {
    keyword: "hello",
    weight: 0,
    rules: [
      {
        pattern: /.*/,
        responses: [
          "How do you do. Please state your problem.",
          "Hi. What seems to be your problem?",
          "Hello. Tell me what's on your mind."
        ]
      }
    ]
  },
  {
    keyword: "computer",
    weight: 50,
    rules: [
      {
        pattern: /.*/,
        responses: [
          "Do computers worry you?",
          "Why do you mention computers?",
          "What do you think machines have to do with your problem?",
          "Don't you think computers can help people?",
          "What about machines worries you?",
          "What do you think about machines?"
        ]
      }
    ]
  },
  {
    keyword: "am",
    weight: 0,
    rules: [
      {
        pattern: /am i (.*)/i,
        responses: [
          "Do you believe you are $1?",
          "Would you want to be $1?",
          "Do you wish I would tell you you are $1?",
          "What would it mean if you were $1?"
        ]
      },
      {
        pattern: /i am (.*)/i,
        responses: [
          "Is it because you are $1 that you came to me?",
          "How long have you been $1?",
          "How do you feel about being $1?",
          "Do you enjoy being $1?",
          "Do you believe it is normal to be $1?"
        ]
      }
    ]
  },
  {
    keyword: "are",
    weight: 0,
    rules: [
      {
        pattern: /are you (.*)/i,
        responses: [
          "Why are you interested in whether I am $1 or not?",
          "Would you prefer if I weren't $1?",
          "Perhaps I am $1 in your fantasies.",
          "Do you sometimes think I am $1?"
        ]
      },
      {
        pattern: /(.*) are (.*)/i,
        responses: [
          "Did you think they might not be $2?",
          "Would you like it if they were not $2?",
          "What if they were not $2?",
          "Possibly they are $2."
        ]
      }
    ]
  },
  {
    keyword: "your",
    weight: 0,
    rules: [
      {
        pattern: /your (.*)/i,
        responses: [
          "Why are you concerned over my $1?",
          "What about your own $1?",
          "Are you worried about someone else's $1?",
          "Really, my $1?"
        ]
      }
    ]
  },
  {
    keyword: "was",
    weight: 2,
    rules: [
      {
        pattern: /was i (.*)/i,
        responses: [
          "What if you were $1?",
          "Do you think you were $1?",
          "Were you $1?",
          "What would it mean if you were $1?",
          "What does '$1' suggest to you?"
        ]
      },
      {
        pattern: /i was (.*)/i,
        responses: [
          "Were you really?",
          "Why do you tell me you were $1 now?",
          "Perhaps I already know you were $1."
        ]
      },
      {
        pattern: /was you (.*)/i,
        responses: [
          "Would you like to believe I was $1?",
          "What suggests that I was $1?",
          "What do you think?",
          "Perhaps I was $1.",
          "What if I had been $1?"
        ]
      }
    ]
  },
  {
    keyword: "i",
    weight: 0,
    rules: [
      {
        pattern: /i (?:desire|want|need) (.*)/i,
        responses: [
          "What would it mean to you if you got $1?",
          "Why do you want $1?",
          "Suppose you got $1 soon?",
          "What if you never got $1?",
          "What would getting $1 mean to you?",
          "What does wanting $1 have to do with this discussion?"
        ]
      },
      {
        pattern: /i am (?:sad|depressed|unhappy|sick)/i,
        responses: [
          "I am sorry to hear that you are $1.",
          "Do you think coming here will help you not to be $1?",
          "I'm sure it's not pleasant to be $1.",
          "Can you explain what made you $1?"
        ]
      },
      {
        pattern: /i am (?:happy|elated|glad|joyful)/i,
        responses: [
          "How have I helped you to be $1?",
          "Has your treatment made you $1?",
          "What makes you $1 just now?",
          "Can you explain why you are suddenly $1?"
        ]
      },
      {
        pattern: /i (?:believe|think) (.*)/i,
        responses: [
          "Do you really think so?",
          "But you are not sure you $1.",
          "Do you really doubt you $1?"
        ]
      },
      {
        pattern: /i was (.*)/i,
        responses: [
          "Were you really?",
          "Perhaps I already knew you were $1.",
          "Why do you tell me you were $1 now?"
        ]
      },
      {
        pattern: /i (?:feel|felt) (.*)/i,
        responses: [
          "Tell me more about such feelings.",
          "Do you often feel $1?",
          "Do you enjoy feeling $1?",
          "Of what does feeling $1 remind you?"
        ]
      },
      {
        pattern: /i can'?t (.*)/i,
        responses: [
          "How do you know that you can't $1?",
          "Have you tried?",
          "Perhaps you could $1 now.",
          "Do you really want to be able to $1?"
        ]
      },
      {
        pattern: /i don'?t (.*)/i,
        responses: [
          "Don't you really $1?",
          "Why don't you $1?",
          "Do you wish to be able to $1?",
          "Does that trouble you?"
        ]
      }
    ]
  },
  {
    keyword: "you",
    weight: 0,
    rules: [
      {
        pattern: /you remind me of (.*)/i,
        responses: [
          "What makes you think of $1?",
          "What resemblance do you see?",
          "What does that similarity suggest to you?",
          "What other connections do you see?",
          "What do you suppose that resemblance means?",
          "What is the connection, do you suppose?"
        ]
      },
      {
        pattern: /you are (.*)/i,
        responses: [
          "What makes you think I am $1?",
          "Does it please you to believe I am $1?",
          "Do you sometimes wish you were $1?",
          "Perhaps you would like to be $1."
        ]
      },
      {
        pattern: /you (.*) me/i,
        responses: [
          "Why do you think I $1 you?",
          "You like to think I $1 you -- don't you?",
          "What makes you think I $1 you?",
          "Really, I $1 you?",
          "Do you wish to believe I $1 you?",
          "Suppose I did $1 you -- what would that mean?",
          "Does someone else believe I $1 you?"
        ]
      },
      {
        pattern: /you (.*)/i,
        responses: [
          "We were discussing you -- not me.",
          "Oh, I $1?",
          "You're not really talking about me -- are you?",
          "What are your feelings now?"
        ]
      }
    ]
  },
  {
    keyword: "yes",
    weight: 0,
    rules: [
      {
        pattern: /.*/,
        responses: [
          "You seem quite positive.",
          "You are sure.",
          "I see.",
          "I understand."
        ]
      }
    ]
  },
  {
    keyword: "no",
    weight: 0,
    rules: [
      {
        pattern: /.*/,
        responses: [
          "Are you saying 'no' just to be negative?",
          "You are being a bit negative.",
          "Why not?",
          "Why 'no'?"
        ]
      }
    ]
  },
  {
    keyword: "my",
    weight: 2,
    rules: [
      {
        pattern: /my (?:mother|mom|father|dad|sister|brother|wife|husband|children|child)/i,
        responses: [
          "Tell me more about your family.",
          "Who else in your family $1?",
          "Your $1?",
          "What else comes to mind when you think of your $1?"
        ]
      },
      {
        pattern: /my (.*)/i,
        responses: [
          "Your $1?",
          "Why do you say your $1?",
          "Does that suggest anything else which belongs to you?",
          "Is it important to you that your $1?"
        ]
      }
    ]
  },
  {
    keyword: "can",
    weight: 0,
    rules: [
      {
        pattern: /can you (.*)/i,
        responses: [
          "You believe I can $1 don't you?",
          "You want me to be able to $1.",
          "Perhaps you would like to be able to $1 yourself."
        ]
      },
      {
        pattern: /can i (.*)/i,
        responses: [
          "Whether or not you can $1 depends on you more than on me.",
          "Do you want to be able to $1?",
          "Perhaps you don't want to $1."
        ]
      }
    ]
  },
  {
    keyword: "what",
    weight: 0,
    rules: [
      {
        pattern: /.*/,
        responses: [
          "Why do you ask?",
          "Does that question interest you?",
          "What is it you really want to know?",
          "Are such questions much on your mind?",
          "What answer would please you most?",
          "What do you think?",
          "What comes to your mind when you ask that?",
          "Have you asked such questions before?",
          "Have you asked anyone else?"
        ]
      }
    ]
  },
  {
    keyword: "because",
    weight: 0,
    rules: [
      {
        pattern: /.*/,
        responses: [
          "Is that the real reason?",
          "Don't any other reasons come to mind?",
          "Does that reason seem to explain anything else?",
          "What other reasons might there be?"
        ]
      }
    ]
  },
  {
    keyword: "why",
    weight: 0,
    rules: [
      {
        pattern: /why don'?t you (.*)/i,
        responses: [
          "Do you believe I don't $1?",
          "Perhaps I will $1 in good time.",
          "Should you $1 yourself?",
          "You want me to $1?"
        ]
      },
      {
        pattern: /why can'?t i (.*)/i,
        responses: [
          "Do you think you should be able to $1?",
          "Do you want to be able to $1?",
          "Do you believe this will help you to $1?",
          "Have you any idea why you can't $1?"
        ]
      },
      {
        pattern: /.*/,
        responses: [
          "Why do you ask?",
          "Does that question interest you?",
          "What is it you really want to know?",
          "Are such questions much on your mind?",
          "What answer would please you most?",
          "What do you think?",
          "What comes to mind when you ask that?",
          "Have you asked such questions before?"
        ]
      }
    ]
  },
  {
    keyword: "everyone",
    weight: 2,
    rules: [
      {
        pattern: /.*/,
        responses: [
          "Really, everyone?",
          "Surely not everyone.",
          "Can you think of anyone in particular?",
          "Who, for example?",
          "Are you thinking of a very special person?",
          "Who, may I ask?",
          "Someone special perhaps?",
          "You have a particular person in mind, don't you?",
          "Who do you think you're talking about?"
        ]
      }
    ]
  },
  {
    keyword: "always",
    weight: 1,
    rules: [
      {
        pattern: /.*/,
        responses: [
          "Can you think of a specific example?",
          "When?",
          "What incident are you thinking of?",
          "Really, always?"
        ]
      }
    ]
  },
  {
    keyword: "alike",
    weight: 10,
    rules: [
      {
        pattern: /.*/,
        responses: [
          "In what way?",
          "What resemblance do you see?",
          "What does that similarity suggest to you?",
          "What other connections do you see?",
          "What do you suppose that resemblance means?",
          "What is the connection, do you suppose?",
          "Could there really be some connection?",
          "How?"
        ]
      }
    ]
  },
  {
    keyword: "like",
    weight: 10,
    rules: [
      {
        pattern: /.*(?:am|is|are|was) like.*/i,
        responses: [
          "In what way?",
          "What resemblance do you see?",
          "What does that similarity suggest to you?",
          "What other connections do you see?",
          "What do you suppose that resemblance means?",
          "What is the connection, do you suppose?",
          "Could there really be some connection?",
          "How?"
        ]
      }
    ]
  }
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
  "Interesting. Please go on."
];

// Response history for avoiding repetition
const responseHistory: string[] = [];
const MAX_HISTORY = 10;

/**
 * Get a random response that hasn't been used recently
 */
function getRandomResponse(responses: string[]): string {
  // Filter out recently used responses
  const availableResponses = responses.filter(r => !responseHistory.includes(r));
  const pool = availableResponses.length > 0 ? availableResponses : responses;
  
  const response = pool[Math.floor(Math.random() * pool.length)];
  
  // Add to history
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
    "am": "are",
    "was": "were",
    "i": "you",
    "i'd": "you would",
    "i've": "you have",
    "i'll": "you will",
    "my": "your",
    "are": "am",
    "you've": "I have",
    "you'll": "I will",
    "your": "my",
    "yours": "mine",
    "you": "me",
    "me": "you",
    "myself": "yourself",
    "yourself": "myself",
    "i'm": "you are"
  };
  
  const words = text.toLowerCase().split(/\s+/);
  const reflected = words.map(word => reflections[word] || word);
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
  const matches: Array<{ pattern: Pattern; rule: (typeof elizaPatterns)[0]["rules"][0] }> = [];
  
  for (const pattern of elizaPatterns) {
    if (normalizedInput.includes(pattern.keyword)) {
      for (const rule of pattern.rules) {
        if (rule.pattern.test(normalizedInput)) {
          matches.push({ pattern, rule });
        }
      }
    }
  }
  
  if (matches.length > 0) {
    // Sort by weight (higher weight = higher priority)
    matches.sort((a, b) => b.pattern.weight - a.pattern.weight);
    const best = matches[0];
    
    // Get a random response template
    let response = getRandomResponse(best.rule.responses);
    
    // Extract captured groups and substitute
    const match = normalizedInput.match(best.rule.pattern);
    if (match) {
      for (let i = 1; i < match.length; i++) {
        const captured = match[i] ? reflect(match[i]) : "";
        response = response.replace(`$${i}`, captured);
      }
    }
    
    // Clean up any remaining placeholders
    response = response.replace(/\$\d+/g, "that");
    
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
  // Extract the user's message from the prompt
  // The prompt typically contains context + "User: <message>\nAgent:"
  const prompt = params.prompt || "";
  
  // Try to extract the last user message
  let userMessage = prompt;
  
  // Look for patterns like "User: message" or the last line before "Agent:"
  const userMatch = prompt.match(/User:\s*([^\n]+?)(?:\n|$)/i);
  if (userMatch) {
    userMessage = userMatch[1].trim();
  } else {
    // Just use the last meaningful line
    const lines = prompt.split("\n").filter(l => l.trim());
    userMessage = lines[lines.length - 1] || prompt;
  }
  
  // Clean up any agent prefix
  userMessage = userMessage.replace(/^(You|Eliza|Assistant|Agent):\s*/i, "").trim();
  
  return generateElizaResponse(userMessage);
}

/**
 * Simple embedding handler that returns a zero vector
 * (ELIZA doesn't need real embeddings, but the system might request them)
 */
async function handleEmbedding(
  _runtime: IAgentRuntime,
  params: { text: string } | string | null
): Promise<number[]> {
  // Return a simple hash-based pseudo-embedding (384 dimensions to match common models)
  const text = typeof params === "string" ? params : params?.text || "";
  const dimensions = 384;
  const embedding = new Array(dimensions).fill(0);
  
  // Simple deterministic pseudo-embedding based on character codes
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    embedding[i % dimensions] += charCode / 1000;
  }
  
  // Normalize
  const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  if (magnitude > 0) {
    for (let i = 0; i < dimensions; i++) {
      embedding[i] /= magnitude;
    }
  }
  
  return embedding;
}

/**
 * Classic ELIZA Plugin
 * 
 * Provides TEXT_SMALL and TEXT_LARGE model handlers that use
 * the original ELIZA pattern matching algorithm instead of an LLM.
 */
export const elizaClassicPlugin: Plugin = {
  name: "eliza-classic",
  description: "Classic ELIZA pattern matching for text generation (no LLM required)",
  
  models: {
    TEXT_SMALL: handleElizaText,
    TEXT_LARGE: handleElizaText,
    TEXT_EMBEDDING: handleEmbedding,
  },
};

export default elizaClassicPlugin;
export { generateElizaResponse };

