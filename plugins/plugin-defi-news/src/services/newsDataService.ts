import type { IAgentRuntime } from '@elizaos/core';
import { Service } from '@elizaos/core';
import type { RealWorldNewsArticle } from '../interfaces/types';

/**
 * RSS Feed Item Interface
 */
interface RSSItem {
    title?: string;
    link?: string;
    description?: string;
    pubDate?: string;
    category?: string[];
    guid?: string;
    content?: string;
    creator?: string;
}

/**
 * Brave New Coin RSS Service for Real-World Crypto Events
 * 
 * This service fetches real-world news and events related to cryptocurrency
 * from Brave New Coin RSS feed.
 */
export class NewsDataService extends Service {
    static serviceType = 'NEWS_DATA_SERVICE';
    private rssUrl: string = 'https://bravenewcoin.com/rss/insights';

    get capabilityDescription(): string {
        return 'Provides real-world cryptocurrency news and events from Brave New Coin RSS feed';
    }

    constructor(runtime?: IAgentRuntime) {
        super(runtime);
        console.log('✅ [NewsDataService] Initialized with Brave New Coin RSS feed');
    }

    /**
     * Start the NewsData service (static method for framework)
     */
    static async start(runtime: IAgentRuntime) {
        const service = new NewsDataService(runtime);
        return service;
    }

    /**
     * Stop the NewsData service (static method for framework)
     */
    static async stop(runtime: IAgentRuntime) {
        const service = runtime.getService(this.serviceType);
        if (!service) {
            throw new Error(this.serviceType + ' service not found');
        }
    }

    /**
     * Stop the service instance
     */
    async stop(): Promise<void> {
        console.log('✅ [NewsDataService] Stopped');
    }

    /**
     * Parse RSS XML to extract news items
     */
    private parseRSS(xmlText: string): RSSItem[] {
        const items: RSSItem[] = [];
        
        try {
            // Extract all <item> blocks from the RSS feed
            const itemRegex = /<item>([\s\S]*?)<\/item>/g;
            const itemMatches = xmlText.matchAll(itemRegex);

            for (const match of itemMatches) {
                const itemXml = match[1];
                
                // Extract individual fields
                const title = this.decodeHtmlEntities(this.extractTag(itemXml, 'title') || '');
                const link = this.extractTag(itemXml, 'link');
                const description = this.extractTag(itemXml, 'description');
                const pubDate = this.extractTag(itemXml, 'pubDate');
                const guid = this.extractTag(itemXml, 'guid');
                const creator = this.extractTag(itemXml, 'dc:creator') || this.extractTag(itemXml, 'author');
                const content = this.extractTag(itemXml, 'content:encoded');
                
                // Extract categories (handle CDATA)
                const categoryRegex = /<category>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/category>/gs;
                const categories: string[] = [];
                let categoryMatch;
                while ((categoryMatch = categoryRegex.exec(itemXml)) !== null) {
                    const cat = categoryMatch[1].trim();
                    if (cat) {
                        categories.push(cat);
                    }
                }

                items.push({
                    title,
                    link,
                    description,
                    pubDate,
                    category: categories.length > 0 ? categories : undefined,
                    guid,
                    creator,
                    content
                });
            }
        } catch (error) {
            console.error('❌ [NewsDataService] Error parsing RSS:', error);
        }

        return items;
    }

    /**
     * Extract content from XML tag
     */
    private extractTag(xml: string, tagName: string): string | undefined {
        const regex = new RegExp(`<${tagName}[^>]*><!\\[CDATA\\[(.*?)\\]\\]><\\/${tagName}>`, 's');
        const cdataMatch = xml.match(regex);
        if (cdataMatch) {
            return cdataMatch[1].trim();
        }

        const simpleRegex = new RegExp(`<${tagName}[^>]*>(.*?)<\\/${tagName}>`, 's');
        const simpleMatch = xml.match(simpleRegex);
        if (simpleMatch) {
            return simpleMatch[1].trim();
        }

        return undefined;
    }

    /**
     * Strip HTML tags from text
     */
    private stripHtml(html: string): string {
        return html.replace(/<[^>]*>/g, '').trim();
    }

