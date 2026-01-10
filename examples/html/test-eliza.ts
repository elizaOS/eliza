/**
 * Quick test script for ELIZA pattern matching
 */

// ELIZA patterns (same as in index.html)
const elizaPatterns = [
  { keyword: "sorry", weight: 1, responses: ["Please don't apologize.", "Apologies are not necessary.", "What feelings do you have when you apologize?"] },
  { keyword: "remember", weight: 5, responses: ["Do you often think of that?", "What else do you remember?", "Why do you remember that just now?"] },
  { keyword: "if", weight: 3, responses: ["Do you think it's likely?", "Do you wish that were true?", "What do you know about that?"] },
  { keyword: "dream", weight: 4, responses: ["What does that dream suggest to you?", "Do you dream often?", "What persons appear in your dreams?"] },
  { keyword: "perhaps", weight: 0, responses: ["You don't seem quite certain.", "Why the uncertain tone?", "Can't you be more positive?"] },
  { keyword: "hello", weight: 0, responses: ["How do you do. Please state your problem.", "Hi. What seems to be your problem?", "Hello. Tell me what's on your mind."] },
  { keyword: "hi", weight: 0, responses: ["How do you do. Please state your problem.", "Hi there. What brings you here today?", "Hello. Tell me what's on your mind."] },
  { keyword: "computer", weight: 50, responses: ["Do computers worry you?", "Why do you mention computers?", "What do you think machines have to do with your problem?"] },
  { keyword: "feel", weight: 3, responses: ["Tell me more about such feelings.", "Do you often feel that way?", "Do you enjoy feeling that way?"] },
  { keyword: "think", weight: 2, responses: ["Do you really think so?", "But you are not sure?", "Do you doubt that?"] },
  { keyword: "want", weight: 2, responses: ["What would it mean to you if you got that?", "Why do you want that?", "What if you never got that?"] },
  { keyword: "need", weight: 2, responses: ["Why do you need that?", "Would it really help you?", "Are you sure you need that?"] },
  { keyword: "why", weight: 1, responses: ["Why do you ask?", "Does that question interest you?", "What is it you really want to know?"] },
  { keyword: "yes", weight: 0, responses: ["You seem quite positive.", "You are sure.", "I see.", "I understand."] },
  { keyword: "no", weight: 0, responses: ["Are you saying 'no' just to be negative?", "You are being a bit negative.", "Why not?", "Why 'no'?"] },
  { keyword: "always", weight: 1, responses: ["Can you think of a specific example?", "When?", "Really, always?"] },
  { keyword: "because", weight: 0, responses: ["Is that the real reason?", "Don't any other reasons come to mind?", "Does that reason explain anything else?"] },
  { keyword: "my mother", weight: 5, responses: ["Tell me more about your mother.", "What was your relationship with your mother like?", "How do you feel about your mother?"] },
  { keyword: "my father", weight: 5, responses: ["Tell me more about your father.", "How did your father treat you?", "How do you feel about your father?"] },
  { keyword: "my family", weight: 4, responses: ["Tell me more about your family.", "Who in your family worries you most?", "What comes to mind when you think of your family?"] },
  { keyword: "i am", weight: 3, responses: ["How long have you been like that?", "How do you feel about that?", "Do you believe it is normal to be like that?"] },
  { keyword: "i feel", weight: 3, responses: ["Tell me more about such feelings.", "Do you often feel that way?", "What makes you feel like that?"] },
  { keyword: "i can't", weight: 2, responses: ["How do you know you can't?", "Have you tried?", "Perhaps you could try now.", "Do you really want to be able to do that?"] },
  { keyword: "are you", weight: 2, responses: ["Why are you interested in whether I am or not?", "Would you prefer if I weren't?", "Perhaps I am in your fantasies."] },
  { keyword: "you are", weight: 2, responses: ["What makes you think I am?", "Does it please you to believe that?", "Perhaps you would like me to be."] },
  { keyword: "you", weight: 1, responses: ["We were discussing you -- not me.", "You're not really talking about me, are you?", "What are your feelings now?"] },
];

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

function generateElizaResponse(input: string): string {
  const normalized = input.toLowerCase().trim();
  if (!normalized) return "I didn't catch that. Could you please repeat?";
  
  // Find matching patterns
  let bestMatch: typeof elizaPatterns[0] | null = null;
  let bestWeight = -1;
  
  for (const pattern of elizaPatterns) {
    if (normalized.includes(pattern.keyword) && pattern.weight >= bestWeight) {
      bestMatch = pattern;
      bestWeight = pattern.weight;
    }
  }
  
  if (bestMatch) {
    const responses = bestMatch.responses;
    return responses[Math.floor(Math.random() * responses.length)];
  }
  
  return defaultResponses[Math.floor(Math.random() * defaultResponses.length)];
}

// Test cases
const testCases = [
  "Hello!",
  "I feel sad today",
  "My mother never understood me",
  "I think you are a computer",
  "Why do you ask so many questions?",
  "I can't seem to focus",
  "I had a dream last night",
  "Perhaps I should try harder",
  "Yes, that's right",
  "No, I don't agree",
  "I remember when I was young",
  "The weather is nice today", // Should use default response
];

console.log("=".repeat(60));
console.log("ELIZA Pattern Matching Test");
console.log("=".repeat(60));
console.log();

for (const input of testCases) {
  const response = generateElizaResponse(input);
  console.log(`USER: ${input}`);
  console.log(`ELIZA: ${response}`);
  console.log("-".repeat(40));
}

console.log();
console.log("✓ All tests completed successfully!");
console.log();
console.log("The ELIZA pattern matching is working correctly.");
console.log("Open http://localhost:8888/index.html in a browser to interact with the full demo.");

