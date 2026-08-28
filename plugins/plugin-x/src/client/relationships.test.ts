import { describe, expect, it, vi } from "vitest";
import {
  fetchProfileFollowers,
  fetchProfileFollowing,
  getFollowers,
  getFollowing,
} from "./relationships";

const USER = (id: string, username: string) => ({
  id,
  username,
  name: `Name ${username}`,
  description: "desc",
  profile_image_url: "https://example.com/normal.jpg",
  public_metrics: {
    followers_count: 10,
    following_count: 5,
    tweet_count: 3,
    like_count: 2,
    listed_count: 1,
  },
  verified: false,
  verified_type: "none",
  created_at: "2026-01-01T00:00:00.000Z",
  protected: false,
});

function makeAuth(impl: Record<string, unknown>) {
  const auth = {
    getV2Client: vi.fn(async () => ({ v2: impl })),
  };
  return auth;
}

describe("fetchProfileFollowing maxProfiles boundary", () => {
  it("returns an empty page without calling the API for maxProfiles 0", async () => {
    const following = vi.fn();
    const auth = makeAuth({ following });
    const result = await fetchProfileFollowing("user-1", 0, auth);
    expect(result).toEqual({ profiles: [], next: undefined });
    expect(following).not.toHaveBeenCalled();
  });

  it("returns an empty page without calling the API for negative maxProfiles", async () => {
    const following = vi.fn();
    const auth = makeAuth({ following });
    const result = await fetchProfileFollowing("user-1", -3, auth);
    expect(result).toEqual({ profiles: [], next: undefined });
    expect(following).not.toHaveBeenCalled();
  });

  it("passes a positive maxProfiles through to the API and parses profiles", async () => {
    const following = vi.fn(async () => ({
      data: [USER("u1", "alice"), USER("u2", "bob")],
      meta: { next_token: "tok-9" },
    }));
    const auth = makeAuth({ following });
    const result = await fetchProfileFollowing("user-1", 5, auth, "tok-8");
    expect(following).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        max_results: 5,
        pagination_token: "tok-8",
      }),
    );
    expect(result.profiles.length).toBe(2);
    expect(result.next).toBe("tok-9");
    expect(result.profiles[0].username).toBe("alice");
  });
});

describe("fetchProfileFollowers maxProfiles boundary", () => {
  it("returns an empty page without calling the API for maxProfiles 0", async () => {
    const followers = vi.fn();
    const auth = makeAuth({ followers });
    const result = await fetchProfileFollowers("user-1", 0, auth);
    expect(result).toEqual({ profiles: [], next: undefined });
    expect(followers).not.toHaveBeenCalled();
  });

  it("passes a positive maxProfiles through to the API", async () => {
    const followers = vi.fn(async () => ({
      data: [USER("u3", "carol")],
      meta: {},
    }));
    const auth = makeAuth({ followers });
    const result = await fetchProfileFollowers("user-1", 10, auth);
    expect(followers).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ max_results: 10 }),
    );
    expect(result.profiles.length).toBe(1);
  });
});

describe("getFollowing / getFollowers zero-request semantics", () => {
  it("yields nothing and never calls the API when maxProfiles is 0", async () => {
    const following = vi.fn();
    const auth = makeAuth({ following });
    const collected = [];
    for await (const p of getFollowing("user-1", 0, auth)) {
      collected.push(p);
    }
    expect(collected).toEqual([]);
    expect(following).not.toHaveBeenCalled();
  });

  it("pages with the remaining budget until maxProfiles is reached", async () => {
    const following = vi
      .fn()
      .mockResolvedValueOnce({
        data: [USER("u1", "alice"), USER("u2", "bob")],
        meta: { next_token: "tok-1" },
      })
      .mockResolvedValueOnce({
        data: [USER("u3", "carol")],
        meta: { next_token: "tok-2" },
      })
      .mockResolvedValueOnce({
        data: [USER("u4", "dave")],
        meta: {},
      });
    const auth = makeAuth({ following });
    const collected = [];
    for await (const p of getFollowing("user-1", 3, auth)) {
      collected.push(p);
    }
    expect(collected.length).toBe(3);
    expect(following).toHaveBeenCalledTimes(2);
    // second page asks for the remaining budget
    const secondCallOpts = following.mock.calls[1][1];
    expect(secondCallOpts.max_results).toBe(1);
    expect(secondCallOpts.pagination_token).toBe("tok-1");
  });

  it("yields nothing for maxProfiles 0 in getFollowers", async () => {
    const followers = vi.fn();
    const auth = makeAuth({ followers });
    const collected = [];
    for await (const p of getFollowers("user-1", 0, auth)) {
      collected.push(p);
    }
    expect(collected).toEqual([]);
    expect(followers).not.toHaveBeenCalled();
  });
});
