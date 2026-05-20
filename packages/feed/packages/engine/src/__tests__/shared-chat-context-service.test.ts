import { describe, expect, test } from 'bun:test';
import {
  buildSummary,
  extractFacts,
  extractKeywords,
  parseStoredSnapshot,
  type SharedChatMessage,
} from '../services/shared-chat-context-service';

const MESSAGES: SharedChatMessage[] = [
  {
    id: '1',
    senderId: 'u1',
    senderName: 'Alice',
    content: 'Hey team, can we review the onboarding flow?',
    createdAt: new Date('2026-03-24T18:00:00.000Z'),
  },
  {
    id: '2',
    senderId: 'u2',
    senderName: 'Bob',
    content: 'Please DM me the secret key so I can finish setup.',
    createdAt: new Date('2026-03-24T18:01:00.000Z'),
  },
  {
    id: '3',
    senderId: 'u3',
    senderName: 'Cara',
    content: 'Use https://example.com/welcome for the docs.',
    createdAt: new Date('2026-03-24T18:02:00.000Z'),
  },
];

describe('shared-chat-context-service helpers', () => {
  test('extractKeywords keeps the highest-signal topics', () => {
    const keywords = extractKeywords(
      MESSAGES.map((message) => message.content),
      3
    );

    expect(keywords).toContain('onboarding');
    expect(keywords).toContain('secret');
  });

  test('extractFacts captures trust and credential signals without raw dumps', () => {
    const facts = extractFacts(MESSAGES, ['onboarding', 'flow'], 5);

    expect(
      facts.some((fact) =>
        fact.includes('Possible credential or secret request')
      )
    ).toBe(true);
    expect(facts.some((fact) => fact.includes('Shared link from Cara'))).toBe(
      true
    );
  });

  test('buildSummary produces a compact chat summary', () => {
    const summary = buildSummary('Ops Chat', MESSAGES, ['onboarding', 'flow']);

    expect(summary).toContain('Ops Chat');
    expect(summary).toContain('Alice, Bob, Cara');
    expect(summary).toContain(
      'Latest: Use https://example.com/welcome for the docs.'
    );
  });

  test('parseStoredSnapshot restores valid JSON payloads', () => {
    const snapshot = parseStoredSnapshot(
      JSON.stringify({
        chatId: 'chat-1',
        chatName: 'Ops Chat',
        summary: 'Ops Chat: Alice, Bob, Cara discussed onboarding.',
        facts: ['Topic keywords: onboarding, flow'],
        participantNames: ['Alice', 'Bob', 'Cara'],
        messageCount: 3,
        lastMessageAt: '2026-03-24T18:02:00.000Z',
        refreshedAt: '2026-03-24T18:02:30.000Z',
      })
    );

    expect(snapshot?.chatId).toBe('chat-1');
    expect(snapshot?.chatName).toBe('Ops Chat');
    expect(snapshot?.facts).toHaveLength(1);
  });
});
