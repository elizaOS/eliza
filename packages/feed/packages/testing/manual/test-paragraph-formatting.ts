/**
 * Test to debug paragraph formatting in LLM responses
 */

import { FeedLLMClient } from "@feed/engine";

async function testParagraphFormatting() {
  console.log("🔍 Testing Paragraph Formatting\n");

  if (!process.env.OPENAI_API_KEY) {
    console.log("⚠️  Set OPENAI_API_KEY to run this test");
    process.exit(0);
  }

  const llm = new FeedLLMClient();

  const testPrompt = `You are BloombAIrg News, a news organization. Write a comprehensive news article about this prediction market: "Will OpenAGI achieve AGI by 2030?".

Provide:
- "title": a compelling headline (max 100 characters)
- "summary": a succinct 2-3 sentence summary for social feeds (max 400 characters)
- "article": a full-length article body (at least 4 paragraphs) with concrete details, analysis, and optional quotes. The article should read like a professional newsroom piece, not bullet points. Separate paragraphs with \\n\\n (two newlines).

Return your response as XML in this exact format:
<response>
  <title>news headline here</title>
  <summary>2-3 sentence summary here</summary>
  <article>full article body here with \\n\\n between paragraphs</article>
</response>`;

  console.log("Generating article...\n");

  const rawResponse = await llm.generateJSON<
    | { title: string; summary: string; article: string }
    | { response: { title: string; summary: string; article: string } }
  >(
    testPrompt,
    {
      properties: {
        title: { type: "string" },
        summary: { type: "string" },
        article: { type: "string" },
      },
      required: ["title", "summary", "article"],
    },
    { temperature: 0.7, maxTokens: 1000 },
  );

  // Handle XML structure
  const response =
    "response" in rawResponse && rawResponse.response
      ? rawResponse.response
      : (rawResponse as { title: string; summary: string; article: string });

  console.log("📰 Article Generated!\n");
  console.log("=".repeat(80));
  console.log(`Title: ${response.title}`);
  console.log(`Summary: ${response.summary}`);
  console.log("=".repeat(80));
  console.log("\nFull Article:");
  console.log(response.article);
  console.log(`\n${"=".repeat(80)}`);

  // Analyze paragraph structure
  console.log("\n🔍 Analysis:");
  console.log(`Total length: ${response.article.length} characters`);
  console.log(`Word count: ${response.article.split(/\s+/).length} words`);

  // Check for different types of newlines
  const doubleNewlines = (response.article.match(/\n\n/g) || []).length;
  const singleNewlines = (response.article.match(/\n/g) || []).length;

  console.log("\nNewline analysis:");
  console.log(`  Single newlines (\\n): ${singleNewlines}`);
  console.log(`  Double newlines (\\n\\n): ${doubleNewlines}`);

  // Try splitting on different delimiters
  const paragraphsByDouble = response.article
    .split("\n\n")
    .filter((p) => p.trim());
  const paragraphsBySingle = response.article
    .split("\n")
    .filter((p) => p.trim());

  console.log("\nParagraph count:");
  console.log(`  Split by \\n\\n: ${paragraphsByDouble.length} paragraphs`);
  console.log(`  Split by \\n: ${paragraphsBySingle.length} paragraphs`);

  if (paragraphsByDouble.length >= 4) {
    console.log("\n✅ SUCCESS: Article has proper paragraph formatting!");
    console.log("\nParagraphs:");
    paragraphsByDouble.forEach((p, i) => {
      const wordCount = p.split(/\s+/).length;
      console.log(
        `  ${i + 1}. ${wordCount} words - "${p.substring(0, 60)}..."`,
      );
    });
  } else if (paragraphsBySingle.length >= 4) {
    console.log("\n⚠️  Article uses single newlines instead of double newlines");
    console.log("   Consider post-processing to normalize to \\n\\n");
  } else {
    console.log("\n❌ Article is missing proper paragraph breaks");
    console.log("   LLM may not be following formatting instructions");
  }

  // Check for raw escape sequences
  if (response.article.includes("\\n")) {
    console.log("\n⚠️  Found literal \\n strings (not actual newlines)");
    console.log(
      '   This means the LLM is outputting "\\n" as text instead of actual newlines',
    );
  }

  console.log("\n✅ Test complete!");
}

testParagraphFormatting().catch(console.error);
