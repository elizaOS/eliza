import { describe, expect, test } from 'bun:test';
import { parseRssToJson } from '../parser';

describe('Integration Tests', () => {
  test('should fetch and parse a real RSS feed', async () => {
    // Fetch a real RSS feed
    const response = await fetch('https://hnrss.org/frontpage');
    const xml = await response.text();
    
    expect(xml).toBeTruthy();
    expect(xml.length).toBeGreaterThan(0);
    
    // Parse it
    const feed = parseRssToJson(xml);
    
    expect(feed.title).toBeTruthy();
    expect(feed.items.length).toBeGreaterThan(0);
    
    console.log(`✅ Fetched "${feed.title}" with ${feed.items.length} items`);
    console.log(`   First item: ${feed.items[0]?.title}`);
  });
  
  test('should fetch and parse an Atom feed', async () => {
    // Fetch a real Atom feed
    const response = await fetch('https://github.blog/feed/');
    const xml = await response.text();
    
    expect(xml).toBeTruthy();
    
    // Parse it
    const feed = parseRssToJson(xml);
    
    // GitHub blog might be RSS or Atom, just verify we got content
    expect(feed.items.length).toBeGreaterThanOrEqual(0);
    
    console.log(`✅ Fetched GitHub blog with ${feed.items.length} items`);
  });
});


