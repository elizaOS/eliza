/**
 * Tag Service
 *
 * Service for tag generation and storage:
 * - Generates organic tags from post content using LLM
 * - Stores and retrieves tags in the database
 * - Manages tag statistics and trending calculations
 */

import {
  and,
  asc,
  count,
  db,
  desc,
  eq,
  gte,
  inArray,
  ne,
  postTags,
  tags,
  trendingTags,
  withTransaction,
} from "@feed/db";
import { generateSnowflakeId, logger } from "@feed/shared";
import OpenAI from "openai";
import { isPromptLoggingEnabled, logPrompt } from "../utils/prompt-logger";

// =============================================================================
// Types
// =============================================================================

/**
 * Generated tag structure
 */
export interface GeneratedTag {
  name: string; // lowercase, normalized (e.g., "nfc-north")
  displayName: string; // original display format (e.g., "NFC North")
  category?: string; // auto-detected category (e.g., "Sports", "Politics", "Tech")
}

/**
 * Tag details shared between PostTagWithTag and TrendingTagWithTag
 */
export interface TagDetails {
  id: string;
  name: string;
  displayName: string;
  category: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Post tag with tag details
 */
export interface PostTagWithTag {
  id: string;
  postId: string;
  tagId: string;
  createdAt: Date;
  tag: TagDetails;
}

/**
 * Trending tag with tag details
 */
export interface TrendingTagWithTag {
  id: string;
  tagId: string;
  rank: number;
  score: number;
  postCount: number;
  windowStart: Date;
  windowEnd: Date;
  calculatedAt: Date;
  relatedContext: string | null;
  tag: TagDetails;
}

// =============================================================================
// LLM Client Setup
// =============================================================================

type OpenAIClient = OpenAI;

const apiKey = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
const baseURL = process.env.GROQ_API_KEY
  ? process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1"
  : "https://api.openai.com/v1";
const suppressOptionalLlmWarnings = ["1", "true", "yes"].includes(
  (process.env.FEED_SUPPRESS_OPTIONAL_LLM_WARNINGS || "").trim().toLowerCase(),
);

let openaiClient: OpenAIClient | null = null;
let openaiImportAttempted = false;

async function getOpenAIClient(): Promise<OpenAIClient | null> {
  if (!apiKey) {
    return null;
  }
  if (openaiClient) {
    return openaiClient;
  }

  if (!openaiImportAttempted) {
    openaiImportAttempted = true;
    openaiClient = new OpenAI({
      apiKey,
      baseURL,
    });
  }

  return openaiClient;
}

// =============================================================================
// Tag Generation
// =============================================================================

/**
 * Generate 1-3 organic tags from post content using LLM
 */
export async function generateTagsFromPost(
  content: string,
): Promise<GeneratedTag[]> {
  const openai = await getOpenAIClient();

  if (!openai) {
    if (!suppressOptionalLlmWarnings) {
      logger.warn(
        "Tag generation skipped - no GROQ_API_KEY or OPENAI_API_KEY configured",
        undefined,
        "TagService",
      );
    }
    return [];
  }

  const prompt = `Extract 1-3 trending tags from this social media post. Tags should be topics people would search for on X/Twitter.

POST: "${content}"

RULES:
1. Extract SPECIFIC names, companies, products, or events (not generic topics)
2. Use the EXACT names from the post (preserve parody names like "AIlon Musk", "OpenAGI", "TeslAI")
3. Keep tags 1-3 words max
4. Return 1-3 tags (quality over quantity)
5. Tags should CLUSTER together - if post mentions related things, use tags that will group

GOOD TAGS (specific, searchable, will cluster):
- Person names: "AIlon Musk", "Sam AIltman", "Mark Zuckerborg"
- Company names: "OpenAGI", "TeslAI", "MetAI", "NvidAI"
- Products: "SMH-6", "Cybertruck", "Vision Pro"
- Events: "DevDay", "SEC Hearing", "Earnings Call"
- Specific topics: "AGI Timeline", "Crypto Regulation", "AI Safety"

BAD TAGS (too generic, won't cluster):
- "AI" (too broad - use specific company or product)
- "Tech" (too generic)
- "News" (not a topic)
- "Breaking" (not searchable)
- "Market" (use specific market like "BitcAIn" or "NVDA")

CLUSTERING EXAMPLES:
- Post about Sam AIltman announcing SMH-6 → tags: "Sam AIltman", "SMH-6", "OpenAGI" (all will cluster)
- Post about TeslAI stock after Musk tweet → tags: "TeslAI", "AIlon Musk" (will cluster)
- Post comparing NvidAI to AMD → tags: "NvidAI", "AMD" (separate companies, separate clusters)

CATEGORIES: Tech, Crypto, Finance, Politics, Entertainment, Media, AI, Gaming

Return ONLY valid XML:
<response>
  <tags>
    <tag>
      <displayName>Sam AIltman</displayName>
      <category>Tech</category>
    </tag>
    <tag>
      <displayName>OpenAGI</displayName>
      <category>AI</category>
    </tag>
  </tags>
</response>

If no good tags, return: <response><tags></tags></response>`;

  const model = process.env.GROQ_API_KEY
    ? "llama-3.1-8b-instant"
    : "gpt-5-nano";

  const response = await openai.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "You are an XML-only assistant for tag extraction. You must respond ONLY with valid XML. No JSON, no explanations, no markdown.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature: 0.3,
    max_tokens: 500,
  });

  const contentText = response.choices[0]?.message?.content?.trim();

  if (isPromptLoggingEnabled()) {
    await logPrompt({
      promptType: "tag_generation",
      input: `System: You are an XML-only assistant for tag extraction. You must respond ONLY with valid XML. No JSON, no explanations, no markdown.\n\nUser: ${prompt}`,
      output: contentText || "",
      metadata: {
        provider: process.env.GROQ_API_KEY ? "groq" : "openai",
        model,
        temperature: 0.3,
        maxTokens: 500,
      },
    });
  }

  if (!contentText) {
    logger.warn(
      "No content in tag generation response",
      { content },
      "TagService",
    );
    return [];
  }

  const xmlContent = contentText
    .replace(/```xml\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  const parsedTags: Array<{ displayName: string; category?: string }> = [];

  const tagMatches = xmlContent.matchAll(/<tag>([\s\S]*?)<\/tag>/g);

  for (const tagMatch of tagMatches) {
    const tagContent = tagMatch[1];
    if (!tagContent) continue;

    const displayNameMatch = tagContent.match(
      /<displayName>(.*?)<\/displayName>/,
    );
    const categoryMatch = tagContent.match(/<category>(.*?)<\/category>/);

    if (displayNameMatch?.[1]) {
      const displayName = displayNameMatch[1].trim();
      const genericTags = [
        "ai",
        "tech",
        "news",
        "breaking",
        "market",
        "update",
        "latest",
      ];
      if (genericTags.includes(displayName.toLowerCase())) {
        logger.debug("Skipping generic tag", { displayName }, "TagService");
        continue;
      }

      parsedTags.push({
        displayName,
        category: categoryMatch?.[1]?.trim(),
      });
    }
  }

  if (parsedTags.length === 0) {
    logger.debug(
      "No specific tags extracted from post",
      {
        xmlPreview: xmlContent.substring(0, 200),
        contentPreview: content.substring(0, 100),
      },
      "TagService",
    );
  }

  const generatedTags: GeneratedTag[] = parsedTags
    .filter((tag) => tag.displayName && typeof tag.displayName === "string")
    .map((tag) => {
      const displayName = tag.displayName.trim();
      const name = displayName
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .trim();

      return {
        name,
        displayName,
        category: tag.category,
      };
    })
    .filter((tag) => tag.name.length > 0 && tag.displayName.length <= 50);

  logger.debug(
    "Generated tags from post",
    {
      content: content.slice(0, 100),
      tagsCount: generatedTags.length,
      tags: generatedTags,
    },
    "TagService",
  );

  return generatedTags;
}

/**
 * Generate tags in batch for multiple posts
 */
export async function generateTagsForPosts(
  posts: Array<{ id: string; content: string }>,
): Promise<Map<string, GeneratedTag[]>> {
  const results = new Map<string, GeneratedTag[]>();

  const BATCH_SIZE = 5;
  for (let i = 0; i < posts.length; i += BATCH_SIZE) {
    const batch = posts.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (post) => {
      const tagList = await generateTagsFromPost(post.content);
      return { postId: post.id, tags: tagList };
    });

    const batchResults = await Promise.all(promises);
    for (const { postId, tags: tagList } of batchResults) {
      results.set(postId, tagList);
    }

    if (i + BATCH_SIZE < posts.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return results;
}

// =============================================================================
// Tag Storage
// =============================================================================

/**
 * Store tags for a post
 * - Creates tags if they don't exist
 * - Links tags to post via PostTag join table
 */
export async function storeTagsForPost(
  postId: string,
  generatedTags: GeneratedTag[],
): Promise<void> {
  if (generatedTags.length === 0) {
    return;
  }

  const tagNames = generatedTags.map((t) => t.name);
  const existingTagsList = await db
    .select()
    .from(tags)
    .where(inArray(tags.name, tagNames));

  const existingTagMap = new Map(existingTagsList.map((t) => [t.name, t]));

  const tagsToCreate = generatedTags.filter((t) => !existingTagMap.has(t.name));

  if (tagsToCreate.length > 0) {
    const tagIds = await Promise.all(
      tagsToCreate.map(() => generateSnowflakeId()),
    );

    for (let index = 0; index < tagsToCreate.length; index++) {
      const tag = tagsToCreate[index];
      if (!tag) continue;
      const tagId = tagIds[index];
      if (!tagId) {
        throw new Error(`Failed to generate tag ID for index ${index}`);
      }

      await db
        .insert(tags)
        .values({
          id: tagId,
          name: tag.name,
          displayName: tag.displayName,
          category: tag.category || null,
          updatedAt: new Date(),
        })
        .onConflictDoNothing();
    }

    const createdTags = await db
      .select()
      .from(tags)
      .where(
        inArray(
          tags.name,
          tagsToCreate.map((t) => t.name),
        ),
      );

    createdTags.forEach((t) => existingTagMap.set(t.name, t));
    logger.debug(
      "Created/fetched new tags",
      { count: createdTags.length },
      "TagService",
    );
  }

  const postTagIds = await Promise.all(
    generatedTags.map(() => generateSnowflakeId()),
  );

  for (let idx = 0; idx < generatedTags.length; idx++) {
    const tag = generatedTags[idx];
    if (!tag) continue;
    const dbTag = existingTagMap.get(tag.name);
    if (!dbTag) {
      throw new Error(`Tag ${tag.name} not found in existing tags`);
    }
    const postTagId = postTagIds[idx];
    if (!postTagId) {
      throw new Error(`Failed to generate post tag ID for index ${idx}`);
    }

    await db
      .insert(postTags)
      .values({
        id: postTagId,
        postId,
        tagId: dbTag.id,
      })
      .onConflictDoNothing();
  }

  logger.debug(
    "Stored tags for post",
    { postId, tagCount: generatedTags.length },
    "TagService",
  );
}

/**
 * Get tags for a post
 */
export async function getTagsForPost(postId: string) {
  return db.query.postTags.findMany({
    where: eq(postTags.postId, postId),
    with: {
      tag: true,
    },
    orderBy: asc(postTags.createdAt),
  });
}

/**
 * Get posts by tag name
 */
export async function getPostsByTag(
  tagName: string,
  options: { limit?: number; offset?: number } = {},
) {
  const { limit = 20, offset = 0 } = options;

  const [tag] = await db
    .select()
    .from(tags)
    .where(eq(tags.name, tagName.toLowerCase()))
    .limit(1);

  if (!tag) {
    return { tag: null, posts: [], total: 0 };
  }

  const [postTagsList, totalResult] = await Promise.all([
    db.query.postTags.findMany({
      where: eq(postTags.tagId, tag.id),
      with: { post: true },
      orderBy: desc(postTags.createdAt),
      offset,
      limit,
    }),
    db
      .select({ count: count() })
      .from(postTags)
      .where(eq(postTags.tagId, tag.id)),
  ]);

  const total = totalResult[0]?.count ?? 0;

  return {
    tag,
    posts: postTagsList
      .map((pt) => pt.post)
      .filter((post): post is NonNullable<typeof post> => post !== null),
    total,
  };
}

/**
 * Get tag statistics (for trending calculation)
 */
export async function getTagStatistics(
  windowStart: Date,
  windowEnd: Date,
): Promise<
  Array<{
    tagId: string;
    tagName: string;
    tagDisplayName: string;
    tagCategory: string | null;
    postCount: number;
    recentPostCount: number;
    oldestPostDate: Date;
    newestPostDate: Date;
  }>
> {
  const last24Hours = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);

  // Query postTags within time window, then filter out deleted posts
  const allPostTags = await db.query.postTags.findMany({
    where: (pt, { and: andOp, gte: whereGte, lte: whereLte }) =>
      andOp(
        whereGte(pt.createdAt, windowStart),
        whereLte(pt.createdAt, windowEnd),
      ),
    with: {
      tag: true,
      post: true,
    },
    orderBy: asc(postTags.createdAt),
  });

  // Filter out postTags where the post is deleted
  const postTagsList = allPostTags.filter((pt) => !pt.post.deletedAt);

  const tagStats = new Map<
    string,
    {
      tag: {
        id: string;
        name: string;
        displayName: string;
        category: string | null;
      };
      postCount: number;
      recentPostCount: number;
      oldestPostDate: Date;
      newestPostDate: Date;
    }
  >();

  postTagsList.forEach((pt) => {
    const existing = tagStats.get(pt.tagId);
    const isRecent = pt.createdAt >= last24Hours;

    if (existing) {
      existing.postCount++;
      if (isRecent) existing.recentPostCount++;
      if (pt.createdAt < existing.oldestPostDate)
        existing.oldestPostDate = pt.createdAt;
      if (pt.createdAt > existing.newestPostDate)
        existing.newestPostDate = pt.createdAt;
    } else {
      tagStats.set(pt.tagId, {
        tag: pt.tag,
        postCount: 1,
        recentPostCount: isRecent ? 1 : 0,
        oldestPostDate: pt.createdAt,
        newestPostDate: pt.createdAt,
      });
    }
  });

  return Array.from(tagStats.values())
    .filter((stats) => stats.postCount >= 3)
    .map((stats) => ({
      tagId: stats.tag.id,
      tagName: stats.tag.name,
      tagDisplayName: stats.tag.displayName,
      tagCategory: stats.tag.category,
      postCount: stats.postCount,
      recentPostCount: stats.recentPostCount,
      oldestPostDate: stats.oldestPostDate,
      newestPostDate: stats.newestPostDate,
    }))
    .sort((a, b) => b.postCount - a.postCount);
}

/**
 * Store trending tags calculation results
 */
export async function storeTrendingTags(
  tagsList: Array<{
    tagId: string;
    score: number;
    postCount: number;
    rank: number;
    relatedContext?: string;
  }>,
  windowStart: Date,
  windowEnd: Date,
): Promise<void> {
  const trendingTagIds = await Promise.all(
    tagsList.map(() => generateSnowflakeId()),
  );

  await withTransaction(async (tx) => {
    for (let idx = 0; idx < tagsList.length; idx++) {
      const tag = tagsList[idx];
      if (!tag) continue;
      const trendingTagId = trendingTagIds[idx];
      if (!trendingTagId) {
        throw new Error(`Failed to generate trending tag ID for index ${idx}`);
      }
      await tx.insert(trendingTags).values({
        id: trendingTagId,
        tagId: tag.tagId,
        score: tag.score,
        postCount: tag.postCount,
        rank: tag.rank,
        windowStart,
        windowEnd,
        relatedContext: tag.relatedContext || null,
      });
    }
  });

  logger.info(
    "Stored trending tags",
    { count: tagsList.length, windowStart, windowEnd },
    "TagService",
  );
}

/**
 * Get current trending tags (most recent calculation)
 */
export async function getCurrentTrendingTags(
  limit = 10,
): Promise<TrendingTagWithTag[]> {
  const [latestCalculation] = await db
    .select({ calculatedAt: trendingTags.calculatedAt })
    .from(trendingTags)
    .orderBy(desc(trendingTags.calculatedAt))
    .limit(1);

  if (!latestCalculation) {
    return [];
  }

  const cutoffTime = new Date(latestCalculation.calculatedAt.getTime() - 1000);

  return (await db.query.trendingTags.findMany({
    where: gte(trendingTags.calculatedAt, cutoffTime),
    with: { tag: true },
    orderBy: asc(trendingTags.rank),
    limit,
  })) as TrendingTagWithTag[];
}

/**
 * Get related/co-occurring tags for a given tag
 */
export async function getRelatedTags(
  tagId: string,
  limit = 3,
): Promise<string[]> {
  const postsWithTagResult = await db
    .select({ postId: postTags.postId })
    .from(postTags)
    .where(eq(postTags.tagId, tagId))
    .orderBy(desc(postTags.createdAt))
    .limit(100);

  const postIds = postsWithTagResult.map((pt) => pt.postId);

  if (postIds.length === 0) {
    return [];
  }

  const coOccurringPostTags = await db
    .select({ tagId: postTags.tagId })
    .from(postTags)
    .where(and(inArray(postTags.postId, postIds), ne(postTags.tagId, tagId)));

  const tagCounts = new Map<string, number>();
  coOccurringPostTags.forEach((pt) => {
    tagCounts.set(pt.tagId, (tagCounts.get(pt.tagId) || 0) + 1);
  });

  const sortedTagIds = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);

  if (sortedTagIds.length === 0) {
    return [];
  }

  const tagsList = await db
    .select({ id: tags.id, displayName: tags.displayName })
    .from(tags)
    .where(inArray(tags.id, sortedTagIds));

  const tagMap = new Map(tagsList.map((t) => [t.id, t.displayName]));
  return sortedTagIds
    .map((id) => tagMap.get(id))
    .filter((name): name is string => name !== undefined);
}
