/**
 * RSS/Atom Feed Parser
 * 
 * Pure XML parsing without external dependencies.
 * Supports RSS 2.0 and basic Atom feeds.
 */

import type { RssFeed, RssItem, RssImage, RssEnclosure } from './types';

/**
 * Helper function to safely parse XML tags with error handling
 */
function parseTag(tag: string, str: string): string[] {
  try {
    const regex = new RegExp(`<${tag}(?:\\s+[^>]*)?>(.*?)</${tag}>`, 'gs');
    const matches: string[] = [];
    let match;
    while ((match = regex.exec(str)) !== null) {
      // Decode HTML entities and trim whitespace
      const content = match[1];
      if (content !== undefined) {
        const value = content
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .trim();
        matches.push(value);
      }
    }
    return matches;
  } catch (error) {
    console.error(`Error parsing tag ${tag}:`, error);
    return [];
  }
}

/**
 * Helper function to parse CDATA sections
 */
function parseCDATA(str: string | undefined): string {
  if (!str) return '';
  return str.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1');
}

/**
 * Parse RSS image element
 */
function parseImage(imageXml: string): RssImage | null {
  const imageMatch = /<image>(.*?)<\/image>/s.exec(imageXml);
  if (imageMatch && imageMatch[1]) {
    const imgContent = imageMatch[1];
    return {
      url: parseTag('url', imgContent)[0] ?? '',
      title: parseTag('title', imgContent)[0] ?? '',
      link: parseTag('link', imgContent)[0] ?? '',
      width: parseTag('width', imgContent)[0] ?? '',
      height: parseTag('height', imgContent)[0] ?? '',
    };
  }
  return null;
}

/**
 * Parse RSS enclosure element
 */
function parseEnclosure(itemXml: string): RssEnclosure | null {
  const enclosureTag = /<enclosure[^>]*\/?>/i.exec(itemXml);
  if (enclosureTag && enclosureTag[0]) {
    const urlMatch = /url="([^"]*)"/.exec(enclosureTag[0]);
    const typeMatch = /type="([^"]*)"/.exec(enclosureTag[0]);
    const lengthMatch = /length="([^"]*)"/.exec(enclosureTag[0]);
    return {
      url: urlMatch?.[1] ?? '',
      type: typeMatch?.[1] ?? '',
      length: lengthMatch?.[1] ?? ''
    };
  }
  return null;
}

/**
 * Parse a single RSS item
 */
function parseItem(itemXml: string): RssItem {
  return {
    title: parseTag('title', itemXml)[0] ?? '',
    link: parseTag('link', itemXml)[0] ?? '',
    pubDate: parseTag('pubDate', itemXml)[0] ?? '',
    description: parseCDATA(parseTag('description', itemXml)[0]),
    author: parseTag('author', itemXml)[0] ?? '',
    category: parseTag('category', itemXml) ?? [],
    comments: parseTag('comments', itemXml)[0] ?? '',
    guid: parseTag('guid', itemXml)[0] ?? '',
    enclosure: parseEnclosure(itemXml)
  };
}

/**
 * Parse RSS/Atom XML string to JSON
 * 
 * @param xml - Raw XML string from RSS feed
 * @returns Parsed RssFeed object
 */
export function parseRssToJson(xml: string): RssFeed {
  try {
    // Remove comments and normalize whitespace
    const cleanXml = xml
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Parse channel metadata
    const channelRegex = /<channel>(.*?)<\/channel>/s;
    const channelMatch = channelRegex.exec(cleanXml);

    if (!channelMatch || !channelMatch[1]) {
      throw new Error('No channel element found in RSS feed');
    }

    const channelXml = channelMatch[1];

    // Extract standard RSS channel elements
    const channel: RssFeed = {
      title: parseTag('title', channelXml)[0] ?? '',
      description: parseCDATA(parseTag('description', channelXml)[0]),
      link: parseTag('link', channelXml)[0] ?? '',
      language: parseTag('language', channelXml)[0] ?? '',
      copyright: parseTag('copyright', channelXml)[0] ?? '',
      lastBuildDate: parseTag('lastBuildDate', channelXml)[0] ?? '',
      generator: parseTag('generator', channelXml)[0] ?? '',
      docs: parseTag('docs', channelXml)[0] ?? '',
      ttl: parseTag('ttl', channelXml)[0] ?? '',
      image: parseImage(channelXml),
      items: []
    };

    // Parse items
    const itemRegex = /<item>(.*?)<\/item>/gs;
    let itemMatch;

    while ((itemMatch = itemRegex.exec(channelXml)) !== null) {
      if (itemMatch[1]) {
        channel.items.push(parseItem(itemMatch[1]));
      }
    }

    return channel;
  } catch (error) {
    console.error('Error parsing RSS feed:', error);
    return {
      title: '',
      description: '',
      link: '',
      language: '',
      copyright: '',
      lastBuildDate: '',
      generator: '',
      docs: '',
      ttl: '',
      image: null,
      items: []
    };
  }
}

/**
 * Create an empty RSS feed structure
 */
export function createEmptyFeed(): RssFeed {
  return {
    title: '',
    description: '',
    link: '',
    language: '',
    copyright: '',
    lastBuildDate: '',
    generator: '',
    docs: '',
    ttl: '',
    image: null,
    items: []
  };
}

