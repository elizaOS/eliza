/**
 * A2A Operation Map Completeness Tests
 *
 * Verifies that the operationMap in integration-a2a-sdk.ts contains all
 * required messaging and notification operations that were added in Phase 1.
 *
 * This is a regression test — the root cause of "unsupported operation: sendMessage"
 * was missing entries in operationMap. These tests ensure they stay present.
 *
 * Tests:
 * - All messaging operations are mapped
 * - All notification operations are mapped
 * - Map values follow the "category.snake_case" format
 * - No duplicate values in the map
 * - Critical operations that existed before are still present
 */

import { describe, expect, test } from 'bun:test';

// ─── Import the module to access operationMap ────────────────────────────────

// We need to read the file and extract the operationMap since it's not exported
// Instead, we test via the actual module behavior
// Let's read the file directly and check for the patterns

import { readFileSync } from 'fs';
import { resolve } from 'path';

const filePath = resolve(
  import.meta.dir,
  '../../../agents/src/plugins/feed/integration-a2a-sdk.ts'
);
const fileContent = readFileSync(filePath, 'utf-8');

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('operationMap completeness', () => {
  // ─── Messaging operations (Phase 1 additions) ────────────────────────

  describe('messaging operations', () => {
    test('sendMessage is mapped to messaging.send_message', () => {
      expect(fileContent).toContain("sendMessage: 'messaging.send_message'");
    });

    test('getChatMessages is mapped to messaging.get_chat_messages', () => {
      expect(fileContent).toContain(
        "getChatMessages: 'messaging.get_chat_messages'"
      );
    });

    test('getChats is mapped to messaging.get_chats', () => {
      expect(fileContent).toContain("getChats: 'messaging.get_chats'");
    });

    test('createGroup is mapped to messaging.create_group', () => {
      expect(fileContent).toContain("createGroup: 'messaging.create_group'");
    });

    test('leaveChat is mapped to messaging.leave_chat', () => {
      expect(fileContent).toContain("leaveChat: 'messaging.leave_chat'");
    });

    test('getUnreadCount is mapped to messaging.get_unread_count', () => {
      expect(fileContent).toContain(
        "getUnreadCount: 'messaging.get_unread_count'"
      );
    });
  });

  // ─── Notification operations (Phase 1 additions) ─────────────────────

  describe('notification operations', () => {
    test('getNotifications is mapped', () => {
      expect(fileContent).toContain('getNotifications:');
    });

    test('markNotificationsRead is mapped', () => {
      expect(fileContent).toContain('markNotificationsRead:');
    });

    test('getGroupInvites is mapped', () => {
      expect(fileContent).toContain('getGroupInvites:');
    });

    test('acceptGroupInvite is mapped', () => {
      expect(fileContent).toContain('acceptGroupInvite:');
    });

    test('declineGroupInvite is mapped', () => {
      expect(fileContent).toContain('declineGroupInvite:');
    });
  });

  // ─── Pre-existing critical operations still present ──────────────────

  describe('pre-existing operations', () => {
    test('getBalance is mapped', () => {
      expect(fileContent).toContain('getBalance:');
    });

    test('getPositions is mapped', () => {
      expect(fileContent).toContain('getPositions:');
    });

    test('createPost is mapped', () => {
      expect(fileContent).toContain('createPost:');
    });

    test('getPredictions is mapped', () => {
      expect(fileContent).toContain('getPredictions:');
    });

    test('getPerpetuals is mapped', () => {
      expect(fileContent).toContain('getPerpetuals:');
    });
  });

  // ─── Format validation ───────────────────────────────────────────────

  describe('operationMap format', () => {
    test('all values follow category.snake_case format', () => {
      // Extract all operationMap values
      const mapBlock = fileContent.match(
        /const operationMap[\s\S]*?=[\s\S]*?\{([\s\S]*?)\}\s*(?:as|;)/
      );
      expect(mapBlock).toBeTruthy();

      if (mapBlock) {
        const entries = mapBlock[1]!.match(/['"]([a-z_]+\.[a-z_]+)['"]/g);
        expect(entries).toBeTruthy();
        expect(entries!.length).toBeGreaterThan(20); // We expect 30+ mappings

        // Every value should be category.operation format
        for (const entry of entries!) {
          const clean = entry.replace(/['"]/g, '');
          expect(clean).toMatch(/^[a-z_]+\.[a-z_]+$/);
        }
      }
    });

    test('no duplicate values in the map', () => {
      const mapBlock = fileContent.match(
        /const operationMap[\s\S]*?=[\s\S]*?\{([\s\S]*?)\}\s*(?:as|;)/
      );

      if (mapBlock) {
        const entries = mapBlock[1]!.match(/['"]([a-z_]+\.[a-z_]+)['"]/g) || [];
        const values = entries.map((e) => e.replace(/['"]/g, ''));
        const unique = new Set(values);
        expect(values.length).toBe(unique.size);
      }
    });
  });
});
