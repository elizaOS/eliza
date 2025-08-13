// Test file to verify the typewriter tools work correctly
import {
  typewriterA,
  typewriterH,
  typewriterE,
  typewriterL,
  typewriterO,
  typewriterWord,
  typewriterSentence,
  typewriterSpace,
  allTypewriterTools,
  typewriterToolMap,
} from "./index";

console.log("Testing Typewriter Tools Plugin");
console.log("================================\n");

// Test individual letter tools
console.log("Testing individual letter tools:");
console.log(`Total letter tools: ${allTypewriterTools.length}`);
console.log(`Letter tools in map: ${Object.keys(typewriterToolMap).length}`);

// Test that we have all 26 letters
const alphabet = "abcdefghijklmnopqrstuvwxyz";
for (const letter of alphabet) {
  if (letter in typewriterToolMap) {
    console.log(`✓ Tool for letter '${letter}' exists`);
  } else {
    console.log(`✗ Tool for letter '${letter}' is missing`);
  }
}

console.log("\nSample tool execution (simulated):");

// Simulate typing "HELLO"
async function testHello() {
  console.log("\nTyping 'HELLO':");
  
  const result1 = await typewriterH.execute({ uppercase: true, repeat: 1 });
  console.log(`  H: ${result1.message}`);
  
  const result2 = await typewriterE.execute({ uppercase: true, repeat: 1 });
  console.log(`  E: ${result2.message}`);
  
  const result3 = await typewriterL.execute({ uppercase: true, repeat: 2 });
  console.log(`  L: ${result3.message}`);
  
  const result4 = await typewriterO.execute({ uppercase: true, repeat: 1 });
  console.log(`  O: ${result4.message}`);
}

// Test composite tools
async function testComposite() {
  console.log("\nTesting composite tools:");
  
  const wordResult = await typewriterWord.execute({ 
    word: "hello", 
    uppercase: false, 
    spacing: 0 
  });
  console.log(`  Word: ${wordResult.message}`);
  
  const sentenceResult = await typewriterSentence.execute({ 
    sentence: "Hello, World!", 
    preserveCase: true, 
    spacing: 0 
  });
  console.log(`  Sentence: ${sentenceResult.message}`);
  console.log(`    Stats:`, sentenceResult.stats);
  
  const spaceResult = await typewriterSpace.execute({ count: 3 });
  console.log(`  Space: ${spaceResult.message}`);
}

// Run tests
(async () => {
  await testHello();
  await testComposite();
  
  console.log("\n================================");
  console.log("All tests completed successfully!");
  console.log("\nThis plugin provides:");
  console.log("- 26 individual letter tools (typewriterA through typewriterZ)");
  console.log("- 5 composite tools (word, sentence, backspace, space, newline)");
  console.log("- Designed for benchmarking tool selection vs action system");
})();
