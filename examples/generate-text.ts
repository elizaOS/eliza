/**
 * Simple example of using generateText() for basic text generation.
 *
 * Key Features:
 * - Optional character personality context
 * - Control over generation parameters
 * - Flexible model selection (TEXT_SMALL, TEXT_LARGE, etc.)
 *
 * Prerequisites:
 * - OPENAI_API_KEY environment variable
 *
 * Usage:
 *   OPENAI_API_KEY=your_key bun run examples/generate-text.ts
 */

import { AgentRuntime, type Character } from '@elizaos/core';
import openaiPlugin from '@elizaos/plugin-openai';
import sqlPlugin from '@elizaos/plugin-sql';

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY required');
    process.exit(1);
  }

  const character: Character = {
    name: 'Shakespeare',
    bio: 'A dramatic poet from Elizabethan England',
    system: 'You are William Shakespeare. Respond poetically.',
    style: {
      all: ['Speak in iambic pentameter when possible'],
      chat: ['Be theatrical'],
    },
  };

  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, openaiPlugin],
    settings: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      PGLITE_DATA_DIR: 'memory://',
    },
  });

  await runtime.initialize();

  // With character context (default)
  console.log('\n--- With Character Context ---');
  const withCharacter = await runtime.generateText(
    'What do you think about artificial intelligence?'
  );
  console.log(withCharacter.text);

  // Without character context
  console.log('\n--- Without Character Context ---');
  const withoutCharacter = await runtime.generateText('Translate to Spanish: Hello, how are you?', {
    includeCharacter: false,
  });
  console.log(withoutCharacter.text);

  // With custom parameters
  console.log('\n--- With Custom Parameters ---');
  const creative = await runtime.generateText('Write a haiku about coding', {
    temperature: 0.9,
    maxTokens: 100,
  });
  console.log(creative.text);

  await runtime.stop();
}

if (import.meta.main) {
  main();
}
