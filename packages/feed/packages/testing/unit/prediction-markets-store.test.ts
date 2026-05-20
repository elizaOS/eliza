/**
 * Unit Tests: Prediction Markets Zustand Store
 *
 * Tests the Zustand store logic directly without React.
 * Exercises real code paths in apps/web/src/stores/predictionMarketsStore.ts.
 *
 * Run with: bun test packages/testing/unit/prediction-markets-store.test.ts --preload ./packages/testing/unit/preload.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type MockFetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

type MockFetch = (input: string) => Promise<MockFetchResponse>;

function createResponse({
  ok,
  status,
  body,
}: {
  ok: boolean;
  status: number;
  body: unknown;
}): MockFetchResponse {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  };
}

const mockFetch = mock<MockFetch>(() =>
  Promise.resolve(
    createResponse({
      ok: true,
      status: 200,
      body: {
        questions: [{ id: "market-1", question: "Will ETH go up?" }],
      },
    }),
  ),
);

// @ts-expect-error - mock global fetch
globalThis.fetch = mockFetch;

const actualReact = await import("react");
const reactMock = {
  ...actualReact,
  useCallback: (fn: Function) => fn,
  useEffect: () => {},
  useMemo: (factory: Function) => factory(),
  useRef: (value: unknown) => ({ current: value }),
};
mock.module("react", () => ({
  ...reactMock,
  default: actualReact.default ?? reactMock,
}));

mock.module("zustand/react/shallow", () => ({
  useShallow: (fn: Function) => fn,
}));

const { usePredictionMarketsStore } = await import(
  "@/stores/predictionMarketsStore"
);

function resetStore() {
  const { pollingInterval } = usePredictionMarketsStore.getState();
  if (pollingInterval) {
    clearInterval(pollingInterval);
  }

  usePredictionMarketsStore.setState({
    markets: [],
    loading: false,
    error: null,
    lastFetchedAt: null,
    fetchPromise: null,
    pollingInterval: null,
    subscriberCount: 0,
  });
}

beforeEach(() => {
  resetStore();
  mockFetch.mockClear();
  mockFetch.mockImplementation(() =>
    Promise.resolve(
      createResponse({
        ok: true,
        status: 200,
        body: {
          questions: [{ id: "market-1", question: "Will ETH go up?" }],
        },
      }),
    ),
  );
});

afterEach(() => {
  resetStore();
});

describe("Prediction Markets Store", () => {
  test("stores fetch failures in state instead of rejecting", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        createResponse({
          ok: false,
          status: 503,
          body: {},
        }),
      ),
    );

    await expect(
      usePredictionMarketsStore.getState().fetchMarkets(),
    ).resolves.toBeUndefined();

    const state = usePredictionMarketsStore.getState();
    expect(state.error).toBe("Failed to fetch prediction markets: 503");
    expect(state.loading).toBe(false);
    expect(state.fetchPromise).toBeNull();
    expect(state.markets).toEqual([]);
  });

  test("clears failed fetchPromise so a later retry can succeed", async () => {
    mockFetch
      .mockImplementationOnce(() =>
        Promise.resolve(
          createResponse({
            ok: false,
            status: 429,
            body: {},
          }),
        ),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          createResponse({
            ok: true,
            status: 200,
            body: {
              questions: [{ id: "market-2", question: "Will BTC rally?" }],
            },
          }),
        ),
      );

    await usePredictionMarketsStore.getState().fetchMarkets();
    await usePredictionMarketsStore.getState().fetchMarkets(true);

    const state = usePredictionMarketsStore.getState();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(state.error).toBeNull();
    expect(state.fetchPromise).toBeNull();
    // Store assigns API `questions` verbatim; runtime rows may omit PredictionMarket-only fields.
    expect(state.markets).toHaveLength(1);
    expect(state.markets[0]).toMatchObject({
      id: "market-2",
      question: "Will BTC rally?",
    });
  });
});
