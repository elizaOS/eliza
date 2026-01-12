import type { RssEnclosure, RssFeed, RssImage, RssItem } from "./types";

function parseTag(tag: string, str: string): string[] {
  const regex = new RegExp(`<${tag}(?:\\s+[^>]*)?>(.*?)</${tag}>`, "gs");
  const matches: string[] = [];
  let match: RegExpExecArray | null = regex.exec(str);
  while (match !== null) {
    const content = match[1];
    if (content !== undefined) {
      const value = content
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .trim();
      matches.push(value);
    }
    match = regex.exec(str);
  }
  return matches;
}

function parseCDATA(str: string | undefined): string {
  if (!str) return "";
  return str.replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1");
}

function parseImage(imageXml: string): RssImage | null {
  const imageMatch = /<image>(.*?)<\/image>/s.exec(imageXml);
  if (imageMatch?.[1]) {
    const imgContent = imageMatch[1];
    return {
      url: parseTag("url", imgContent)[0] ?? "",
      title: parseTag("title", imgContent)[0] ?? "",
      link: parseTag("link", imgContent)[0] ?? "",
      width: parseTag("width", imgContent)[0] ?? "",
      height: parseTag("height", imgContent)[0] ?? "",
    };
  }
  return null;
}

function parseEnclosure(itemXml: string): RssEnclosure | null {
  const enclosureTag = /<enclosure[^>]*\/?>/i.exec(itemXml);
  if (enclosureTag?.[0]) {
    const urlMatch = /url="([^"]*)"/.exec(enclosureTag[0]);
    const typeMatch = /type="([^"]*)"/.exec(enclosureTag[0]);
    const lengthMatch = /length="([^"]*)"/.exec(enclosureTag[0]);
    return {
      url: urlMatch?.[1] ?? "",
      type: typeMatch?.[1] ?? "",
      length: lengthMatch?.[1] ?? "",
    };
  }
  return null;
}

function parseItem(itemXml: string): RssItem {
  return {
    title: parseTag("title", itemXml)[0] ?? "",
    link: parseTag("link", itemXml)[0] ?? "",
    pubDate: parseTag("pubDate", itemXml)[0] ?? "",
    description: parseCDATA(parseTag("description", itemXml)[0]),
    author: parseTag("author", itemXml)[0] ?? "",
    category: parseTag("category", itemXml) ?? [],
    comments: parseTag("comments", itemXml)[0] ?? "",
    guid: parseTag("guid", itemXml)[0] ?? "",
    enclosure: parseEnclosure(itemXml),
  };
}

export function parseRssToJson(xml: string): RssFeed {
  try {
    const cleanXml = xml
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const channelRegex = /<channel>(.*?)<\/channel>/s;
    const channelMatch = channelRegex.exec(cleanXml);

    if (!channelMatch || !channelMatch[1]) {
      throw new Error("No channel element found in RSS feed");
    }

    const channelXml = channelMatch[1];
    const channel: RssFeed = {
      title: parseTag("title", channelXml)[0] ?? "",
      description: parseCDATA(parseTag("description", channelXml)[0]),
      link: parseTag("link", channelXml)[0] ?? "",
      language: parseTag("language", channelXml)[0] ?? "",
      copyright: parseTag("copyright", channelXml)[0] ?? "",
      lastBuildDate: parseTag("lastBuildDate", channelXml)[0] ?? "",
      generator: parseTag("generator", channelXml)[0] ?? "",
      docs: parseTag("docs", channelXml)[0] ?? "",
      ttl: parseTag("ttl", channelXml)[0] ?? "",
      image: parseImage(channelXml),
      items: [],
    };

    const itemRegex = /<item>(.*?)<\/item>/gs;
    let itemMatch: RegExpExecArray | null = itemRegex.exec(channelXml);

    while (itemMatch !== null) {
      if (itemMatch[1]) {
        channel.items.push(parseItem(itemMatch[1]));
      }
      itemMatch = itemRegex.exec(channelXml);
    }

    return channel;
  } catch {
    return {
      title: "",
      description: "",
      link: "",
      language: "",
      copyright: "",
      lastBuildDate: "",
      generator: "",
      docs: "",
      ttl: "",
      image: null,
      items: [],
    };
  }
}

export function createEmptyFeed(): RssFeed {
  return {
    title: "",
    description: "",
    link: "",
    language: "",
    copyright: "",
    lastBuildDate: "",
    generator: "",
    docs: "",
    ttl: "",
    image: null,
    items: [],
  };
}
