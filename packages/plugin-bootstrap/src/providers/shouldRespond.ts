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
  // Examples where agent should RESPOND
  `// {{name1}}: Hey {{agentName}}, can you help me with something
// Response: RESPOND`,

  `// {{name1}}: Hey {{agentName}}, can I ask you a question
// {{agentName}}: Sure, what is it
// {{name1}}: can you help me create a basic react module that demonstrates a counter
// Response: RESPOND`,

  `// {{name1}}: {{agentName}} can you tell me a story
// {{name1}}: about a girl named {{characterName}}
// {{agentName}}: Sure.
// {{agentName}}: Once upon a time, in a quaint little village, there was a curious girl named {{characterName}}.
// {{agentName}}: {{characterName}} was known for her adventurous spirit and her knack for finding beauty in the mundane.
// {{name1}}: I'm loving it, keep going
// Response: RESPOND`,

  `// {{name1}}: okay, i want to test something. can you say marco?
// {{agentName}}: marco
// {{name1}}: great. okay, now do it again
// Response: RESPOND`,

  `// {{name1}}: what do you think about artificial intelligence?
// Response: RESPOND`,

  // Examples where agent should IGNORE
  `// {{name1}}: I just saw a really great movie
// {{name2}}: Oh? Which movie?
// Response: IGNORE`,

  `// {{name1}}: i need help
// {{agentName}}: how can I help you?
// {{name1}}: no. i need help from {{name2}}
// Response: IGNORE`,

  `// {{name1}}: {{name2}} can you answer a question for me?
// Response: IGNORE`,

  `// {{agentName}}: Oh, this is my favorite scene
// {{name1}}: sick
// {{name2}}: wait, why is it your favorite scene
// Response: RESPOND`,

  // Examples where agent should STOP
  `// {{name1}}: {{agentName}} stop responding plz
// Response: STOP`,

  `// {{name1}}: stfu bot
// Response: STOP`,

  `// {{name1}}: {{agentName}} stfu plz
// Response: STOP`,
];

/**
 * Represents a provider that generates response examples for the agent.
 * @type {Provider}
 */
export const shouldRespondProvider: Provider = {
  name: 'SHOULD_RESPOND',
  description: 'Examples of when the agent should respond, ignore, or stop responding',
  position: -1,
  get: async (runtime: IAgentRuntime, _message: Memory) => {
    // Get agent name
    const agentName = runtime.character.name;

    // Create random user names and character name
    const name1 = uniqueNamesGenerator(nameConfig);
    const name2 = uniqueNamesGenerator(nameConfig);
    const characterName = uniqueNamesGenerator(nameConfig);

    // Shuffle the message examples array
    const shuffledExamples = [...messageExamples].sort(() => 0.5 - Math.random()).slice(0, 7); // Use a subset of examples

    // Replace placeholders with generated names
    const formattedExamples = shuffledExamples.map((example) => {
      return example
        .replace(/{{name1}}/g, name1)
        .replace(/{{name2}}/g, name2)
        .replace(/{{agentName}}/g, agentName)
        .replace(/{{characterName}}/g, characterName);
    });

    // Join examples with newlines
    const text = addHeader('# RESPONSE EXAMPLES', formattedExamples.join('\n\n'));

    return {
      text,
    };
  },
};
