import { describe, expect, mock, test } from 'bun:test';
import { PredictionDbAdapter } from '../PredictionDbAdapter';

describe('PredictionDbAdapter.getQuestion', () => {
  test('does not reinterpret large snowflake-like ids as question numbers', async () => {
    let limitCalls = 0;
    const client = {
      select: mock(() => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              limitCalls += 1;
              return [];
            },
          }),
        }),
      })),
    };

    // biome-ignore lint: mock client shape doesn't match full DrizzleClient
    const adapter = new PredictionDbAdapter(client as any);
    const result = await adapter.getQuestion('295030178092052480');

    expect(result).toBeNull();
    expect(client.select).toHaveBeenCalledTimes(1);
    expect(limitCalls).toBe(1);
  });

  test('falls back to questionNumber lookup for safe integer ids', async () => {
    let selectCalls = 0;
    const client = {
      select: mock(() => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCalls += 1;
              if (selectCalls === 1) {
                return [];
              }
              return [
                {
                  id: 'question-123',
                  questionNumber: 123,
                  text: 'Will NVDAI hold above $3,500?',
                  status: 'active',
                  resolutionDate: null,
                  resolvedOutcome: null,
                  createdDate: new Date('2026-03-01T00:00:00.000Z'),
                },
              ];
            },
          }),
        }),
      })),
    };

    // biome-ignore lint: mock client shape doesn't match full DrizzleClient
    const adapter = new PredictionDbAdapter(client as any);
    const result = await adapter.getQuestion('123');

    expect(result).toMatchObject({
      id: 'question-123',
      questionNumber: 123,
      text: 'Will NVDAI hold above $3,500?',
      status: 'active',
    });
    expect(client.select).toHaveBeenCalledTimes(2);
  });
});
