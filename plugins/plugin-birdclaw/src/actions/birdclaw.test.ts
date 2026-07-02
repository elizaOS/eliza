import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { BirdclawExec } from "../birdclaw/cli.ts";
import { BirdclawCliError } from "../birdclaw/cli.ts";
import { BirdclawService } from "../birdclaw/service.ts";
import {
  birdclawAction,
  formatInboxLines,
  formatStatusLine,
  formatTweetLines,
} from "./birdclaw.ts";

const MESSAGE = { id: "msg-1" } as unknown as Memory;

function runtimeWith(service: BirdclawService | null): IAgentRuntime {
  return {
    getSetting: () => undefined,
    getService: (type: string) =>
      type === BirdclawService.serviceType ? service : null,
  } as unknown as IAgentRuntime;
}

function serviceWith(
  respond: (args: readonly string[]) => { stdout: string } | Error,
): BirdclawService {
  const exec: BirdclawExec = async (_bin, args) => {
    const result = respond(args);
    if (result instanceof Error) throw result;
    return { stdout: result.stdout, stderr: "" };
  };
  return new BirdclawService(
    { getSetting: () => undefined } as unknown as IAgentRuntime,
    { exec },
  );
}

const SEARCH_PAYLOAD = JSON.stringify([
  {
    id: "t1",
    text: "Local-first sync engines beat manual export.",
    createdAt: "2026-03-08T11:18:00.000Z",
    likeCount: 42,
    liked: true,
    bookmarked: false,
    author: { handle: "amelia", displayName: "Amelia N" },
  },
]);

describe("BIRDCLAW validate", () => {
  it("is false when the service is missing", async () => {
    await expect(birdclawAction.validate(runtimeWith(null))).resolves.toBe(
      false,
    );
  });

  it("is false when the binary is missing, true when installed", async () => {
    const missing = serviceWith(
      () => new BirdclawCliError("not-installed", "not found"),
    );
    await expect(birdclawAction.validate(runtimeWith(missing))).resolves.toBe(
      false,
    );

    const installed = serviceWith(() => ({ stdout: "0.8.5" }));
    await expect(birdclawAction.validate(runtimeWith(installed))).resolves.toBe(
      true,
    );
  });
});

describe("BIRDCLAW handler", () => {
  it("searches and reports formatted results through the callback", async () => {
    const service = serviceWith((args) =>
      args[0] === "search" ? { stdout: SEARCH_PAYLOAD } : { stdout: "0.8.5" },
    );
    const said: string[] = [];
    const result = await birdclawAction.handler(
      runtimeWith(service),
      MESSAGE,
      undefined,
      { parameters: { action: "search", query: "sync engines" } },
      async (content) => {
        if (typeof content.text === "string") said.push(content.text);
        return [];
      },
    );
    expect(result.success).toBe(true);
    expect(result.text).toContain("@amelia");
    expect(result.text).toContain("♥42");
    expect(said).toHaveLength(1);
    expect(result.data).toMatchObject({ subaction: "search" });
  });

  it("treats a bare query as a search intent", async () => {
    const service = serviceWith((args) =>
      args[0] === "search" ? { stdout: "[]" } : { stdout: "0.8.5" },
    );
    const result = await birdclawAction.handler(
      runtimeWith(service),
      MESSAGE,
      undefined,
      { parameters: { query: "anything" } },
      undefined,
    );
    expect(result.success).toBe(true);
    expect(result.text).toContain("No archived tweets found");
  });

  it("summarizes the inbox with a needs-reply headline", async () => {
    const service = serviceWith((args) =>
      args[0] === "inbox"
        ? {
            stdout: JSON.stringify({
              items: [
                {
                  id: "m1",
                  entityKind: "mention",
                  title: "Mention",
                  text: "ping",
                  createdAt: "2026-03-08T11:48:00.000Z",
                  needsReply: true,
                  participant: { handle: "amelia" },
                },
              ],
            }),
          }
        : { stdout: "0.8.5" },
    );
    const result = await birdclawAction.handler(
      runtimeWith(service),
      MESSAGE,
      undefined,
      { parameters: { action: "inbox", kind: "mentions" } },
      undefined,
    );
    expect(result.success).toBe(true);
    expect(result.text).toContain("1 still needs a reply");
    expect(result.text).toContain("@amelia");
  });

  it("requires a valid collection for sync", async () => {
    const service = serviceWith(() => ({ stdout: "0.8.5" }));
    const result = await birdclawAction.handler(
      runtimeWith(service),
      MESSAGE,
      undefined,
      { parameters: { action: "sync", collection: "everything" } },
      undefined,
    );
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ error: "INVALID_COLLECTION" });
  });

  it("reports CLI failures as a failed result, not a throw", async () => {
    const service = serviceWith((args) =>
      args[0] === "sync"
        ? new BirdclawCliError("failed", "xurl not installed")
        : { stdout: "0.8.5" },
    );
    const result = await birdclawAction.handler(
      runtimeWith(service),
      MESSAGE,
      undefined,
      { parameters: { action: "sync", collection: "timeline" } },
      undefined,
    );
    expect(result.success).toBe(false);
    expect(result.text).toContain("xurl not installed");
  });

  it("rejects unknown subactions with guidance", async () => {
    const service = serviceWith(() => ({ stdout: "0.8.5" }));
    const result = await birdclawAction.handler(
      runtimeWith(service),
      MESSAGE,
      undefined,
      { parameters: { action: "tweetstorm" } },
      undefined,
    );
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ error: "UNKNOWN_SUBACTION" });
  });
});

describe("formatters", () => {
  it("formats tweet lines with likes and marks", () => {
    const lines = formatTweetLines([
      {
        id: "t1",
        text: "hello",
        createdAt: "2026-03-08T11:18:00.000Z",
        authorHandle: "steipete",
        authorName: "Peter",
        likeCount: 9,
        liked: true,
        bookmarked: true,
        isReplied: null,
        kind: "home",
      },
    ]);
    expect(lines).toBe(
      "• @steipete — hello (♥9) [liked, bookmarked] · 2026-03-08",
    );
  });

  it("formats inbox lines with the needs-reply marker", () => {
    const lines = formatInboxLines([
      {
        id: "m1",
        kind: "mention",
        title: "Mention",
        text: "ping",
        createdAt: "2026-03-08T11:48:00.000Z",
        needsReply: true,
        score: 76,
        participantHandle: "amelia",
      },
    ]);
    expect(lines).toBe("• @amelia: ping — needs a reply · 2026-03-08");
  });

  it("formats status lines for installed and missing states", () => {
    expect(
      formatStatusLine({
        installed: false,
        version: null,
        home: null,
        counts: null,
        transport: null,
        message: "install it",
      }),
    ).toBe("install it");
    expect(
      formatStatusLine({
        installed: true,
        version: "0.8.5",
        home: "/home/user/.birdclaw",
        counts: { home: 4, mentions: 2, dms: 4, needsReply: 2, inbox: 4 },
        transport: {
          installed: false,
          availableTransport: "local",
          statusText: "xurl not installed. local mode active.",
        },
        message: null,
      }),
    ).toContain("4 timeline, 2 mentions, 4 DMs (2 need a reply)");
  });
});
