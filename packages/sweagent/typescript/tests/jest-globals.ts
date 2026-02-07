import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * Compatibility shim for tests originally written against `@jest/globals`.
 *
 * Vitest provides a largely compatible surface via `vi`.
 */
export const jest = {
  fn: vi.fn,
  spyOn: vi.spyOn,
  mock: vi.mock,
  unmock: vi.unmock,
  doMock: vi.doMock,
  doUnmock: vi.doUnmock,
  resetModules: vi.resetModules,
  mocked: vi.mocked,
  clearAllMocks: vi.clearAllMocks,
  useFakeTimers: () =>
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
      ],
    }),
  useRealTimers: vi.useRealTimers,
  advanceTimersByTime: vi.advanceTimersByTime,
  runAllTimers: vi.runAllTimers,
  setSystemTime: vi.setSystemTime,
} as const;

export { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it };
