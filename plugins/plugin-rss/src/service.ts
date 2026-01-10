import { IAgentRuntime, Service, logger, Memory, createUniqueUuid, TaskWorker } from '@elizaos/core';
import type { RssFeed, RssItem, FeedSubscriptionMetadata } from './types';


export class rssService extends Service {
  private isRunning = false;
  private registry: Record<number, any> = {};

  static serviceType = 'RSS';
  capabilityDescription = 'The agent is able to deal with RSS/atom feeds';

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.registry = {};
  }

  async fetchUrl(urlToFetch: string) {
    let response
    try {
      // axios.get
      const resp = await fetch(urlToFetch);
      response = await resp.text()
      //console.log('response', response)
      if (!response) {
        console.log('No response for', urlToFetch)
        return false
      }

      const data = this.parseRssToJson(response)
      if (!data) {
        console.log('no rss data in', response)
      }
      //console.log('data', data)
      return data
    } catch (error) {
      console.error('fetch error', error, 'response', response)
    }
  }

  parseRssToJson(xml: string): RssFeed {
    // Helper function to safely parse XML tags with error handling
    const parseTag = (tag: string, str: string) => {
      try {
        const regex = new RegExp(`<${tag}(?:\\s+[^>]*)?>(.*?)</${tag}>`, 'gs');
        const matches: string[] = [];
        let match;
        while ((match = regex.exec(str)) !== null) {
          // Decode HTML entities and trim whitespace
          const value = match[1]
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .trim();
          matches.push(value);
        }
        return matches;
      } catch (error) {
        console.error(`Error parsing tag ${tag}:`, error);
        return [];
      }
    };

    // Helper function to parse CDATA sections
    const parseCDATA = (str: string) => {
      return str.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1');
    };

    try {
      // Remove comments and normalize whitespace
      xml = xml
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      // Parse channel metadata
      const channelRegex = /<channel>(.*?)<\/channel>/s;
      const channelMatch = channelRegex.exec(xml);

      if (!channelMatch) {
        throw new Error('No channel element found in RSS feed');
      }

      const channelXml = channelMatch[1];

      // Extract standard RSS channel elements
      const channel = {
        title: parseTag('title', channelXml)[0] || '',
        description: parseCDATA(parseTag('description', channelXml)[0] || ''),
        link: parseTag('link', channelXml)[0] || '',
        language: parseTag('language', channelXml)[0] || '',
        copyright: parseTag('copyright', channelXml)[0] || '',
        lastBuildDate: parseTag('lastBuildDate', channelXml)[0] || '',
        generator: parseTag('generator', channelXml)[0] || '',
        docs: parseTag('docs', channelXml)[0] || '',
        ttl: parseTag('ttl', channelXml)[0] || '',
        image: (() => {
          const imageXml = /<image>(.*?)<\/image>/s.exec(channelXml);
          if (imageXml) {
            return {
              url: parseTag('url', imageXml[1])[0] || '',
              title: parseTag('title', imageXml[1])[0] || '',
              link: parseTag('link', imageXml[1])[0] || '',
              width: parseTag('width', imageXml[1])[0] || '',
              height: parseTag('height', imageXml[1])[0] || '',
            };
          }
          return null;
        })()
      };

      // Parse items
      const items: RssItem[] = [];
      const itemRegex = /<item>(.*?)<\/item>/gs;
      let itemMatch;

      while ((itemMatch = itemRegex.exec(channelXml)) !== null) {
        const itemXml = itemMatch[1];
        const item = {
          title: parseTag('title', itemXml)[0] || '',
          link: parseTag('link', itemXml)[0] || '',
          pubDate: parseTag('pubDate', itemXml)[0] || '',
          description: parseCDATA(parseTag('description', itemXml)[0] || ''),
          author: parseTag('author', itemXml)[0] || '',
          category: parseTag('category', itemXml) || [],
          comments: parseTag('comments', itemXml)[0] || '',
          guid: parseTag('guid', itemXml)[0] || '',
          enclosure: (() => {
            const enclosureTag = /<enclosure[^>]*\/?>/i.exec(itemXml);
            if (enclosureTag) {
              const url = /url="([^"]*)"/.exec(enclosureTag[0]);
              const type = /type="([^"]*)"/.exec(enclosureTag[0]);
              const length = /length="([^"]*)"/.exec(enclosureTag[0]);
              return {
                url: url ? url[1] : '',
                type: type ? type[1] : '',
                length: length ? length[1] : ''
              };
            }
            return null;
          })()
        };
        items.push(item);
      }

      return { ...channel, items };
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
   * Subscribe to an RSS feed
   * @param url - The RSS feed URL
   * @param title - Optional feed title (will be fetched if not provided)
   */
  async subscribeFeed(url: string, title?: string): Promise<boolean> {
    try {
      const feedId = createUniqueUuid(this.runtime, `feed_sub_${url}`);
      
      // Check if already subscribed
      const existing = await this.runtime.getMemoriesByIds([feedId], 'feedsubscriptions');
      if (existing && existing.length > 0) {
        logger.info(`Already subscribed to feed: ${url}`);
        return true;
      }

      // Fetch feed title if not provided
      let feedTitle = title;
      if (!feedTitle) {
        const feedData = await this.fetchUrl(url);
        if (feedData) {
          feedTitle = feedData.title;
        }
      }

      const subscriptionMemory: Memory = {
        id: feedId,
        entityId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        content: {
          text: feedTitle || url,
          url: url
        },
        roomId: this.runtime.agentId, // Use agentId as roomId for service-level storage
        createdAt: Date.now(),
        metadata: {
          type: 'feed_subscription',
          subscribedAt: Date.now(),
          lastChecked: 0,
          lastItemCount: 0
        }
      };

      await this.runtime.createMemory(subscriptionMemory, 'feedsubscriptions');
      logger.info(`Subscribed to RSS feed: ${feedTitle || url} (${url})`);
      return true;
    } catch (error) {
      logger.error({ error }, `Error subscribing to feed: ${url}`);
      return false;
    }
  }

  /**
   * Unsubscribe from an RSS feed
   * @param url - The RSS feed URL
   */
  async unsubscribeFeed(url: string): Promise<boolean> {
    try {
      const feedId = createUniqueUuid(this.runtime, `feed_sub_${url}`);
      
      // Check if subscribed
      const existing = await this.runtime.getMemoriesByIds([feedId], 'feedsubscriptions');
      if (!existing || existing.length === 0) {
        logger.warn({ url }, 'Not subscribed to feed');
        return false;
      }

      await this.runtime.deleteMemory(feedId);
      logger.info(`Unsubscribed from RSS feed: ${url}`);
      return true;
    } catch (error) {
      logger.error({ error }, `Error unsubscribing from feed: ${url}`);
      return false;
    }
  }

  /**
   * Get all subscribed feeds
   */
  async getSubscribedFeeds(): Promise<Memory[]> {
    try {
      const feeds = await this.runtime.getMemories({
        tableName: 'feedsubscriptions',
        unique: false,
      });
      return feeds || [];
    } catch (error) {
      logger.error({ error }, 'Error getting subscribed feeds');
      return [];
    }
  }

  /**
   * Check all subscribed feeds and store new items
   */
  async checkAllFeeds(): Promise<void> {
    try {
      const feeds = await this.getSubscribedFeeds();
      logger.info(`Checking ${feeds.length} subscribed RSS feeds...`);

      for (const feed of feeds) {
        try {
          const url = feed.content.url;
          if (!url) {
            logger.warn({ feedId: feed.id }, 'Feed subscription missing URL');
            continue;
          }

          logger.debug(`Fetching feed: ${url}`);
          const feedData = await this.fetchUrl(url);
          
          if (!feedData || !feedData.items) {
            logger.warn(`No data returned for feed: ${url}`);
            continue;
          }

          let newItemCount = 0;

          // Process each item with improved duplicate detection
          for (const item of feedData.items) {
            // Primary ID: based on guid
            const primaryId = createUniqueUuid(this.runtime, `${url}_${item.guid}`);
            
            // Fallback ID: based on title and pubDate (for feeds with inconsistent guids)
            const fallbackId = createUniqueUuid(this.runtime, `${url}_${item.title}_${item.pubDate}`);

            // Check both IDs to avoid duplicates
            const existingByGuid = await this.runtime.getMemoriesByIds([primaryId], 'feeditems');
            const existingByTitleDate = await this.runtime.getMemoriesByIds([fallbackId], 'feeditems');

            // Only create if item doesn't exist by either method
            if ((!existingByGuid || existingByGuid.length === 0) && 
                (!existingByTitleDate || existingByTitleDate.length === 0)) {
              
              // Use primary ID if guid exists, otherwise use fallback
              const itemId = item.guid ? primaryId : fallbackId;

              const itemMemory: Memory = {
                id: itemId,
                entityId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                content: {
                  text: item.title,
                  url: item.link
                },
                roomId: this.runtime.agentId,
                createdAt: Date.now(),
                metadata: {
                  ...item,
                  feedUrl: url,
                  feedTitle: feedData.title,
                  type: 'feed_item'
                }
              };

              await this.runtime.createMemory(itemMemory, 'feeditems');
              newItemCount++;
            }
          }

          // Update feed subscription metadata
          const currentMetadata = feed.metadata as FeedSubscriptionMetadata;
          await this.runtime.updateMemory({
            id: feed.id!,
            metadata: {
              ...currentMetadata,
              lastChecked: Date.now(),
              lastItemCount: feedData.items.length
            } as FeedSubscriptionMetadata
          });

          if (newItemCount > 0) {
            logger.info(`Found ${newItemCount} new items from feed: ${feedData.title || url}`);
          } else {
            logger.debug(`No new items from feed: ${feedData.title || url}`);
          }

        } catch (error) {
          logger.error({ error }, `Error checking feed: ${feed.content.url}`);
          // Continue with next feed even if one fails
          continue;
        }
      }

      logger.info('Completed checking all RSS feeds');
    } catch (error) {
      logger.error({ error }, 'Error in checkAllFeeds');
    }
  }

  /**
   * Load initial feeds from environment configuration
   */
  private async loadInitialFeeds(): Promise<void> {
    const rssFeeds = this.runtime.getSetting('RSS_FEEDS');
    
    if (!rssFeeds) {
      logger.debug('No RSS_FEEDS configured in environment');
      return;
    }

    try {
      let feedUrls: string[] = [];

      // Try to parse as JSON array first
      if (typeof rssFeeds === 'string') {
        try {
          const parsed = JSON.parse(rssFeeds);
          if (Array.isArray(parsed)) {
            feedUrls = parsed;
          } else {
            // Treat as comma-separated list
            feedUrls = rssFeeds.split(',').map(url => url.trim()).filter(url => url.length > 0);
          }
        } catch {
          // Not JSON, treat as comma-separated
          feedUrls = rssFeeds.split(',').map(url => url.trim()).filter(url => url.length > 0);
        }
      } else if (Array.isArray(rssFeeds)) {
        feedUrls = rssFeeds;
      }

      logger.info(`Loading ${feedUrls.length} RSS feeds from configuration...`);

      for (const url of feedUrls) {
        await this.subscribeFeed(url);
      }

      logger.info('Completed loading initial RSS feeds');
    } catch (error) {
      logger.error({ error }, 'Error loading initial RSS feeds from configuration');
    }
  }

  /**
   * Register the RSS feed check task worker
   */
  private registerFeedCheckWorker(): void {
    const worker: TaskWorker = {
      name: 'RSS_FEED_CHECK',
      validate: async (_runtime, _message) => {
        return true;
      },
      execute: async (runtime) => {
        try {
          logger.debug('Executing RSS feed check task');
          const service = runtime.getService('RSS') as rssService;
          if (service) {
            await service.checkAllFeeds();
          }
        } catch (error) {
          logger.error({ error }, 'Error executing RSS feed check task');
        }
      },
    };

    this.runtime.registerTaskWorker(worker);
    logger.info('Registered RSS_FEED_CHECK task worker');
  }


  /**
   * Start the scenario service with the given runtime.
   * @param {IAgentRuntime} runtime - The agent runtime
   * @returns {Promise<ScenarioService>} - The started scenario service
   */
  static async start(runtime: IAgentRuntime) {
    const service = new rssService(runtime);
    service.start();
    return service;
  }
  /**
   * Stops the Scenario service associated with the given runtime.
   *
   * @param {IAgentRuntime} runtime The runtime to stop the service for.
   * @throws {Error} When the Scenario service is not found.
   */
  static async stop(runtime: IAgentRuntime) {
    const service = runtime.getService(this.serviceType);
    if (!service) {
      throw new Error(this.serviceType + ' service not found');
    }
    service.stop();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('RSS service is already running');
      return;
    }

    try {
      logger.info('Starting RSS service...');

      // Register the feed check task worker
      this.registerFeedCheckWorker();

      // Load initial feeds from environment configuration
      await this.loadInitialFeeds();

      // Create periodic feed check task
      // TODO: Make check interval configurable via RSS_CHECK_INTERVAL_MINUTES env var
      const checkIntervalMinutes = 15; // Default 15 minutes
      const intervalInMs = checkIntervalMinutes * 60 * 1000;

      await this.runtime.createTask({
        name: 'RSS_FEED_CHECK',
        description: 'Periodically check RSS feeds for new items',
        worldId: this.runtime.agentId, // Use agentId as worldId for service-level tasks
        metadata: {
          createdAt: Date.now(),
          updatedAt: Date.now(),
          updateInterval: intervalInMs,
        },
        tags: ['queue', 'repeat', 'rss'],
      });

      logger.info(`RSS periodic feed check task created (interval: ${checkIntervalMinutes} minutes)`);

      this.isRunning = true;
      logger.info('RSS service started successfully');
    } catch (error) {
      logger.error({ error }, 'Error starting RSS service');
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('RSS service is not running');
      return;
    }

    try {
      logger.info('Stopping RSS service...');

      this.isRunning = false;
      logger.info('RSS service stopped successfully');
    } catch (error) {
      logger.error({ error }, 'Error stopping RSS service');
      throw error;
    }
  }

  isServiceRunning(): boolean {
    return this.isRunning;
  }
}

