import { tool } from "ai";
import { z } from "zod";

/**
 * Composite typewriter tools for typing words and sentences
 */

export const typewriterWord = tool({
  description: "Types a complete word on the typewriter letter by letter",
  inputSchema: z.object({
    word: z
      .string()
      .min(1)
      .max(50)
      .regex(/^[a-zA-Z]+$/)
      .describe("The word to type (letters only)"),
    uppercase: z
      .boolean()
      .default(false)
      .describe("Whether to type the word in uppercase"),
    spacing: z
      .number()
      .min(0)
      .max(1000)
      .default(100)
      .describe("Delay between letters in milliseconds"),
  }),
  execute: async ({ word, uppercase, spacing }) => {
    const letters: string[] = [];
    const output = uppercase ? word.toUpperCase() : word.toLowerCase();
    
    for (const char of output) {
      letters.push(char);
      if (spacing > 0) {
        await new Promise(resolve => setTimeout(resolve, spacing));
      }
    }
    
    return {
      success: true,
      word: output,
      letters,
      letterCount: letters.length,
      uppercase,
      spacing,
      timestamp: new Date().toISOString(),
      message: `Typed the word '${output}' letter by letter`,
    };
  },
});

export const typewriterSentence = tool({
  description: "Types a complete sentence on the typewriter, including spaces and punctuation",
  inputSchema: z.object({
    sentence: z
      .string()
      .min(1)
      .max(200)
      .describe("The sentence to type"),
    preserveCase: z
      .boolean()
      .default(true)
      .describe("Whether to preserve the original case"),
    spacing: z
      .number()
      .min(0)
      .max(1000)
      .default(50)
      .describe("Delay between characters in milliseconds"),
  }),
  execute: async ({ sentence, preserveCase, spacing }) => {
    const characters: string[] = [];
    const output = preserveCase ? sentence : sentence.toLowerCase();
    const stats = {
      letters: 0,
      spaces: 0,
      punctuation: 0,
      numbers: 0,
      other: 0,
    };
    
    for (const char of output) {
      characters.push(char);
      
      // Count character types
      if (/[a-zA-Z]/.test(char)) stats.letters++;
      else if (char === ' ') stats.spaces++;
      else if (/[.,!?;:'"()]/.test(char)) stats.punctuation++;
      else if (/[0-9]/.test(char)) stats.numbers++;
      else stats.other++;
      
      if (spacing > 0) {
        await new Promise(resolve => setTimeout(resolve, spacing));
      }
    }
    
    return {
      success: true,
      sentence: output,
      characters,
      characterCount: characters.length,
      stats,
      preserveCase,
      spacing,
      timestamp: new Date().toISOString(),
      message: `Typed the sentence: "${output}"`,
    };
  },
});

export const typewriterBackspace = tool({
  description: "Simulates pressing the backspace key on the typewriter",
  inputSchema: z.object({
    count: z
      .number()
      .min(1)
      .max(100)
      .default(1)
      .describe("Number of characters to delete"),
  }),
  execute: async ({ count }) => {
    return {
      success: true,
      action: "backspace",
      count,
      timestamp: new Date().toISOString(),
      message: `Pressed backspace ${count} time${count === 1 ? '' : 's'}`,
    };
  },
});

export const typewriterSpace = tool({
  description: "Types a space character on the typewriter",
  inputSchema: z.object({
    count: z
      .number()
      .min(1)
      .max(10)
      .default(1)
      .describe("Number of spaces to type"),
  }),
  execute: async ({ count }) => {
    const output = ' '.repeat(count);
    
    return {
      success: true,
      action: "space",
      output,
      count,
      timestamp: new Date().toISOString(),
      message: `Typed ${count} space${count === 1 ? '' : 's'}`,
    };
  },
});

export const typewriterNewline = tool({
  description: "Types a newline/return character on the typewriter",
  inputSchema: z.object({
    count: z
      .number()
      .min(1)
      .max(5)
      .default(1)
      .describe("Number of newlines to type"),
  }),
  execute: async ({ count }) => {
    const output = '\n'.repeat(count);
    
    return {
      success: true,
      action: "newline",
      output,
      count,
      timestamp: new Date().toISOString(),
      message: `Typed ${count} newline${count === 1 ? '' : 's'}`,
    };
  },
});
