import { describe, it, expect } from 'vitest';
import { CacheManager } from '../services/cacheManager';
import { NotificationManager } from '../services/notificationManager';
import type { IAgentRuntime, UUID } from '@elizaos/core';

describe('Internal Managers', () => {
  const mockRuntime: IAgentRuntime = {
    agentId: 'test-agent' as UUID,
    emitEvent: () => Promise.resolve(),
  } as any;

  describe('CacheManager', () => {
    it('should initialize successfully', () => {
      const cache = new CacheManager();
      expect(cache).toBeDefined();
    });

    it('should set and get values', async () => {
      const cache = new CacheManager();
      await cache.set('test-key', 'test-value');
      const value = await cache.get('test-key');
      expect(value).toBe('test-value');
    });

    it('should return null for non-existent keys', async () => {
      const cache = new CacheManager();
      const value = await cache.get('non-existent-key');
      expect(value).toBeNull();
    });

    it('should check key existence', async () => {
      const cache = new CacheManager();
      await cache.set('existing-key', 'value');
      
      const exists = await cache.has('existing-key');
      const notExists = await cache.has('non-existent-key');
      
      expect(exists).toBe(true);
      expect(notExists).toBe(false);
    });

    it('should delete keys', async () => {
      const cache = new CacheManager();
      await cache.set('to-delete', 'value');
      
      const deleted = await cache.delete('to-delete');
      expect(deleted).toBe(true);
      
      const value = await cache.get('to-delete');
      expect(value).toBeNull();
    });

    it('should clear all entries', async () => {
      const cache = new CacheManager();
      await cache.set('key1', 'value1');
      await cache.set('key2', 'value2');
      
      await cache.clear();
      
      const value1 = await cache.get('key1');
      const value2 = await cache.get('key2');
      
      expect(value1).toBeNull();
      expect(value2).toBeNull();
    });

    it('should provide stats', () => {
      const cache = new CacheManager();
      const stats = cache.getStats();
      
      expect(stats).toHaveProperty('totalEntries');
      expect(stats).toHaveProperty('hitRate');
      expect(stats).toHaveProperty('missRate');
      expect(stats).toHaveProperty('memoryUsage');
      expect(typeof stats.totalEntries).toBe('number');
    });

    it('should handle TTL expiration', async () => {
      const cache = new CacheManager();
      await cache.set('expiring-key', 'value', 1); // 1ms TTL
      
      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const value = await cache.get('expiring-key');
      expect(value).toBeNull();
    });

    it('should support getOrSet pattern', async () => {
      const cache = new CacheManager();
      let fetcherCalled = false;
      
      const fetcher = async () => {
        fetcherCalled = true;
        return 'fetched-value';
      };
      
      const value1 = await cache.getOrSet('fetch-key', fetcher);
      expect(value1).toBe('fetched-value');
      expect(fetcherCalled).toBe(true);
      
      fetcherCalled = false;
      const value2 = await cache.getOrSet('fetch-key', fetcher);
      expect(value2).toBe('fetched-value');
      expect(fetcherCalled).toBe(false); // Should not call fetcher again
    });

    it('should stop gracefully', async () => {
      const cache = new CacheManager();
      await expect(cache.stop()).resolves.toBeUndefined();
    });
  });

  describe('NotificationManager', () => {
    it('should initialize successfully', () => {
      const notificationManager = new NotificationManager(mockRuntime);
      expect(notificationManager).toBeDefined();
    });

    it('should queue notifications', async () => {
      const notificationManager = new NotificationManager(mockRuntime);
      
      await expect(notificationManager.queueNotification({
        title: 'Test Notification',
        body: 'Test body',
        type: 'system',
        roomId: 'room-1' as UUID,
      })).resolves.toBeUndefined();
    });

    it('should get user preferences', () => {
      const notificationManager = new NotificationManager(mockRuntime);
      const prefs = notificationManager.getUserPreferences('user-1' as UUID);
      
      expect(prefs).toHaveProperty('enabled');
      expect(prefs).toHaveProperty('sound');
      expect(prefs).toHaveProperty('browserNotifications');
      expect(prefs).toHaveProperty('reminderTypes');
      expect(typeof prefs.enabled).toBe('boolean');
    });

    it('should update user preferences', async () => {
      const notificationManager = new NotificationManager(mockRuntime);
      
      await expect(notificationManager.updateUserPreferences('user-1' as UUID, {
        enabled: false,
        sound: false,
      })).resolves.toBeUndefined();
      
      const prefs = notificationManager.getUserPreferences('user-1' as UUID);
      expect(prefs.enabled).toBe(false);
      expect(prefs.sound).toBe(false);
    });

    it('should stop gracefully', async () => {
      const notificationManager = new NotificationManager(mockRuntime);
      await expect(notificationManager.stop()).resolves.toBeUndefined();
    });
  });

  describe('Manager Integration', () => {
    it('should work together in reminder service context', () => {
      const cache = new CacheManager();
      const notifications = new NotificationManager(mockRuntime);
      
      expect(cache).toBeDefined();
      expect(notifications).toBeDefined();
      
      // Both should be able to stop without errors
      expect(async () => {
        await cache.stop();
        await notifications.stop();
      }).not.toThrow();
    });
  });
});