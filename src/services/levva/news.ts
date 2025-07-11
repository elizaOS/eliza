import { desc, eq, isNotNull, not } from "drizzle-orm";
import { IAgentRuntime } from "@elizaos/core";
import { PageContent } from "../browser";
import { newsTable } from "../../schema";
import { CacheEntry } from "../../types/core";
import { getDb } from "../../util/db/client";
import { xmlParser } from "../../util/xml";

const FEED_ITEM_PREFIX = "news-item:";

export const isFeedItem = (id: string) => id.startsWith(FEED_ITEM_PREFIX);
export const getFeedItemId = (url: string) => `${FEED_ITEM_PREFIX}${url}`;

export const onFeedItem = async (
  runtime: IAgentRuntime,
  id: string,
  value: PageContent
) => {
  const db = getDb(runtime);
  const link = id.slice(FEED_ITEM_PREFIX.length);

  await db
    .insert(newsTable)
    .values({
      ...value,
      link,
    })
    .onConflictDoNothing();
};

export const getLatestNews = async (runtime: IAgentRuntime, limit = 10) => {
  const db = getDb(runtime);

  return await db
    .select()
    .from(newsTable)
    .where(not(eq(newsTable.description, "")))
    .orderBy(desc(newsTable.createdAt))
    .limit(limit);
};

export const getFeed = async (runtime: IAgentRuntime, url: string) => {
  const cacheKey = `rss:${url}`;
  const ttl = 15 * 60 * 1000;
  const timestamp = Date.now();

  const cached =
    await runtime.getCache<CacheEntry<{ title: string; link: string }[]>>(
      cacheKey
    );

  let items: { title: string; link: string }[] = [];

  if (cached?.timestamp && timestamp - cached.timestamp < ttl) {
    items = cached.value;
  } else {
    const response = await fetch(url);
    const text = await response.text();
    const parsedXml = xmlParser.parse(text);

    if (!parsedXml?.rss?.channel?.item) {
      throw new Error("No items found in feed");
    }

    items = parsedXml.rss.channel.item as {
      title: string;
      link: string;
    }[];

    await runtime.setCache(cacheKey, {
      timestamp,
      value: items,
    });
  }

  return items;
};
