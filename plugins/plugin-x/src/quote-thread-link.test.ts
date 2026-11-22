/**
 * A quote post carries the quoted post's status URL, which
 * createQuoteTweetRequest appends to the first post of the quote thread
 * (quote_tweet_id needs an X Enterprise plan). X counts that URL as 23
 * weighted characters, plus its space, toward the 280 limit. So the first
 * post of a quote thread must keep 24 characters free; otherwise X refuses
 * every quote of 257 to 280 weighted characters and the first post of every
 * longer quote.
 *
 * Real AgentRuntime (SQLite), real ClientBase, Client and
 * TwitterTimelineClient, env (OAuth 1.0a) authentication and the real
 * twitter-api-v2 client over HTTPS. Only the network is replaced: api.x.com
 * connects to a loopback HTTPS server that admits posts the way X does, with
 * the twitter-text parser.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { type AgentRuntime, logger, ModelType } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import twitterText from "twitter-text";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ClientBase, RequestQueue } from "./base";
import { createTwitterAuthProvider } from "./client/auth-providers/factory";
import { TwitterTimelineClient } from "./timeline";
import type { TwitterClientState } from "./types";

const X_HOST = "api.x.com";
const X_LIMIT = 280;
const QUOTED_ID = "1850000000000000042";
const STATUS_URL = `https://twitter.com/i/status/${QUOTED_ID}`;
const AGENT = { id: "1700000000000000001", name: "Agent", username: "agent" };

/** One post that X received, with X's own weighted length of its text. */
type ReceivedPost = {
  text: string;
  weighted: number;
  accepted: boolean;
  replyTo?: string;
};

/** One model case: the quote length and what X receives for it. */
type ModelCase = { length: number; posts: number[]; refused: boolean };

// A plain sentence of 269 weighted characters.
const SENTENCE_QUOTE = `${"Agents that ship small, verifiable changes beat agents that promise big rewrites. ".repeat(3)}Agree, receipts matter.`;

// Without the model's env variable, every group still replays one case.
const DEFAULT_CASES: ModelCase[] = [
  { length: 200, posts: [224], refused: false },
  { length: 269, posts: [280, 13], refused: false },
  { length: 600, posts: [280, 280, 64], refused: false },
];
const MODEL_CASES: ModelCase[] = process.env.ELIZA_X_QUOTE_THREAD_MODEL_CASES
  ? JSON.parse(
      readFileSync(process.env.ELIZA_X_QUOTE_THREAD_MODEL_CASES, "utf8"),
    )
  : DEFAULT_CASES;

const originalHttps = https.globalAgent;
let directory: string;
let server: https.Server;
let received: ReceivedPost[] = [];
let nextPostId = 1900000000000000000n;
let quoteText = "";
const runtimes: AgentRuntime[] = [];

function postsJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/** The two X API v2 routes this flow uses: users/me and create post. */
const loopbackX: http.RequestListener = (request, response) => {
  const url = new URL(request.url ?? "/", `https://${X_HOST}`);
  if (request.method === "GET" && url.pathname === "/2/users/me") {
    postsJson(response, 200, { data: AGENT });
    return;
  }
  if (request.method === "POST" && url.pathname === "/2/tweets") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part: string) => {
      body += part;
    });
    request.on("end", () => {
      const params = JSON.parse(body) as {
        text: string;
        reply?: { in_reply_to_tweet_id: string };
      };
      const weighted = twitterText.parseTweet(params.text).weightedLength;
      const accepted = weighted <= X_LIMIT;
      received.push({
        text: params.text,
        weighted,
        accepted,
        replyTo: params.reply?.in_reply_to_tweet_id,
      });
      if (!accepted) {
        postsJson(response, 403, {
          title: "Forbidden",
          type: "about:blank",
          status: 403,
          detail: "Your Tweet text is too long.",
        });
        return;
      }
      nextPostId += 1n;
      postsJson(response, 201, {
        data: { id: nextPostId.toString(), text: params.text },
      });
    });
    return;
  }
  postsJson(response, 404, { title: "Not Found", status: 404 });
};

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "eliza-x-quote-"));
  const config = path.join(directory, "openssl.cnf");
  const keyPath = path.join(directory, "key.pem");
  const certPath = path.join(directory, "cert.pem");
  writeFileSync(
    config,
    `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${X_HOST}\n[ext]\nsubjectAltName=DNS:${X_HOST}\n`,
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-config",
      config,
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(certPath);
  server = https.createServer({ key: readFileSync(keyPath), cert }, loopbackX);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // twitter-api-v2 sends to https://api.x.com/2/ through the global agent.
  // Only that host connects, to the loopback port; TLS still verifies the
  // generated certificate for api.x.com.
  class LoopbackXAgent extends https.Agent {
    override createConnection(
      options: http.ClientRequestArgs,
      callback?: (error: Error | null, socket: Duplex) => void,
    ) {
      if (options.host !== X_HOST && options.hostname !== X_HOST) {
        throw new Error(`Unexpected X API host: ${options.host}`);
      }
      return super.createConnection(
        { ...options, host: "127.0.0.1", port, servername: X_HOST },
        callback,
      );
    }
  }
  https.globalAgent = new LoopbackXAgent({ ca: cert });
});

