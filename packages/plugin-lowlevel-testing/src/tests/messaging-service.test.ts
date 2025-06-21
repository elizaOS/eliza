import type { IAgentRuntime, TestSuite } from '@elizaos/core';
import { strict as assert } from 'node:assert';

export const messagingServiceTestSuite: TestSuite = {
  name: 'Messaging Service Real Implementation Tests',
  tests: [
    {
      name: 'Test 1: Should discover messaging services',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Discovering messaging services...');

        // Check for Discord plugin
        const discordPlugin = runtime.plugins.find(
          (p) =>
            p.name === 'discord' ||
            p.name === '@elizaos/plugin-discord' ||
            p.name === 'plugin-discord'
        );
        if (discordPlugin) {
          console.log('✓ Discord plugin loaded');
        } else {
          console.log('⚠️  Discord plugin not loaded');
        }

        // Check for Twitter plugin
        const twitterPlugin = runtime.plugins.find(
          (p) =>
            p.name === 'twitter' ||
            p.name === '@elizaos/plugin-twitter' ||
            p.name === 'plugin-twitter'
        );
        if (twitterPlugin) {
          console.log('✓ Twitter plugin loaded');
        } else {
          console.log('⚠️  Twitter plugin not loaded');
        }

        // Check for registered services
        console.log('\nChecking for messaging services...');

        // Discord service
        const discordService = runtime.getService('discord') as any;
        if (discordService) {
          console.log('✓ Discord service registered');
        }

        // Twitter service
        const twitterService = runtime.getService('twitter') as any;
        if (twitterService) {
          console.log('✓ Twitter service registered');
        }
      },
    },

    {
      name: 'Test 2: Should test Discord service configuration',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing Discord service configuration...');

        const discordService = runtime.getService('discord') as any;
        if (!discordService) {
          console.log('⚠️  No Discord service found, skipping');
          return;
        }

        // Check service properties
        console.log('Discord service properties:');
        if (discordService.name) {
          console.log(`  Name: ${discordService.name}`);
        }

        if (discordService.capabilityDescription) {
          console.log(`  Description: ${discordService.capabilityDescription}`);
        }

        // Check configuration
        const hasToken = !!runtime.getSetting('DISCORD_BOT_TOKEN');
        const hasAppId = !!runtime.getSetting('DISCORD_APPLICATION_ID');

        console.log('\nDiscord configuration:');
        console.log(`  Bot Token: ${hasToken ? '✓ Set' : '✗ Not set'}`);
        console.log(`  Application ID: ${hasAppId ? '✓ Set' : '✗ Not set'}`);

        if (!hasToken || !hasAppId) {
          console.log('\n⚠️  Discord service requires:');
          console.log('  - DISCORD_BOT_TOKEN');
          console.log('  - DISCORD_APPLICATION_ID');
        }

        // Check if client is connected
        if (discordService.client) {
          console.log('\n✓ Discord client exists');

          if (discordService.client.isReady && discordService.client.isReady()) {
            console.log('✓ Discord client is ready');

            // Get bot info
            if (discordService.client.user) {
              console.log(`  Bot: ${discordService.client.user.tag}`);
              console.log(`  ID: ${discordService.client.user.id}`);
            }
          } else {
            console.log('⚠️  Discord client not ready');
          }
        }
      },
    },

    {
      name: 'Test 3: Should test Twitter service configuration',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing Twitter service configuration...');

        const twitterService = runtime.getService('twitter') as any;
        if (!twitterService) {
          console.log('⚠️  No Twitter service found, skipping');
          return;
        }

        // Check service properties
        console.log('Twitter service properties:');
        if (twitterService.name) {
          console.log(`  Name: ${twitterService.name}`);
        }

        if (twitterService.capabilityDescription) {
          console.log(`  Description: ${twitterService.capabilityDescription}`);
        }

        // Check configuration
        const hasApiKey = !!runtime.getSetting('TWITTER_API_KEY');
        const hasApiSecret = !!runtime.getSetting('TWITTER_API_SECRET');
        const hasAccessToken = !!runtime.getSetting('TWITTER_ACCESS_TOKEN');
        const hasAccessSecret = !!runtime.getSetting('TWITTER_ACCESS_SECRET');

        console.log('\nTwitter configuration:');
        console.log(`  API Key: ${hasApiKey ? '✓ Set' : '✗ Not set'}`);
        console.log(`  API Secret: ${hasApiSecret ? '✓ Set' : '✗ Not set'}`);
        console.log(`  Access Token: ${hasAccessToken ? '✓ Set' : '✗ Not set'}`);
        console.log(`  Access Secret: ${hasAccessSecret ? '✓ Set' : '✗ Not set'}`);

        if (!hasApiKey || !hasApiSecret || !hasAccessToken || !hasAccessSecret) {
          console.log('\n⚠️  Twitter service requires:');
          console.log('  - TWITTER_API_KEY');
          console.log('  - TWITTER_API_SECRET');
          console.log('  - TWITTER_ACCESS_TOKEN');
          console.log('  - TWITTER_ACCESS_SECRET');
        }

        // Check if client is authenticated
        if (twitterService.client) {
          console.log('\n✓ Twitter client exists');
        }
      },
    },

    {
      name: 'Test 4: Should test Discord message capabilities',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing Discord message capabilities...');

        const discordService = runtime.getService('discord') as any;
        if (!discordService || !discordService.client) {
          console.log('⚠️  Discord service not available');
          return;
        }

        // Check available methods
        console.log('Discord service methods:');

        if (typeof discordService.sendMessage === 'function') {
          console.log('  ✓ sendMessage method exists');
        }

        if (typeof discordService.replyToMessage === 'function') {
          console.log('  ✓ replyToMessage method exists');
        }

        if (typeof discordService.sendEmbed === 'function') {
          console.log('  ✓ sendEmbed method exists');
        }

        // Check guild/channel access
        if (discordService.client.guilds) {
          const guildCount = discordService.client.guilds.cache?.size || 0;
          console.log(`\n✓ Bot is in ${guildCount} guilds`);

          if (guildCount > 0) {
            // Show first few guilds
            const guilds = Array.from(discordService.client.guilds.cache.values()).slice(0, 3);
            console.log('  Sample guilds:');
            guilds.forEach((guild: any) => {
              console.log(`    - ${guild.name} (${guild.id})`);
            });
          }
        }

        console.log('\n⚠️  Skipping actual message sending (would spam channels)');
      },
    },

    {
      name: 'Test 5: Should test Twitter post capabilities',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing Twitter post capabilities...');

        const twitterService = runtime.getService('twitter') as any;
        if (!twitterService) {
          console.log('⚠️  Twitter service not available');
          return;
        }

        // Check available methods
        console.log('Twitter service methods:');

        if (typeof twitterService.postTweet === 'function') {
          console.log('  ✓ postTweet method exists');
        }

        if (typeof twitterService.replyToTweet === 'function') {
          console.log('  ✓ replyToTweet method exists');
        }

        if (typeof twitterService.likeTweet === 'function') {
          console.log('  ✓ likeTweet method exists');
        }

        if (typeof twitterService.retweet === 'function') {
          console.log('  ✓ retweet method exists');
        }

        if (typeof twitterService.getTimeline === 'function') {
          console.log('  ✓ getTimeline method exists');
        }

        // Test account info retrieval
        if (typeof twitterService.getAccountInfo === 'function') {
          try {
            console.log('\nFetching Twitter account info...');
            const accountInfo = await twitterService.getAccountInfo();

            if (accountInfo) {
              console.log('✓ Twitter account connected');
              console.log(`  Username: @${accountInfo.username || 'unknown'}`);
              console.log(`  Name: ${accountInfo.name || 'unknown'}`);
            }
          } catch (error) {
            console.log(
              '⚠️  Could not fetch account info:',
              error instanceof Error ? error.message : String(error)
            );
          }
        }

        console.log('\n⚠️  Skipping actual tweet posting (would post to timeline)');
      },
    },

    {
      name: 'Test 6: Should test IPostService interface compliance',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing IPostService interface compliance...');

        // Check if Twitter implements IPostService
        const twitterService = runtime.getService('twitter') as any;
        if (twitterService) {
          console.log('\nChecking Twitter IPostService methods:');

          const postServiceMethods = ['start', 'generateNewTweet', 'postTweet', 'stop'];
          postServiceMethods.forEach((method) => {
            if (typeof twitterService[method] === 'function') {
              console.log(`  ✓ ${method} method exists`);
            } else {
              console.log(`  ✗ ${method} method missing`);
            }
          });
        }

        // Note about messaging standards
        console.log('\n📝 Note: Messaging services should implement:');
        console.log('  - IMessageService for chat platforms (Discord, Slack)');
        console.log('  - IPostService for social media (Twitter, Farcaster)');
        console.log('  - Common methods: send, reply, react, delete');
      },
    },
  ],
};

export default messagingServiceTestSuite;
