import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { BirdclawExec, BirdclawExecOptions } from "./cli.ts";
import { BirdclawCliError } from "./cli.ts";
import {
  BirdclawService,
  buildInboxArgs,
  buildSearchArgs,
  clampLimit,
  parseCounts,
  parseInboxItems,
  parseTransport,
  parseTweets,
  summarizeSyncPayload,
} from "./service.ts";

/** Minimal runtime double: only getSetting is consulted by the service. */
function fakeRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key],
  } as unknown as IAgentRuntime;
}

interface ExecCall {
  bin: string;
  args: readonly string[];
  options: BirdclawExecOptions;
}

function recordingExec(
  respond: (call: ExecCall) => { stdout: string; stderr?: string } | Error,
): { exec: BirdclawExec; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: BirdclawExec = async (bin, args, options) => {
    const call = { bin, args, options };
    calls.push(call);
    const result = respond(call);
    if (result instanceof Error) throw result;
    return { stdout: result.stdout, stderr: result.stderr ?? "" };
  };
  return { exec, calls };
}

const TWEET_ROW = {
  id: "tweet_002",
  text: "The best product teams prune scope.",
  createdAt: "2026-03-08T11:18:00.000Z",
  likeCount: 382,
  liked: true,
  bookmarked: false,
  isReplied: true,
  kind: "home",
  author: { handle: "destraynor", displayName: "Des Traynor" },
};

describe("arg builders", () => {
  it("builds default search args", () => {
    expect(buildSearchArgs({})).toEqual([
      "search",
      "tweets",
      "--resource",
      "home",
      "--limit",
      "20",
      "--json",
    ]);
  });

  it("passes the query positionally and flags conditionally", () => {
    expect(
      buildSearchArgs({
        query: "sync engines",
        resource: "mentions",
        liked: true,
        bookmarked: true,
        limit: 5,
      }),
    ).toEqual([
      "search",
      "tweets",
      "sync engines",
      "--resource",
      "mentions",
      "--liked",
      "--bookmarked",
      "--limit",
      "5",
      "--json",
    ]);
  });

  it("clamps limits into [1, 100]", () => {
    expect(clampLimit(0, 20)).toBe(1);
    expect(clampLimit(-5, 20)).toBe(1);
    expect(clampLimit(10_000, 20)).toBe(100);
    expect(clampLimit(Number.NaN, 20)).toBe(20);
    expect(clampLimit(undefined, 20)).toBe(20);
    expect(clampLimit(7.9, 20)).toBe(7);
  });

  it("builds inbox args", () => {
    expect(buildInboxArgs({ kind: "mentions", limit: 3 })).toEqual([
      "inbox",
      "--kind",
      "mentions",
      "--limit",
      "3",
      "--json",
    ]);
  });
});