afterAll(async () => {
  if (https.globalAgent !== originalHttps) https.globalAgent.destroy();
  https.globalAgent = originalHttps;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.stop();
    await runtime.close();
  }
});

/** A timeline client on a real runtime, logged in through env credentials. */
async function timelineClient() {
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(logger, method).mockImplementation(() => undefined);
  }
  const runtime = createSQLiteTestRuntime({
    logLevel: "fatal",
    character: { name: "Agent", bio: ["test"] },
    plugins: [
      {
        name: "x-quote-model",
        description: "Writes the quote post under test",
        models: {
          [ModelType.TEXT_SMALL]: async () =>
            JSON.stringify({ post: quoteText }),
        },
      },
    ],
  });
  await runtime.initialize({ skipMigrations: true });
  runtimes.push(runtime);
  const state = {
    accountId: "default",
    TWITTER_AUTH_MODE: "env",
    TWITTER_API_KEY: "quote-key",
    TWITTER_API_SECRET_KEY: "quote-secret",
    TWITTER_ACCESS_TOKEN: "quote-token",
    TWITTER_ACCESS_TOKEN_SECRET: "quote-token-secret",
    TWITTER_DRY_RUN: false,
  } as unknown as TwitterClientState;
  const base = new ClientBase(runtime, state);
  await base.twitterClient.authenticate(
    createTwitterAuthProvider(runtime, state),
  );
  // The production queue, without its random pause between requests.
  base.requestQueue = new RequestQueue({ jitter: async () => {} });
  return new TwitterTimelineClient(base, runtime, state);
}

const quotedTweet = {
  id: QUOTED_ID,
  userId: "1800000000000000007",
  username: "alice",
  name: "Alice",
  conversationId: QUOTED_ID,
  text: "Small verifiable PRs > big rewrites.",
  timestamp: Date.now(),
  hashtags: [],
  mentions: [],
  photos: [],
  urls: [],
  videos: [],
  thread: [],
  permanentUrl: `https://x.com/alice/status/${QUOTED_ID}`,
} as unknown as Parameters<TwitterTimelineClient["handleQuoteAction"]>[0];

/** Quote text of `length` weighted characters with no whitespace or URL. */
function quoteOfLength(length: number): string {
  return "abcdefghijklmnopqrstuvwxyz"
    .repeat(Math.ceil(length / 26))
    .slice(0, length);
}

/** Runs one timeline quote action and returns what X received. */
async function quoteOnce(
  timeline: TwitterTimelineClient,
  text: string,
): Promise<{ posts: ReceivedPost[]; outcome: unknown }> {
  received = [];
  quoteText = text;
  let outcome: unknown;
  try {
    outcome = await timeline.handleQuoteAction(quotedTweet);
  } catch (error) {
    outcome = error;
  }
  return { posts: received, outcome };
}

/** The quote thread X received carries the whole text, link first. */
function expectQuoteThread(posts: ReceivedPost[], text: string) {
  expect(posts[0]?.text.endsWith(` ${STATUS_URL}`)).toBe(true);
  expect(posts[0]?.replyTo).toBeUndefined();
  for (const [index, post] of posts.entries()) {
    if (index > 0) {
      expect(post.text).not.toContain(STATUS_URL);
      expect(post.replyTo).toBeDefined();
    }
  }
  const sent = posts.map((post, index) =>
    index === 0 ? post.text.slice(0, -` ${STATUS_URL}`.length) : post.text,
  );
  expect(sent.join("")).toBe(text);
}

describe("timeline quote threads keep room for the quoted post's link", () => {
  it("posts a 269-character quote that X accepts", async () => {
    expect(twitterText.parseTweet(SENTENCE_QUOTE).weightedLength).toBe(269);
    const timeline = await timelineClient();

    const { posts, outcome } = await quoteOnce(timeline, SENTENCE_QUOTE);

    expect(outcome).toBe(true);
    expect(posts.map((post) => post.accepted)).toEqual([true, true]);
    expect(posts.every((post) => post.weighted <= X_LIMIT)).toBe(true);
    expectQuoteThread(posts, SENTENCE_QUOTE);
  });

  const groups = [
    {
      name: "one post",
      cases: MODEL_CASES.filter((item) => item.length <= 256),
    },
    {
      name: "257 to 280 characters",
      cases: MODEL_CASES.filter(
        (item) => item.length > 256 && item.length <= X_LIMIT,
      ),
    },
    {
      name: "longer quotes",
      cases: MODEL_CASES.filter((item) => item.length > X_LIMIT),
    },
  ];
  it.each(groups)("quote thread model replays $name", async ({ cases }) => {
    expect(cases.length).toBeGreaterThan(0);
    const timeline = await timelineClient();
    for (const item of cases) {
      const text = quoteOfLength(item.length);
      const { posts, outcome } = await quoteOnce(timeline, text);

      expect(
        {
          length: item.length,
          posts: posts.map((post) => post.weighted),
          refused: posts.some((post) => !post.accepted),
        },
        `quote of ${item.length}`,
      ).toEqual(item);
      expect(outcome).toBe(true);
      expectQuoteThread(posts, text);
    }
  });
});
