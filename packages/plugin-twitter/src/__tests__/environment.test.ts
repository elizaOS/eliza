import { twitterEnvSchema } from '../environment';

describe('Twitter Environment Configuration', () => {
  describe('Username Validation', () => {
    const validateUsername = (username: string) => {
      return twitterEnvSchema.parse({
        TWITTER_DRY_RUN: false,
        TWITTER_USERNAME: 'test_user',
        TWITTER_PASSWORD: 'password',
        TWITTER_EMAIL: 'test@example.com',
        TWITTER_2FA_SECRET: '',
        TWITTER_RETRY_LIMIT: 5,
        TWITTER_POLL_INTERVAL: 120,
        POST_INTERVAL_MIN: 90,
        POST_INTERVAL_MAX: 180,
        TWITTER_POST_IMMEDIATELY: false,
        TWITTER_TARGET_USERS: [username],
      });
    };

    it('should allow valid traditional usernames', () => {
      expect(() => validateUsername('normal_user')).not.toThrow();
      expect(() => validateUsername('user123')).not.toThrow();
      expect(() => validateUsername('a_1_b_2')).not.toThrow();
    });

    it('should allow usernames starting with digits', () => {
      expect(() => validateUsername('123user')).not.toThrow();
      expect(() => validateUsername('42_test')).not.toThrow();
      expect(() => validateUsername('007james')).not.toThrow();
    });

    it('should allow wildcard', () => {
      expect(() => validateUsername('*')).not.toThrow();
    });

    it('should reject invalid usernames', () => {
      expect(() => validateUsername('')).toThrow();
      expect(() => validateUsername('user@123')).toThrow();
      expect(() => validateUsername('user-123')).toThrow();
      expect(() => validateUsername('user.123')).toThrow();
      expect(() => validateUsername('a'.repeat(16))).toThrow();
    });

    it('should handle array of usernames', () => {
      const config = {
        TWITTER_DRY_RUN: false,
        TWITTER_USERNAME: 'test_user',
        TWITTER_PASSWORD: 'password',
        TWITTER_EMAIL: 'test@example.com',
        TWITTER_2FA_SECRET: '',
        TWITTER_RETRY_LIMIT: 5,
        TWITTER_POLL_INTERVAL: 120,
        POST_INTERVAL_MIN: 90,
        POST_INTERVAL_MAX: 180,
        TWITTER_POST_IMMEDIATELY: false,
        TWITTER_TARGET_USERS: ['normal_user', '123digit', '*'],
      };

      expect(() => twitterEnvSchema.parse(config)).not.toThrow();
    });
  });
});