    /**
     * Decode HTML entities (e.g., &#8217; to ')
     */
    private decodeHtmlEntities(text: string): string {
        const entities: Record<string, string> = {
            '&#8217;': "'",
            '&#8216;': "'",
            '&#8220;': '"',
            '&#8221;': '"',
            '&#8211;': '–',
            '&#8212;': '—',
            '&#038;': '&',
            '&amp;': '&',
            '&lt;': '<',
            '&gt;': '>',
            '&quot;': '"',
            '&#39;': "'",
        };

        let decoded = text;
        for (const [entity, char] of Object.entries(entities)) {
            decoded = decoded.replace(new RegExp(entity, 'g'), char);
        }

        // Handle numeric entities
        decoded = decoded.replace(/&#(\d+);/g, (match, dec) => {
            return String.fromCharCode(dec);
        });

        return decoded;
    }

    /**
     * Fetch latest crypto news from Brave New Coin RSS feed
     */
    async getLatestNews(options?: {
        query?: string;
        language?: string;
        category?: string;
        limit?: number;
    }): Promise<RealWorldNewsArticle[]> {
        try {
            const limit = options?.limit || 10;
            const query = options?.query?.toLowerCase();

            console.log(`🔍 [NewsDataService] Fetching news from Brave New Coin RSS feed`);

            const response = await fetch(this.rssUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; SpartanBot/1.0)',
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`❌ [NewsDataService] RSS fetch error (${response.status}): ${errorText}`);
                throw new Error(`RSS fetch error: ${response.status} ${response.statusText}`);
            }

            const xmlText = await response.text();
            const rssItems = this.parseRSS(xmlText);

            console.log(`✅ [NewsDataService] Parsed ${rssItems.length} news articles from RSS`);

            // Convert RSS items to RealWorldNewsArticle format
            let articles: RealWorldNewsArticle[] = rssItems.map((item, index) => ({
                article_id: item.guid || `bnc-${Date.now()}-${index}`,
                title: item.title || 'Untitled',
                link: item.link || '',
                description: item.description ? this.decodeHtmlEntities(this.stripHtml(item.description)) : undefined,
                pubDate: item.pubDate || new Date().toISOString(),
                source_id: 'bravenewcoin',
                source_priority: 1,
                source_url: 'https://bravenewcoin.com',
                language: 'en',
                category: item.category,
                creator: item.creator ? [item.creator] : undefined,
                keywords: undefined,
                video_url: null,
                content: item.content ? this.stripHtml(item.content) : undefined,
                image_url: undefined,
                source_icon: undefined,
                country: undefined,
                ai_tag: undefined,
                sentiment: undefined,
                sentiment_stats: undefined,
                ai_region: undefined
            }));

            // Filter by query if provided
            if (query) {
                articles = articles.filter(article => {
                    const searchText = `${article.title} ${article.description || ''} ${article.content || ''} ${article.category?.join(' ') || ''}`.toLowerCase();
                    return searchText.includes(query);
                });
                console.log(`🔍 [NewsDataService] Filtered to ${articles.length} articles matching query: ${query}`);
            }

            // Limit results
            articles = articles.slice(0, limit);

            return articles;
        } catch (error) {
            if (error instanceof Error) {
                console.error('❌ [NewsDataService] Error fetching news:', error.message);
                throw error;
            } else {
                console.error('❌ [NewsDataService] Unknown error:', error);
                throw new Error('Failed to fetch news from Brave New Coin RSS');
            }
        }
    }

    /**
     * Fetch news about a specific token
     */
    async getTokenNews(tokenSymbol: string, options?: {
        language?: string;
        limit?: number;
    }): Promise<RealWorldNewsArticle[]> {
        const query = tokenSymbol.toLowerCase();
        return this.getLatestNews({
            query,
            language: options?.language,
            limit: options?.limit
        });
    }

    /**
     * Fetch DeFi-specific news
     */
    async getDefiNews(options?: {
        language?: string;
        limit?: number;
    }): Promise<RealWorldNewsArticle[]> {
        const query = 'defi';
        return this.getLatestNews({
            query,
            language: options?.language,
            limit: options?.limit
        });
    }

    /**
     * Fetch blockchain and crypto market news
     */
    async getCryptoMarketNews(options?: {
        language?: string;
        limit?: number;
    }): Promise<RealWorldNewsArticle[]> {
        // Return all crypto news from the feed
        return this.getLatestNews({
            language: options?.language,
            limit: options?.limit
        });
    }
}

