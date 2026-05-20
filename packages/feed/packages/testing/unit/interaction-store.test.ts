import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const storage = new Map<string, string>();

const storageMock = {
  getItem(key: string) {
    return storage.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    storage.set(key, value);
  },
  removeItem(key: string) {
    storage.delete(key);
  },
  clear() {
    storage.clear();
  },
  key(index: number) {
    return Array.from(storage.keys())[index] ?? null;
  },
  get length() {
    return storage.size;
  },
};

Object.defineProperty(globalThis, "localStorage", {
  value: storageMock,
  configurable: true,
});

type MockFetchResponse = {
  json: () => Promise<unknown>;
};

type MockFetch = (
  input: string,
  init?: RequestInit,
) => Promise<MockFetchResponse>;

const mockFetch = mock<MockFetch>(() =>
  Promise.resolve({
    json: () =>
      Promise.resolve({
        data: {
          comments: [
            {
              id: "comment-1",
              content: "Hello world",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              userId: "user-1",
              userName: "Alice",
              userUsername: "alice",
              userAvatar: null,
              parentCommentId: null,
              likeCount: 0,
              isLiked: false,
              replies: [],
            },
          ],
        },
      }),
  }),
);

// @ts-expect-error - test mock
globalThis.fetch = mockFetch;

mock.module("@/lib/auth", () => ({
  getAuthToken: () => null,
}));

const { useInteractionStore } = await import("@/stores/interactionStore");

beforeEach(() => {
  storage.clear();
  useInteractionStore.getState().resetStore();
  mockFetch.mockClear();
  mockFetch.mockImplementation(() =>
    Promise.resolve({
      json: () =>
        Promise.resolve({
          data: {
            comments: [
              {
                id: "comment-1",
                content: "Hello world",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                userId: "user-1",
                userName: "Alice",
                userUsername: "alice",
                userAvatar: null,
                parentCommentId: null,
                likeCount: 0,
                isLiked: false,
                replies: [],
              },
            ],
          },
        }),
    }),
  );
});

afterEach(() => {
  useInteractionStore.getState().resetStore();
  storage.clear();
});

describe("interactionStore.loadComments", () => {
  test("returns comments and clears the loading state on success", async () => {
    const comments = await useInteractionStore
      .getState()
      .loadComments("post-success");

    expect(comments).toHaveLength(1);
    expect(comments[0]?.id).toBe("comment-1");
    expect(
      useInteractionStore
        .getState()
        .loadingStates.has("load-comments-post-success"),
    ).toBe(false);
    expect(
      useInteractionStore.getState().errors.has("load-comments-post-success"),
    ).toBe(false);
  });

  test("returns an empty list and stores an error when the response has no comments payload", async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve({
        json: () =>
          Promise.resolve({
            error: {
              code: "NOT_FOUND",
              message: "Post not found",
            },
          }),
      }),
    );

    const comments = await useInteractionStore
      .getState()
      .loadComments("post-missing");

    expect(comments).toEqual([]);
    expect(
      useInteractionStore
        .getState()
        .loadingStates.has("load-comments-post-missing"),
    ).toBe(false);
    expect(
      useInteractionStore.getState().errors.get("load-comments-post-missing"),
    ).toEqual({
      code: "UNKNOWN",
      message: "Unable to load comments right now.",
    });
  });

  test("returns an empty list and clears loading when fetch rejects", async () => {
    mockFetch.mockImplementation(() =>
      Promise.reject(new TypeError("fetch failed")),
    );

    const comments = await useInteractionStore
      .getState()
      .loadComments("post-network");

    expect(comments).toEqual([]);
    expect(
      useInteractionStore
        .getState()
        .loadingStates.has("load-comments-post-network"),
    ).toBe(false);
    expect(
      useInteractionStore.getState().errors.get("load-comments-post-network"),
    ).toEqual({
      code: "NETWORK_ERROR",
      message: "Unable to load comments right now.",
    });
  });
});
