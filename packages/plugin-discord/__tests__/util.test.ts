import type { TextChannel } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWavHeader, sendMessageInChunks } from '../src/utils';

vi.mock('@elizaos/core', () => ({
  trimTokens: vi.fn((text) => Promise.resolve(text)),
  parseJSONObjectFromText: vi.fn((text) => JSON.parse(text)),
  ModelType: { TEXT_SMALL: 'TEXT_SMALL' },
  logger: {
    error: vi.fn(),
  },
}));

describe('Utility Functions', () => {
  describe('getWavHeader', () => {
    it('should generate a valid WAV header', () => {
      const header = getWavHeader(1000, 44100, 2, 16);
      expect(header.length).toBe(44);
      expect(header.toString('utf8', 0, 4)).toBe('RIFF');
      expect(header.toString('utf8', 8, 12)).toBe('WAVE');
    });
  });

  describe('sendMessageInChunks', () => {
    let mockChannel;
    beforeEach(() => {
      mockChannel = {
        send: vi.fn().mockResolvedValue({ id: 'message-id' }),
      } as unknown as TextChannel;
    });

    it('should split and send messages in chunks', async () => {
      const longMessage = 'A'.repeat(4000);
      const messages = await sendMessageInChunks(mockChannel, longMessage, 'reply-id', []);

      expect(messages.length).toBeGreaterThan(1);
      expect(mockChannel.send).toHaveBeenCalledTimes(messages.length);
    });
  });
});
