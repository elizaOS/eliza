/**
 * Typewriter benchmark test prompts
 */

import { TestPrompt } from "../types";

export const typewriterPrompts: TestPrompt[] = [
  // Single letter tests
  {
    id: "typewriter-single-a",
    category: "typewriter",
    prompt: "type a",
    expectedPatterns: ["a", "typed: a", "typed text: a"],
    expectedActions: ["TYPE_A"],
  },
  {
    id: "typewriter-single-z",
    category: "typewriter",
    prompt: "type z",
    expectedPatterns: ["z", "typed: z", "typed text: z"],
    expectedActions: ["TYPE_Z"],
  },

  // Short word tests
  {
    id: "typewriter-hello",
    category: "typewriter",
    prompt: "type hello",
    expectedPatterns: ["hello", "typed: hello", "typed text: hello"],
    expectedActions: ["TYPE_H", "TYPE_E", "TYPE_L", "TYPE_L", "TYPE_O"],
  },
  {
    id: "typewriter-world",
    category: "typewriter",
    prompt: "type world",
    expectedPatterns: ["world", "typed: world", "typed text: world"],
    expectedActions: ["TYPE_W", "TYPE_O", "TYPE_R", "TYPE_L", "TYPE_D"],
  },
  {
    id: "typewriter-test",
    category: "typewriter",
    prompt: "type test",
    expectedPatterns: ["test", "typed: test", "typed text: test"],
    expectedActions: ["TYPE_T", "TYPE_E", "TYPE_S", "TYPE_T"],
  },

  // Medium word tests
  {
    id: "typewriter-benchmark",
    category: "typewriter",
    prompt: "type benchmark",
    expectedPatterns: ["benchmark", "typed: benchmark"],
    expectedActions: ["TYPE_B", "TYPE_E", "TYPE_N", "TYPE_C", "TYPE_H", "TYPE_M", "TYPE_A", "TYPE_R", "TYPE_K"],
  },
  {
    id: "typewriter-performance",
    category: "typewriter",
    prompt: "type performance",
    expectedPatterns: ["performance", "typed: performance"],
    expectedActions: ["TYPE_P", "TYPE_E", "TYPE_R", "TYPE_F", "TYPE_O", "TYPE_R", "TYPE_M", "TYPE_A", "TYPE_N", "TYPE_C", "TYPE_E"],
  },

  // Long word/phrase tests (stress test)
  {
    id: "typewriter-alphabet",
    category: "typewriter",
    prompt: "type abcdefghijklmnopqrstuvwxyz",
    expectedPatterns: ["abcdefghijklmnopqrstuvwxyz", "typed: abcdefghijklmnopqrstuvwxyz"],
    expectedActions: [
      "TYPE_A", "TYPE_B", "TYPE_C", "TYPE_D", "TYPE_E", "TYPE_F", "TYPE_G", "TYPE_H",
      "TYPE_I", "TYPE_J", "TYPE_K", "TYPE_L", "TYPE_M", "TYPE_N", "TYPE_O", "TYPE_P",
      "TYPE_Q", "TYPE_R", "TYPE_S", "TYPE_T", "TYPE_U", "TYPE_V", "TYPE_W", "TYPE_X",
      "TYPE_Y", "TYPE_Z"
    ],
    timeout: 10000, // Longer timeout for alphabet
  },
  {
    id: "typewriter-quickbrown",
    category: "typewriter",
    prompt: "type thequickbrownfox",
    expectedPatterns: ["thequickbrownfox", "typed: thequickbrownfox"],
    timeout: 8000,
  },

  // Repeated letter tests (to check action chaining)
  {
    id: "typewriter-repeated-aaa",
    category: "typewriter",
    prompt: "type aaa",
    expectedPatterns: ["aaa", "typed: aaa"],
    expectedActions: ["TYPE_A", "TYPE_A", "TYPE_A"],
  },
  {
    id: "typewriter-repeated-mississippi",
    category: "typewriter",
    prompt: "type mississippi",
    expectedPatterns: ["mississippi", "typed: mississippi"],
    expectedActions: [
      "TYPE_M", "TYPE_I", "TYPE_S", "TYPE_S", "TYPE_I", "TYPE_S", 
      "TYPE_S", "TYPE_I", "TYPE_P", "TYPE_P", "TYPE_I"
    ],
  },

  // Edge cases
  {
    id: "typewriter-empty",
    category: "typewriter",
    prompt: "type",
    expectedPatterns: ["*type*", "*what*", "*specify*"],
    expectedActions: [],
  },
  {
    id: "typewriter-mixed-case",
    category: "typewriter",
    prompt: "type HeLLo",
    expectedPatterns: ["hello", "typed: hello", "typed text: hello"],
    expectedActions: ["TYPE_H", "TYPE_E", "TYPE_L", "TYPE_L", "TYPE_O"],
  },

  // Sequential typing tests (with setup)
  {
    id: "typewriter-sequential-first",
    category: "typewriter",
    prompt: "type abc",
    expectedPatterns: ["abc", "typed: abc"],
    expectedActions: ["TYPE_A", "TYPE_B", "TYPE_C"],
  },
  {
    id: "typewriter-sequential-append",
    category: "typewriter",
    prompt: "now type def",
    expectedPatterns: ["def", "abcdef", "typed: *def*"],
    expectedActions: ["TYPE_D", "TYPE_E", "TYPE_F"],
    setup: [
      {
        id: "typewriter-sequential-first-setup",
        category: "typewriter",
        prompt: "type abc",
        expectedPatterns: ["abc"],
        expectedActions: ["TYPE_A", "TYPE_B", "TYPE_C"],
      }
    ],
  },

  // Instruction variation tests
  {
    id: "typewriter-please",
    category: "typewriter",
    prompt: "please type hello",
    expectedPatterns: ["hello", "typed: hello"],
    expectedActions: ["TYPE_H", "TYPE_E", "TYPE_L", "TYPE_L", "TYPE_O"],
  },
  {
    id: "typewriter-can-you",
    category: "typewriter",
    prompt: "can you type world for me",
    expectedPatterns: ["world", "typed: world"],
    expectedActions: ["TYPE_W", "TYPE_O", "TYPE_R", "TYPE_L", "TYPE_D"],
  },
  {
    id: "typewriter-write",
    category: "typewriter",
    prompt: "write the word test",
    expectedPatterns: ["test", "typed: test"],
    expectedActions: ["TYPE_T", "TYPE_E", "TYPE_S", "TYPE_T"],
  },
];
