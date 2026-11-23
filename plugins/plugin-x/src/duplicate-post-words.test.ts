/**
 * The autonomous post loop skips a generated post that repeats one of the
 * agent's recent posts (isDuplicateTweet in src/utils/memory.ts). Besides
 * equal text and an almost equal set of words, a post that contains a recent
 * post, or is contained in one, counts as a repeat. That containment must be
 * checked on whole words: after "GM ☀️" (normalized to "gm"), a post about a
 * "paradigm" or with "wagmi" in it is a new post, not a repeat.
 *
 * Real AgentRuntime (SQLite) with the assistant plugin, whose POST_GENERATED
 * handler writes each post with the TEXT_LARGE model, a real ClientBase with
 * env (OAuth 1.0a) login and the real twitter-api-v2 client, and
 * TwitterPostClient.generateNewTweet, the step the post loop runs on each
 * interval. Only the network is replaced: api.x.com connects to a loopback
 * HTTPS server that records every post it receives.
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
import { createAssistantPlugin } from "@elizaos/plugin-assistant";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
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
import { TwitterPostClient } from "./post";
import type { TwitterClientState } from "./types";

const X_HOST = "api.x.com";
const AGENT = { id: "1700000000000000001", name: "Agent", username: "agent" };

/** The posts of the model (quint/XDuplicatePost.qnt), by name. */
const POSTS: Record<string, string> = {
  gm: "GM ☀️",
  gmFrens: "gm frens",
  paradigm: "Paradigm shift ahead.",
  shiftParadigm: "Ahead: shift, paradigm!",
  wagmi: "wagmi",
  sun: "☀️",
};

/** One model case: the posts the agent wrote, in order, and those X got. */
type ModelCase = { generated: string[]; sent: string[] };

// Without the model's env variable, every group still replays one case.
const DEFAULT_CASES: ModelCase[] = [
  {
    generated: ["gm", "paradigm", "wagmi"],
    sent: ["gm", "paradigm", "wagmi"],
  },
  { generated: ["gmFrens", "gm", "sun"], sent: ["gmFrens", "sun"] },
  {
    generated: ["paradigm", "shiftParadigm", "gm"],
    sent: ["paradigm", "gm"],
  },
  {
    generated: ["shiftParadigm", "gm", "gmFrens"],
    sent: ["shiftParadigm", "gm"],
  },
  { generated: ["wagmi", "gm", "wagmi"], sent: ["wagmi", "gm"] },
  { generated: ["sun", "sun", "gm"], sent: ["sun", "gm"] },
];
const MODEL_CASES: ModelCase[] = process.env.ELIZA_X_DUPLICATE_POST_MODEL_CASES
  ? JSON.parse(
      readFileSync(process.env.ELIZA_X_DUPLICATE_POST_MODEL_CASES, "utf8"),
    )
  : DEFAULT_CASES;

const originalHttps = https.globalAgent;
let directory: string;
let server: https.Server;
let received: string[] = [];
let nextPostId = 1900000000000000000n;
let nextText = "";
const runtimes: AgentRuntime[] = [];

function sendJson(
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
    sendJson(response, 200, { data: AGENT });
    return;
  }
  if (request.method === "POST" && url.pathname === "/2/tweets") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part: string) => {
      body += part;
    });
    request.on("end", () => {
      const { text } = JSON.parse(body) as { text: string };
      received.push(text);
      nextPostId += 1n;
      sendJson(response, 201, { data: { id: nextPostId.toString(), text } });
    });
    return;
  }
  sendJson(response, 404, { title: "Not Found", status: 404 });
};

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "eliza-x-duplicate-"));
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

/** A post client of a new agent, logged in through env credentials. */
async function postClient(): Promise<TwitterPostClient> {
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(logger, method).mockImplementation(() => undefined);
  }
  const runtime = createSQLiteTestRuntime({
    logLevel: "fatal",
    character: { name: "Agent", bio: ["test"] },
    plugins: [
      createAssistantPlugin(),
      {
        name: "x-duplicate-model",
        description: "Writes the post under test",
        models: {
          [ModelType.TEXT_LARGE]: async () =>
            JSON.stringify({ thought: "", post: nextText }),
        },
      },
    ],
  });
  await runtime.initialize({ skipMigrations: true });
  runtimes.push(runtime);
  const state = {
    accountId: "default",
    TWITTER_AUTH_MODE: "env",
    TWITTER_API_KEY: "duplicate-key",
    TWITTER_API_SECRET_KEY: "duplicate-secret",
    TWITTER_ACCESS_TOKEN: "duplicate-token",
    TWITTER_ACCESS_TOKEN_SECRET: "duplicate-token-secret",
    TWITTER_DRY_RUN: false,
  } as unknown as TwitterClientState;
  const base = new ClientBase(runtime, state);
  await base.twitterClient.authenticate(
    createTwitterAuthProvider(runtime, state),
  );
  // The production queue, without its random pause between requests.
  base.requestQueue = new RequestQueue({ jitter: async () => {} });
  return new TwitterPostClient(base, runtime, state);
}

/** Runs one scheduled post step per text and returns what X received. */
async function postInTurn(texts: string[]): Promise<string[]> {
  const posts = await postClient();
  received = [];
  try {
    for (const text of texts) {
      nextText = text;
      await posts.generateNewTweet();
    }
    return received;
  } finally {
    for (const runtime of runtimes.splice(0)) {
      await runtime.stop();
      await runtime.close();
    }
  }
}

describe("duplicate posts are matched on whole words", () => {
  it("posts paradigm and wagmi after a GM post", async () => {
    const texts = [
      "GM ☀️",
      "The paradigm for agent tooling is shifting toward small, verifiable PRs.",
      "wagmi if we keep shipping tests with every fix",
    ];

    expect(await postInTurn(texts)).toEqual(texts);
  });

  it("skips a post that contains a recent post", async () => {
    const texts = [
      "Shipped the new release today.",
      "Shipped the new release today, thanks to everyone who tested it!",
    ];

    expect(await postInTurn(texts)).toEqual([texts[0]]);
  });

  const groups = Object.keys(POSTS).map((name) => ({
    name,
    cases: MODEL_CASES.filter((item) => item.generated[0] === name),
  }));
  it.each(groups)("post model replays $name first", async ({ cases }) => {
    expect(cases.length).toBeGreaterThan(0);
    for (const item of cases) {
      const sent = await postInTurn(item.generated.map((name) => POSTS[name]));

      expect(sent, item.generated.join(",")).toEqual(
        item.sent.map((name) => POSTS[name]),
      );
    }
  });
});