describe("wire parsing", () => {
  it("parses tweet rows and flattens the author", () => {
    const tweets = parseTweets([TWEET_ROW]);
    expect(tweets).toHaveLength(1);
    expect(tweets[0]).toMatchObject({
      id: "tweet_002",
      authorHandle: "destraynor",
      authorName: "Des Traynor",
      likeCount: 382,
      liked: true,
      bookmarked: false,
    });
  });

  it("skips malformed tweet rows instead of crashing", () => {
    const tweets = parseTweets([TWEET_ROW, { id: 42 }, null, "junk"]);
    expect(tweets).toHaveLength(1);
  });

  it("rejects a non-array search envelope", () => {
    expect(() => parseTweets({ items: [] })).toThrowError(BirdclawCliError);
  });

  it("parses inbox envelopes", () => {
    const items = parseInboxItems({
      items: [
        {
          id: "mention:tweet_004",
          entityKind: "mention",
          title: "Mention from Amelia N",
          text: "@steipete curious how you decide...",
          createdAt: "2026-03-08T11:48:00.000Z",
          needsReply: true,
          score: 76,
          participant: { handle: "amelia", displayName: "Amelia N" },
        },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "mention",
      needsReply: true,
      score: 76,
      participantHandle: "amelia",
    });
  });

  it("rejects an inbox envelope with no items array", () => {
    expect(() => parseInboxItems({})).toThrowError(BirdclawCliError);
  });

  it("parses counts and transport", () => {
    expect(
      parseCounts({ home: 4, mentions: 2, dms: 4, needsReply: 2, inbox: 4 }),
    ).toEqual({ home: 4, mentions: 2, dms: 4, needsReply: 2, inbox: 4 });
    expect(parseCounts({ home: 4 })).toBeNull();
    expect(
      parseTransport({
        installed: false,
        availableTransport: "local",
        statusText: "xurl not installed. local mode active.",
      }),
    ).toMatchObject({ installed: false, availableTransport: "local" });
    expect(parseTransport({ installed: false })).toBeNull();
  });

  it("summarizes sync payload numerics", () => {
    expect(summarizeSyncPayload({ fetched: 12, inserted: 3, note: "x" })).toBe(
      "sync completed (fetched=12, inserted=3)",
    );
    expect(summarizeSyncPayload("weird")).toBe("sync completed");
  });
});

describe("BirdclawService", () => {
  it("resolves the binary from BIRDCLAW_BIN and passes BIRDCLAW_HOME", async () => {
    const { exec, calls } = recordingExec(() => ({ stdout: "[]" }));
    const service = new BirdclawService(
      fakeRuntime({
        BIRDCLAW_BIN: "/opt/birdclaw/bin/birdclaw.mjs",
        BIRDCLAW_HOME: "/data/birdclaw",
      }),
      { exec },
    );
    await service.searchTweets({});
    expect(calls[0]?.bin).toBe("/opt/birdclaw/bin/birdclaw.mjs");
    expect(calls[0]?.options.env.BIRDCLAW_HOME).toBe("/data/birdclaw");
    // The spawn env is an allowlist, never the full agent env.
    expect(Object.keys(calls[0]?.options.env ?? {}).sort()).toEqual(
      ["BIRDCLAW_HOME", "HOME", "PATH"].filter(
        (key) => key === "BIRDCLAW_HOME" || process.env[key],
      ),
    );
  });

  it("caches the availability probe within the TTL", async () => {
    let clock = 0;
    const { exec, calls } = recordingExec(() => ({ stdout: "0.8.5" }));
    const service = new BirdclawService(fakeRuntime(), {
      exec,
      now: () => clock,
    });
    await expect(service.isAvailable()).resolves.toBe(true);
    await expect(service.isAvailable()).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    clock = 60_000; // past the 30s TTL → re-probe
    await expect(service.isAvailable()).resolves.toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("reports installed:false with install guidance when the binary is missing", async () => {
    const { exec } = recordingExec(
      () =>
        new BirdclawCliError(
          "not-installed",
          'birdclaw binary not found at "birdclaw"',
        ),
    );
    const service = new BirdclawService(fakeRuntime(), { exec });
    const status = await service.status();
    expect(status.installed).toBe(false);
    expect(status.message).toContain("brew install steipete/tap/birdclaw");
    await expect(service.isAvailable()).resolves.toBe(false);
  });

  it("combines version + db stats into status", async () => {
    const { exec } = recordingExec(({ args }) => {
      if (args[0] === "--version") return { stdout: "0.8.5\n" };
      return {
        stdout: JSON.stringify({
          paths: { rootDir: "/home/user/.birdclaw" },
          stats: { home: 4, mentions: 2, dms: 4, needsReply: 2, inbox: 4 },
          transport: {
            installed: false,
            availableTransport: "local",
            statusText: "xurl not installed. local mode active.",
          },
        }),
      };
    });
    const service = new BirdclawService(fakeRuntime(), { exec });
    const status = await service.status();
    expect(status).toMatchObject({
      installed: true,
      version: "0.8.5",
      home: "/home/user/.birdclaw",
      counts: { home: 4, mentions: 2 },
      transport: { availableTransport: "local" },
      message: null,
    });
  });

  it("keeps installed:true but surfaces the failure when db stats breaks", async () => {
    const { exec } = recordingExec(({ args }) => {
      if (args[0] === "--version") return { stdout: "0.8.5" };
      return new BirdclawCliError("failed", "database is locked");
    });
    const service = new BirdclawService(fakeRuntime(), { exec });
    const status = await service.status();
    expect(status.installed).toBe(true);
    expect(status.message).toContain("database is locked");
  });

  it("runs sync with the collection argv and summarizes", async () => {
    const { exec, calls } = recordingExec(() => ({
      stdout: JSON.stringify({ fetched: 7 }),
    }));
    const service = new BirdclawService(fakeRuntime(), { exec });
    const result = await service.sync("bookmarks");
    expect(calls[0]?.args).toEqual(["sync", "bookmarks", "--json"]);
    expect(result).toEqual({
      collection: "bookmarks",
      ok: true,
      summary: "sync completed (fetched=7)",
    });
  });

  it("digest accepts a JSON envelope or raw markdown", async () => {
    const json = recordingExec(() => ({
      stdout: JSON.stringify({ digest: "Quiet day." }),
    }));
    const jsonService = new BirdclawService(fakeRuntime(), { exec: json.exec });
    await expect(jsonService.digest("today")).resolves.toEqual({
      period: "today",
      text: "Quiet day.",
    });

    const markdown = recordingExec(() => ({
      stdout: "# What happened\nNothing.",
    }));
    const mdService = new BirdclawService(fakeRuntime(), {
      exec: markdown.exec,
    });
    await expect(mdService.digest("week")).resolves.toEqual({
      period: "week",
      text: "# What happened\nNothing.",
    });
  });

  it("forwards a dedicated OpenAI key to the CLI env only when configured", async () => {
    const withKey = recordingExec(() => ({ stdout: "[]" }));
    const keyed = new BirdclawService(
      fakeRuntime({ BIRDCLAW_OPENAI_API_KEY: "sk-birdclaw" }),
      { exec: withKey.exec },
    );
    await keyed.searchTweets({});
    expect(withKey.calls[0]?.options.env.OPENAI_API_KEY).toBe("sk-birdclaw");

    const without = recordingExec(() => ({ stdout: "[]" }));
    const bare = new BirdclawService(fakeRuntime(), { exec: without.exec });
    await bare.searchTweets({});
    expect(without.calls[0]?.options.env.OPENAI_API_KEY).toBeUndefined();
  });
});
