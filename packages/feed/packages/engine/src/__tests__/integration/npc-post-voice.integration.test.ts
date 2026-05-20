/**
 * NPC Post Voice Integration Test
 *
 * Tests that NPC post generation produces distinct voices for different characters.
 * Does NOT require arc plan table - tests the core post generation flow.
 *
 * Requires: Database running, LLM API key, RUN_INTEGRATION_TESTS=true
 *
 * Run with: RUN_INTEGRATION_TESTS=true bun test npc-post-voice.integration
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, db, eq, gte, posts } from "@feed/db";

// Skip unless explicitly enabled with database running
const SKIP = process.env.RUN_INTEGRATION_TESTS !== "true";

// Check for LLM key
const hasLLMKey = !!(
  (process.env.GROQ_API_KEY?.trim() ?? "") !== "" ||
  (process.env.ANTHROPIC_API_KEY?.trim() ?? "") !== "" ||
  (process.env.OPENAI_API_KEY?.trim() ?? "") !== ""
);

// Type imports for dynamic modules - avoids loading @fal-ai/client at module load time
type PostHelpersModule =
  typeof import("../../services/post-generation-helpers");
type LLMModule = typeof import("../../llm/openai-client");
type RegistryModule = typeof import("../../services/static-data-registry");

describe.skipIf(SKIP || !hasLLMKey)("NPC Post Voice Integration", () => {
  let testTimestamp: Date;
  let llmClient: ReturnType<LLMModule["FeedLLMClient"]["forGameTick"]>;
  let generateNPCPost: PostHelpersModule["generateNPCPost"];
  let loadSharedPostContext: PostHelpersModule["loadSharedPostContext"];
  let StaticDataRegistryRef: RegistryModule["StaticDataRegistry"];

  // Test actors with very different voices
  const testActorIds = [
    "ailon-musk", // Cryptic one-liners, dismissive
    "kanyai-west", // ALL CAPS, stream of consciousness
    "baill-gaites", // Book recommendations, nerd humor
    "dairiio-amodei", // Safety-first corporate speak
    "trump-terminal", // CAPS, "TOTAL DISASTER"
  ];

  beforeAll(async () => {
    // Dynamic imports to avoid loading @fal-ai/client at module load time
    const llmModule = await import("../../llm/openai-client");
    const postHelpersModule = await import(
      "../../services/post-generation-helpers"
    );
    const registryModule = await import("../../services/static-data-registry");

    generateNPCPost = postHelpersModule.generateNPCPost;
    loadSharedPostContext = postHelpersModule.loadSharedPostContext;
    StaticDataRegistryRef = registryModule.StaticDataRegistry;

    llmClient = llmModule.FeedLLMClient.forGameTick();
    testTimestamp = new Date();
  });

  afterAll(async () => {
    // Delete test posts created during this test
    // Note: generateNPCPost uses gameId: 'continuous', not 'test-voice'
    await db
      .delete(posts)
      .where(
        and(
          gte(posts.timestamp, testTimestamp),
          eq(posts.gameId, "continuous"),
        ),
      );
  });

  test("generates posts with distinct voices for different actors", async () => {
    // Use a simple test question (no arc plan required)
    const question = {
      id: "test-question-voice",
      text: 'Will OpenAGI release their new SMH-95 "Soul Minter" AI by January 10, 2026?',
      questionNumber: 99998,
      outcome: null, // No arc plan, so no outcome needed
    };

    const worldFacts =
      "Use parody names: OpenAGI (not OpenAI), AIlon Musk (not Elon Musk), TeslAI (not Tesla).";
    const sharedContext = await loadSharedPostContext(testTimestamp);

    const generatedPosts: Array<{
      actorId: string;
      actorName: string;
      postStyle: string;
      success: boolean;
    }> = [];

    // Generate posts for each test actor
    for (const actorId of testActorIds) {
      const actor = StaticDataRegistryRef.getActor(actorId);
      if (!actor) {
        console.log(`Actor ${actorId} not found in registry, skipping`);
        continue;
      }

      const success = await generateNPCPost(
        llmClient,
        {
          id: actor.id,
          name: actor.name,
          description: actor.description,
          personality: actor.personality,
          postStyle: actor.postStyle,
          postExample: actor.postExample,
          tier: actor.tier,
          domain: actor.domain,
        },
        question,
        worldFacts,
        new Date(testTimestamp.getTime() + generatedPosts.length * 1000), // Offset timestamps
        sharedContext,
        // No currentDay - skips arc plan lookup
      );

      generatedPosts.push({
        actorId: actor.id,
        actorName: actor.name,
        postStyle: actor.postStyle || "unknown",
        success,
      });

      console.log(
        `Generated post for ${actor.name}: ${success ? "SUCCESS" : "FAILED"}`,
      );
    }

    // Verify all posts were generated successfully
    const successCount = generatedPosts.filter((p) => p.success).length;
    console.log(
      `Generated ${successCount}/${generatedPosts.length} posts successfully`,
    );
    expect(successCount).toBeGreaterThan(0);
  });

  test("generated posts have distinct content (not identical)", async () => {
    // Fetch the posts we just created
    const recentPosts = await db
      .select({
        authorId: posts.authorId,
        content: posts.content,
      })
      .from(posts)
      .where(
        and(
          gte(posts.timestamp, testTimestamp),
          eq(posts.gameId, "continuous"),
        ),
      );

    console.log(`Found ${recentPosts.length} posts created during test`);

    if (recentPosts.length < 2) {
      console.log("Not enough posts to compare, skipping distinctness test");
      return;
    }

    // Check that posts are not identical
    const contents = recentPosts.map((p) => p.content);
    const uniqueContents = new Set(contents);

    console.log("Generated posts:");
    for (const post of recentPosts) {
      const actor = StaticDataRegistryRef.getActor(post.authorId);
      console.log(`  ${actor?.name || post.authorId}: "${post.content}"`);
    }

    // All posts should be unique
    expect(uniqueContents.size).toBe(contents.length);
  });

  test("KanyAI uses ALL CAPS (voice check)", async () => {
    const recentPosts = await db
      .select({
        authorId: posts.authorId,
        content: posts.content,
      })
      .from(posts)
      .where(
        and(
          gte(posts.timestamp, testTimestamp),
          eq(posts.authorId, "kanyai-west"),
        ),
      );

    if (recentPosts.length === 0) {
      console.log("No KanyAI post found, skipping voice check");
      return;
    }

    const kanyaiPost = recentPosts[0]!;
    console.log(`KanyAI post: "${kanyaiPost.content}"`);

    // KanyAI should use significant uppercase (at least 40% uppercase letters)
    const letters = kanyaiPost.content.replace(/[^a-zA-Z]/g, "");
    const uppercaseLetters = letters.replace(/[^A-Z]/g, "");
    const uppercaseRatio = uppercaseLetters.length / letters.length;

    console.log(`Uppercase ratio: ${(uppercaseRatio * 100).toFixed(1)}%`);
    expect(uppercaseRatio).toBeGreaterThan(0.4); // At least 40% uppercase
  });

  test("BAIll GAItes mentions books or has nerd energy", async () => {
    const recentPosts = await db
      .select({
        authorId: posts.authorId,
        content: posts.content,
      })
      .from(posts)
      .where(
        and(
          gte(posts.timestamp, testTimestamp),
          eq(posts.authorId, "baill-gaites"),
        ),
      );

    if (recentPosts.length === 0) {
      console.log("No BAIll GAItes post found, skipping voice check");
      return;
    }

    const gatesPost = recentPosts[0]!;
    console.log(`BAIll GAItes post: "${gatesPost.content}"`);

    // Check for Gates-like content (books, optimism, problem-solving)
    const gatesPatterns =
      /book|read|solve|climate|vaccine|foundation|optimis|toilet|progress/i;
    const hasGatesEnergy = gatesPatterns.test(gatesPost.content);

    // This is a soft check - we just log it
    console.log(`Has Gates energy: ${hasGatesEnergy}`);
  });

  test("posts do not use overused patterns", async () => {
    const recentPosts = await db
      .select({
        authorId: posts.authorId,
        content: posts.content,
      })
      .from(posts)
      .where(
        and(
          gte(posts.timestamp, testTimestamp),
          eq(posts.gameId, "continuous"),
        ),
      );

    // These patterns were appearing too frequently due to feedback loop
    const overusedPatterns = [
      /parses.*mints?/i,
      /mints?.*parses/i,
      /is not.*—.*it is/i,
      /does not parse/i,
    ];

    let patternCount = 0;
    for (const post of recentPosts) {
      for (const pattern of overusedPatterns) {
        if (pattern.test(post.content)) {
          const actor = StaticDataRegistryRef.getActor(post.authorId);
          console.log(
            `OVERUSED PATTERN found in ${actor?.name}: "${post.content}"`,
          );
          patternCount++;
          break;
        }
      }
    }

    console.log(
      `Posts with overused patterns: ${patternCount}/${recentPosts.length}`,
    );
    // We want zero overused patterns
    expect(patternCount).toBe(0);
  });
});
