#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const DEFAULT_HEADERS = [
  "Subject",
  "From",
  "To",
  "Cc",
  "Date",
  "Reply-To",
  "Message-Id",
  "References",
  "List-Id",
  "Precedence",
  "Auto-Submitted",
];

function readFlag(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function readNumberFlag(name, fallback) {
  const raw = readFlag(name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function scrubText(value, emailMap) {
  return String(value ?? "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) =>
      scrubEmail(email, emailMap),
    )
    .replace(/https?:\/\/\S+/gi, "https://example.test/redacted")
    .replace(/\b\+?\d[\d\s().-]{7,}\d\b/g, "+1-555-0100")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function scrubEmail(email, emailMap) {
  const key = email.toLowerCase();
  const existing = emailMap.get(key);
  if (existing) return existing;
  const next = `person${emailMap.size + 1}@example.test`;
  emailMap.set(key, next);
  return next;
}

function scrubStableId(value, prefix, idMap) {
  const key = String(value ?? "").trim();
  if (!key) {
    return `${prefix}-missing`;
  }
  const existing = idMap.get(key);
  if (existing) {
    return existing;
  }
  const digest = crypto.createHash("sha256").update(key).digest("hex");
  const scrubbed = `${prefix}-${digest.slice(0, 16)}`;
  idMap.set(key, scrubbed);
  return scrubbed;
}

function scrubHeader(header, emailMap) {
  const name = String(header?.name ?? "");
  const value = String(header?.value ?? "");
  if (!name) return null;
  return {
    name,
    value: scrubText(value, emailMap),
  };
}

function scrubMessage(message, index, emailMap, idMap, threadIdMap) {
  const headers = Array.isArray(message.payload?.headers)
    ? message.payload.headers
        .map((header) => scrubHeader(header, emailMap))
        .filter(Boolean)
    : [];
  return {
    id: scrubStableId(
      message.id ?? `missing-message-${index}`,
      "fixture-msg",
      idMap,
    ),
    threadId: scrubStableId(
      message.threadId ?? `missing-thread-${index}`,
      "fixture-thread",
      threadIdMap,
    ),
    labelIds: Array.isArray(message.labelIds) ? message.labelIds : [],
    snippet: scrubText(message.snippet, emailMap),
    internalDate: String(message.internalDate ?? Date.now()),
    historyId: String(message.historyId ?? index + 1),
    sizeEstimate: Number.isFinite(message.sizeEstimate)
      ? message.sizeEstimate
      : undefined,
    payload: {
      mimeType: "text/plain",
      headers,
    },
  };
}

function assertScrubbed(value) {
  const serialized = JSON.stringify(value);
  const leakedEmails = serialized.match(
    /[A-Z0-9._%+-]+@(?!example\.test\b)[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  );
  if (leakedEmails && leakedEmails.length > 0) {
    throw new Error(
      `Scrubbed fixture still contains real-looking email addresses: ${[
        ...new Set(leakedEmails),
      ].join(", ")}`,
    );
  }
  const tokenPatterns = [
    /\bya29\.[A-Za-z0-9._-]+\b/g,
    /\bBearer\s+[A-Za-z0-9._-]+\b/gi,
    /\brefresh_token\b/gi,
    /\baccess_token\b/gi,
  ];
  for (const pattern of tokenPatterns) {
    const matches = serialized.match(pattern);
    if (matches && matches.length > 0) {
      throw new Error("Scrubbed fixture still contains credential-like data.");
    }
  }
}

async function gmailJson(pathname, token) {
  const response = await fetch(`${GMAIL_BASE}${pathname}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Gmail read failed ${response.status}: ${await response.text()}`,
    );
  }
  return await response.json();
}

async function main() {
  const token = process.env.GOOGLE_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "GOOGLE_ACCESS_TOKEN is required for read-only Gmail export.",
    );
  }
  const out = readFlag("--out", "test/mocks/fixtures/gmail.scrubbed.json");
  const rawOut = readFlag("--raw-out");
  const query = readFlag("--query", "newer_than:30d") ?? "newer_than:30d";
  const maxResults = Math.min(readNumberFlag("--max", 25), 50);
  const params = new URLSearchParams({
    q: query,
    maxResults: String(maxResults),
    includeSpamTrash: "false",
  });
  const listed = await gmailJson(`/messages?${params.toString()}`, token);
  const refs = Array.isArray(listed.messages) ? listed.messages : [];
  const metadataParams = new URLSearchParams({ format: "metadata" });
  for (const header of DEFAULT_HEADERS) {
    metadataParams.append("metadataHeaders", header);
  }
  const rawMessages = [];
  for (const ref of refs) {
    if (!ref?.id) continue;
    rawMessages.push(
      await gmailJson(
        `/messages/${encodeURIComponent(ref.id)}?${metadataParams.toString()}`,
        token,
      ),
    );
  }
  if (rawOut && process.env.ELIZA_GMAIL_EXPORT_WRITE_RAW === "1") {
    await fs.mkdir(path.dirname(rawOut), { recursive: true });
    await fs.writeFile(
      rawOut,
      `${JSON.stringify({ messages: rawMessages }, null, 2)}\n`,
    );
  }
  const emailMap = new Map();
  const idMap = new Map();
  const threadIdMap = new Map();
  const scrubbed = {
    exportedAt: new Date().toISOString(),
    query,
    maxResults,
    messages: rawMessages.map((message, index) =>
      scrubMessage(message, index, emailMap, idMap, threadIdMap),
    ),
  };
  assertScrubbed(scrubbed);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(scrubbed, null, 2)}\n`);
  console.log(`Wrote scrubbed Gmail fixture: ${out}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
