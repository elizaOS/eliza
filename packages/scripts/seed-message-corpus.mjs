#!/usr/bin/env node
/**
 * Seed a running agent with ~1 year of backdated conversations, messages, and
 * derived owner facts, then prove the corpus is searchable across a "one year
 * ago" time window. Manual demo-prep for message search: run `bun run dev` (or
 * any local agent), then run this against its API.
 *
 * It POSTs the dev-only `POST /api/conversations/dev/seed-messages` endpoint
 * (404 in production) — the same route the seeder module powers — so the corpus
 * is landed through the real runtime as real web-chat rooms with real backdated
 * `createdAt` values, not injected around it. After seeding it issues a couple
 * of `GET /api/conversations/messages/search` calls against the returned sample
 * queries: one unbounded, one bounded to `until = 9 months ago`, so the
 * operator can see that a relevant hit older than any recency window is still
 * found and that the `since`/`until` window narrows the result set.
 *
 * Usage:
 *   node packages/scripts/seed-message-corpus.mjs
 *   node packages/scripts/seed-message-corpus.mjs --conversations=24 --messages=60 --span-months=18
 *   node packages/scripts/seed-message-corpus.mjs --api-port=31337 --seed=99
 */
import process from "node:process";

const DEFAULT_API_PORT = 31337;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const options = {
    apiPort: Number(process.env.ELIZA_API_PORT) || DEFAULT_API_PORT,
    host: process.env.ELIZA_API_HOST || "127.0.0.1",
    body: {},
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    const [key, value] = arg.split("=", 2);
    if (value === undefined) {
      throw new Error(`Expected --key=value, got ${arg}`);
    }
    switch (key) {
      case "--api-port":
        options.apiPort = parsePositiveInt(value, key);
        break;
      case "--host":
        options.host = value;
        break;
      case "--conversations":
        options.body.conversations = parsePositiveInt(value, key);
        break;
      case "--messages":
        options.body.messagesPerConversation = parsePositiveInt(value, key);
        break;
      case "--span-months":
        options.body.spanMonths = parsePositiveInt(value, key);
        break;
      case "--facts":
        options.body.factsPerConversation = parseNonNegativeInt(value, key);
        break;
      case "--seed":
        options.body.seed = parseIntStrict(value, key);
        break;
      default:
        throw new Error(`Unknown flag ${key}`);
    }
  }
  return options;
}

function parseIntStrict(value, flag) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`${flag} must be an integer`);
  return n;
}

function parsePositiveInt(value, flag) {
  const n = parseIntStrict(value, flag);
  if (n < 1) throw new Error(`${flag} must be >= 1`);
  return n;
}

function parseNonNegativeInt(value, flag) {
  const n = parseIntStrict(value, flag);
  if (n < 0) throw new Error(`${flag} must be >= 0`);
  return n;
}

function printHelp() {
  process.stdout.write(
    `Seed a running agent with ~1 year of backdated messages for search demos.

Usage:
  node packages/scripts/seed-message-corpus.mjs [flags]

Flags:
  --api-port=N        Agent API port (default ${DEFAULT_API_PORT}; env ELIZA_API_PORT)
  --host=HOST         Agent API host (default 127.0.0.1; env ELIZA_API_HOST)
  --conversations=N   Conversations to generate (1-200, default 12)
  --messages=N        Messages per conversation (1-500, default 40)
  --span-months=N     Months of history to spread across (1-60, default 13)
  --facts=N           Derived owner facts per conversation (0-10, default 1)
  --seed=N            RNG seed for reproducible text/timestamps (default 1337)
`,
  );
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `Non-JSON response from ${url} (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }
  if (!res.ok) {
    const message =
      (parsed && typeof parsed.error === "string" && parsed.error) ||
      `HTTP ${res.status}`;
    throw new Error(`POST ${url} failed: ${message}`);
  }
  return parsed;
}

async function getJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `Non-JSON response from ${url} (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }
  if (!res.ok) {
    const message =
      (parsed && typeof parsed.error === "string" && parsed.error) ||
      `HTTP ${res.status}`;
    throw new Error(`GET ${url} failed: ${message}`);
  }
  return parsed;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const base = `http://${options.host}:${options.apiPort}`;

  process.stdout.write(`Seeding backdated message corpus via ${base} ...\n`);
  const summary = await postJson(
    `${base}/api/conversations/dev/seed-messages`,
    options.body,
  );

  process.stdout.write(
    `Seeded ${summary.conversations} conversations, ${summary.messagesCreated} messages, ` +
      `${summary.factsCreated} facts.\n` +
      `Oldest message: ${iso(summary.oldestMessageAt)}\n` +
      `Newest message: ${iso(summary.newestMessageAt)}\n` +
      `Sample queries: ${(summary.sampleQueries ?? []).join(", ")}\n\n`,
  );

  const sampleQuery = (summary.sampleQueries ?? [])[0];
  if (!sampleQuery) {
    process.stdout.write("No sample query returned; skipping search proof.\n");
    return;
  }

  // Prove the corpus is hittable across a year: an unbounded search finds the
  // topic, and an `until = 9 months ago` window still returns older hits while
  // dropping anything newer — the "messages from a year ago" case.
  const untilMs = Date.now() - 9 * MONTH_MS;
  const q = encodeURIComponent(sampleQuery);
  const unbounded = await getJson(
    `${base}/api/conversations/messages/search?q=${q}&limit=100`,
  );
  const windowed = await getJson(
    `${base}/api/conversations/messages/search?q=${q}&limit=100&until=${untilMs}`,
  );

  const oldestUnbounded = unbounded.results.reduce(
    (min, r) => Math.min(min, r.createdAt),
    Number.POSITIVE_INFINITY,
  );

  process.stdout.write(
    `Search proof for "${sampleQuery}":\n` +
      `  unbounded            → ${unbounded.count} hits (oldest ${
        Number.isFinite(oldestUnbounded) ? iso(oldestUnbounded) : "n/a"
      })\n` +
      `  until=9 months ago   → ${windowed.count} hits (all createdAt <= ${iso(untilMs)})\n`,
  );

  const windowRespected = windowed.results.every((r) => r.createdAt <= untilMs);
  if (!windowRespected) {
    throw new Error(
      "Time-window search returned a hit newer than `until` — the store is ignoring the window",
    );
  }
  process.stdout.write("Time window honored by the store. Done.\n");
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
