import { beforeEach, describe, expect, mock, test } from 'bun:test';

let mockDbSelectOffset: ReturnType<typeof mock>;
let mockDbSelectLimit: ReturnType<typeof mock>;
let mockDbSelectOrderBy: ReturnType<typeof mock>;
let mockDbSelectWhere: ReturnType<typeof mock>;
let mockDbSelectFrom: ReturnType<typeof mock>;
let mockDbSelect: ReturnType<typeof mock>;
let mockDbUpdateWhere: ReturnType<typeof mock>;
let mockDbUpdateSet: ReturnType<typeof mock>;
let mockDbUpdate: ReturnType<typeof mock>;

function resetDbMocks() {
  mockDbSelectOffset = mock(async () => []);
  mockDbSelectLimit = mock(() => ({ offset: mockDbSelectOffset }));
  mockDbSelectOrderBy = mock(() => ({ limit: mockDbSelectLimit }));
  mockDbSelectWhere = mock(() => ({ orderBy: mockDbSelectOrderBy }));
  mockDbSelectFrom = mock(() => ({ where: mockDbSelectWhere }));
  mockDbSelect = mock(() => ({ from: mockDbSelectFrom }));

  mockDbUpdateWhere = mock(async () => []);
  mockDbUpdateSet = mock(() => ({ where: mockDbUpdateWhere }));
  mockDbUpdate = mock(() => ({ set: mockDbUpdateSet }));
}

resetDbMocks();

const _actualDb = await import('@feed/db');
mock.module('@feed/db', () => ({
  ..._actualDb,
  db: {
    get select() {
      return mockDbSelect;
    },
    get update() {
      return mockDbUpdate;
    },
  },
  asc: (column: unknown) => ({ op: 'asc', column }),
  eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
  timeframedMarkets: {
    id: 'timeframedMarkets.id',
    isActive: 'timeframedMarkets.isActive',
  },
}));

const mockLoggerInfo = mock();

const _actualShared = await import('@feed/shared');
mock.module('@feed/shared', () => ({
  ..._actualShared,
  logger: {
    debug: mock(),
    error: mock(),
    info: mockLoggerInfo,
    warn: mock(),
  },
}));

const { TimeframeArcProcessor } = await import(
  '../../../engine/src/services/timeframe-arc-processor'
);

describe('TimeframeArcProcessor', () => {
  beforeEach(() => {
    resetDbMocks();
    mockLoggerInfo.mockClear();
  });

  test('keeps expired markets active while moving them to the terminal arc state', async () => {
    const now = new Date('2026-03-19T20:50:00.000Z');
    const expiredMarket = {
      id: 'market-1',
      timeframe: 'intraday',
      startTime: new Date('2026-03-19T18:50:00.000Z'),
      endTime: new Date('2026-03-19T19:50:00.000Z'),
      arcState: 'active',
      eventsGenerated: 0,
    };

    mockDbSelectOffset.mockResolvedValueOnce([expiredMarket]);

    const processor = new TimeframeArcProcessor();
    const result = await processor.processTick(now);

    expect(result.marketsProcessed).toBe(1);
    expect(result.transitionsOccurred).toBe(1);
    expect(mockDbUpdateSet).toHaveBeenCalledTimes(1);
    expect(mockDbUpdateSet).toHaveBeenCalledWith({
      arcState: 'resolution',
      arcStateEnteredAt: now,
      updatedAt: now,
    });

    const updatePayload = mockDbUpdateSet.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(updatePayload).toBeDefined();
    expect(updatePayload).not.toHaveProperty('isActive');
    expect(updatePayload).not.toHaveProperty('isResolved');
    expect(updatePayload).not.toHaveProperty('resolvedAt');
  });

  test('does not rewrite expired markets already in their terminal arc state', async () => {
    const now = new Date('2026-03-19T20:50:00.000Z');
    const expiredMarket = {
      id: 'market-2',
      timeframe: 'flash',
      startTime: new Date('2026-03-19T20:15:00.000Z'),
      endTime: new Date('2026-03-19T20:30:00.000Z'),
      arcState: 'resolving',
      eventsGenerated: 0,
    };

    mockDbSelectOffset.mockResolvedValueOnce([expiredMarket]);

    const processor = new TimeframeArcProcessor();
    const result = await processor.processTick(now);

    expect(result.marketsProcessed).toBe(1);
    expect(result.transitionsOccurred).toBe(0);
    expect(mockDbUpdateSet).not.toHaveBeenCalled();
  });
});
