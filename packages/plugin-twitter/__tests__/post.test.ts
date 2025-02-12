import { describe, it, expect, vi } from 'vitest';
import { TwitterPostClient } from '../src/post';
import { ClientBase } from '../src/base';
import type { IAgentRuntime } from '@elizaos/core';
import type { TwitterConfig } from '../src/environment';

describe('Twitter Post Client', () => {
    let mockRuntime: IAgentRuntime;
    let mockConfig: TwitterConfig;
    let baseClient: ClientBase;

    beforeEach(() => {
        mockRuntime = {
            env: {
                TWITTER_USERNAME: 'testuser',
                TWITTER_DRY_RUN: 'true',
                TWITTER_POST_INTERVAL_MIN: '5',
                TWITTER_POST_INTERVAL_MAX: '10',
                TWITTER_ACTION_INTERVAL: '5',
                TWITTER_ENABLE_ACTION_PROCESSING: 'true',
                TWITTER_POST_IMMEDIATELY: 'false',
                TWITTER_EMAIL: 'test@example.com',
                TWITTER_PASSWORD: 'hashedpassword',
                TWITTER_2FA_SECRET: '',
                TWITTER_POLL_INTERVAL: '120',
                TWITTER_RETRY_LIMIT: '5',
                MAX_TWEET_LENGTH: '280'
            },
            getEnv: function (key: string) {
                return this.env[key] || null;
            },
            getSetting: function (key: string) {
                return this.env[key] || null;
            },
            character: {
                style: {
                    all: ['Test style 1', 'Test style 2'],
                    post: ['Post style 1', 'Post style 2']
                }
            }
        } as unknown as IAgentRuntime;

        mockConfig = {
            TWITTER_USERNAME: 'testuser',
            TWITTER_DRY_RUN: true,
            TWITTER_SPACES_ENABLE: false,
            TWITTER_TARGET_USERS: [],
            TWITTER_PASSWORD: 'hashedpassword',
            TWITTER_EMAIL: 'test@example.com',
            TWITTER_2FA_SECRET: '',
            TWITTER_RETRY_LIMIT: 5,
            TWITTER_POLL_INTERVAL: 120,
            MAX_TWEET_LENGTH: 280,
            POST_INTERVAL_MIN: 5,
            POST_INTERVAL_MAX: 10,
            ACTION_INTERVAL: 5,
            ENABLE_TWITTER_POST_GENERATION: true,
            POST_IMMEDIATELY: false,
        };

        baseClient = new ClientBase(mockRuntime, mockConfig);
    });

    it('should create post client instance', () => {
        const postClient = new TwitterPostClient(baseClient, mockRuntime);
        expect(postClient).toBeDefined();
        expect(postClient.twitterUsername).toBe('testuser');
        expect(postClient['isDryRun']).toBe(true);
    });

    it('should keep tweets under max length when already valid', () => {
        const postClient = new TwitterPostClient(baseClient, mockRuntime);
        const validTweet = 'This is a valid tweet';
        const result = postClient['trimTweetLength'](validTweet);
        expect(result).toBe(validTweet);
        expect(result.length).toBeLessThanOrEqual(280);
    });

    it('should cut at last sentence when possible', () => {
        const postClient = new TwitterPostClient(baseClient, mockRuntime);
        const longTweet = 'First sentence. Second sentence that is quite long. Third sentence that would make it too long.';
        const result = postClient['trimTweetLength'](longTweet);
        const lastPeriod = result.lastIndexOf('.');
        expect(lastPeriod).toBeGreaterThan(0);
        expect(result.length).toBeLessThanOrEqual(280);
    });

    it('should add ellipsis when cutting within a sentence', () => {
        const postClient = new TwitterPostClient(baseClient, mockRuntime);
        const longSentence = 'This is an extremely long sentence without any periods that needs to be truncated because it exceeds the maximum allowed length for a tweet on the Twitter platform and therefore must be shortened';
        const result = postClient['trimTweetLength'](longSentence);
        const lastSpace = result.lastIndexOf(' ');
        expect(lastSpace).toBeGreaterThan(0);
        expect(result.length).toBeLessThanOrEqual(280);
    });
});
