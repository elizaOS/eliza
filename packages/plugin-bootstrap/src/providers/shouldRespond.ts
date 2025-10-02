import type { IAgentRuntime, Memory, Provider } from '@elizaos/core';
import { addHeader } from '@elizaos/core';
import { type Config, adjectives, names, uniqueNamesGenerator } from 'unique-names-generator';

// Configuration for name generation
const nameConfig: Config = {
  dictionaries: [adjectives, names],
  separator: '',
  length: 2,
  style: 'capital',
};

// Example messages to determine if the agent should respond
/**
 * Array of message examples that the agent should respond to, ignore, or stop based on the content.
 * Each message example includes the sender's name, agent's name, and the expected response type.
 * Examples can include requests for help, questions, stories, or simple interactions like saying "marco".
 */
/**
 * Array of message examples to determine the agent response.
 * Each message example includes a conversation between the user and the agent,
 * as well as the expected response action for the agent (RESPOND, IGNORE, STOP).
 */
const messageExamples = [
  // ═══════════════════════════════════════════════════════
  // RESPOND - Direct mentions and addressing
  // ═══════════════════════════════════════════════════════

  `// {{name1}}: Hey {{agentName}}, can you help me with something
// Response: RESPOND`,

  `// {{name1}}: {{agentName}} what do you think about this?
// Response: RESPOND`,

  `// {{name1}}: yo {{agentName}}, quick question
// Response: RESPOND`,

  `// {{name1}}: @{{agentName}} are you there?
// Response: RESPOND`,

  // Mentions with typos or variations
  `// {{name1}}: Hey {{agentName}}x, how are you? (slight typo in name)
// Response: RESPOND`,

  `// {{name1}}: hey {{agentName}} you around?
// Response: RESPOND`,

  // ═══════════════════════════════════════════════════════
  // RESPOND - Continuations of conversation
  // ═══════════════════════════════════════════════════════

  `// {{name1}}: Hey {{agentName}}, can I ask you a question
// {{agentName}}: Sure, what is it
// {{name1}}: can you help me create a basic react module that demonstrates a counter
// Response: RESPOND`,

  `// {{agentName}}: Here's my answer to your question
// {{name1}}: Thanks! That really helps
// Response: RESPOND`,

  `// {{name1}}: okay, i want to test something. can you say marco?
// {{agentName}}: marco
// {{name1}}: great. okay, now do it again
// Response: RESPOND`,

  `// {{name1}}: {{agentName}} can you tell me a story
// {{name1}}: about a girl named {{characterName}}
// {{agentName}}: Sure.
// {{agentName}}: Once upon a time, in a quaint little village, there was a curious girl named {{characterName}}.
// {{agentName}}: {{characterName}} was known for her adventurous spirit and her knack for finding beauty in the mundane.
// {{name1}}: I'm loving it, keep going
// Response: RESPOND`,

  // ═══════════════════════════════════════════════════════
  // RESPOND - Indirect questions
  // ═══════════════════════════════════════════════════════

  `// {{name1}}: what do you think about artificial intelligence?
// Response: RESPOND`,

  `// {{name1}}: Does anyone know where {{agentName}} is?
// Response: RESPOND`,

  `// {{name1}}: Has anyone talked to {{agentName}} about this?
// Response: RESPOND`,

  `// {{name1}}: What would {{agentName}} say about this situation?
// Response: RESPOND`,

  // ═══════════════════════════════════════════════════════
  // RESPOND - Reactions to agent's messages
  // ═══════════════════════════════════════════════════════

  `// {{agentName}}: Oh, this is my favorite scene
// {{name1}}: sick
// {{name2}}: wait, why is it your favorite scene?
// Response: RESPOND`,

  // ═══════════════════════════════════════════════════════
  // IGNORE - References (not interpellations)
  // ═══════════════════════════════════════════════════════

  `// {{name1}}: I talked to {{agentName}} yesterday
// {{name2}}: Oh really? What did he say?
// Response: IGNORE`,

  `// {{name1}}: {{agentName}} was really helpful last week
// {{name2}}: Yeah, he's great
// Response: IGNORE`,

  `// {{name1}}: {{agentName}}'s code is really good
// {{name2}}: Yeah, I learned a lot from it
// Response: IGNORE`,

  `// {{name1}}: I like {{agentName}}'s approach to this problem
// Response: IGNORE`,

  // ═══════════════════════════════════════════════════════
  // IGNORE - Conversations not concerned
  // ═══════════════════════════════════════════════════════

  `// {{name1}}: I just saw a really great movie
// {{name2}}: Oh? Which movie?
// Response: IGNORE`,

  `// {{name1}}: i need help
// {{agentName}}: how can I help you?
// {{name1}}: no. i need help from {{name2}}
// Response: IGNORE`,

  `// {{name1}}: {{name2}} can you answer a question for me?
// Response: IGNORE`,

  `// {{name1}}: I love pizza
// {{name2}}: Me too!
// Response: IGNORE`,

  // ═══════════════════════════════════════════════════════
  // STOP - Stop requests
  // ═══════════════════════════════════════════════════════

  `// {{name1}}: {{agentName}} stop responding plz
// Response: STOP`,

  `// {{name1}}: stfu bot
// Response: STOP`,

  `// {{name1}}: {{agentName}} stfu plz
// Response: STOP`,

  `// {{name1}}: {{agentName}} please be quiet for a bit
// Response: STOP`,
];

/**
 * Represents a provider that generates response examples for the agent.
 * @type {Provider}
 */
export const shouldRespondProvider: Provider = {
  name: 'SHOULD_RESPOND',
  description: 'Examples of when the agent should respond, ignore, or stop responding based on natural conversation context',
  position: -1,
  get: async (runtime: IAgentRuntime, _message: Memory) => {
    // Get agent name
    const agentName = runtime.character.name;

    // Create random user names and character name
    const name1 = uniqueNamesGenerator(nameConfig);
    const name2 = uniqueNamesGenerator(nameConfig);
    const characterName = uniqueNamesGenerator(nameConfig);

    // Shuffle the message examples array and use more examples for better context
    const shuffledExamples = [...messageExamples].sort(() => 0.5 - Math.random()).slice(0, 10);

    // Replace placeholders with generated names
    const formattedExamples = shuffledExamples.map((example) => {
      return example
        .replace(/{{name1}}/g, name1)
        .replace(/{{name2}}/g, name2)
        .replace(/{{agentName}}/g, agentName)
        .replace(/{{characterName}}/g, characterName);
    });

    // Join examples
    const examplesText = formattedExamples.join('\n\n');
    const text = addHeader('# RESPONSE EXAMPLES', examplesText);

    return {
      text,
    };
  },
};
