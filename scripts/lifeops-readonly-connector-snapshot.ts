#!/usr/bin/env tsx
import crypto from "node:crypto";
import fs from "node:fs";

interface SnapshotEndpoint {
  id: string;
  path: string;
  safe: boolean;
  note?: string;
}

interface EndpointSnapshot {
  id: string;
  path: string;
  ok: boolean;
  status: number | null;
  note?: string;
  shape: unknown;
  sample: unknown;
  error?: string;
}

const SAFE_ENDPOINTS: SnapshotEndpoint[] = [
  {
    id: "google.status",
    path: "/api/lifeops/connectors/google/status",
    safe: true,
  },
  {
    id: "gmail.triage",
    path: "/api/lifeops/gmail/triage?maxResults=5",
    safe: true,
  },
  { id: "calendar.feed", path: "/api/lifeops/calendar/feed", safe: true },
  {
    id: "imessage.status",
    path: "/api/lifeops/connectors/imessage/status",
    safe: true,
  },
  {
    id: "imessage.chats",
    path: "/api/lifeops/connectors/imessage/chats",
    safe: true,
  },
  {
    id: "imessage.messages",
    path: "/api/lifeops/connectors/imessage/messages?limit=5",
    safe: true,
  },
  {
    id: "telegram.status",
    path: "/api/lifeops/connectors/telegram/status",
    safe: true,
  },
  {
    id: "signal.status",
    path: "/api/lifeops/connectors/signal/status",
    safe: true,
  },
  {
    id: "discord.status",
    path: "/api/lifeops/connectors/discord/status",
    safe: true,
  },
  {
    id: "whatsapp.status",
    path: "/api/lifeops/connectors/whatsapp/status",
    safe: true,
  },
  {
    id: "whatsapp.messages",
    path: "/api/lifeops/connectors/whatsapp/messages?limit=5",
    safe: true,
  },
  { id: "x.status", path: "/api/lifeops/connectors/x/status", safe: true },
  { id: "x.dms.digest", path: "/api/lifeops/x/dms/digest?limit=5", safe: true },
];

const DESTRUCTIVE_PULL_ENDPOINTS: SnapshotEndpoint[] = [
  {
    id: "signal.messages",
    path: "/api/lifeops/connectors/signal/messages?limit=5",
    safe: false,
    note: "Skipped unless --include-destructive-pulls is set because signal-cli receive can consume the daemon queue.",
  },
];

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function hashValue(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function redactString(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "<phone>")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, (match) => `<id:${hashValue(match)}>`);
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "<depth-limit>";
  if (typeof value === "string") return redactString(value);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 3).map((entry) => redact(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        redact(entry, depth + 1),
      ]),
    );
  }
  return null;
}

function shapeOf(value: unknown, depth = 0): unknown {
  if (depth > 5) return "...";
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      item: value.length > 0 ? shapeOf(value[0], depth + 1) : null,
    };
  }
  if (value && typeof value === "object") {
    return {
      type: "object",
      keys: Object.keys(value as Record<string, unknown>).sort(),
      fields: Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
          key,
          shapeOf(entry, depth + 1),
        ]),
      ),
    };
  }
  return value === null ? "null" : typeof value;
}

async function snapshotEndpoint(
  baseUrl: string,
  endpoint: SnapshotEndpoint,
): Promise<EndpointSnapshot> {
  const url = new URL(endpoint.path, baseUrl);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const text = await response.text();
    const body = text.trim().length > 0 ? JSON.parse(text) : null;
    return {
      id: endpoint.id,
      path: endpoint.path,
      ok: response.ok,
      status: response.status,
      note: endpoint.note,
      shape: shapeOf(body),
      sample: redact(body),
    };
  } catch (error) {
    return {
      id: endpoint.id,
      path: endpoint.path,
      ok: false,
      status: null,
      note: endpoint.note,
      shape: null,
      sample: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function compareShapes(
  current: EndpointSnapshot[],
  baselinePath: string,
): Array<{
  id: string;
  changed: boolean;
  baseline?: unknown;
  current: unknown;
}> {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as {
    endpoints?: EndpointSnapshot[];
  };
  const baselineById = new Map(
    (baseline.endpoints ?? []).map((endpoint) => [endpoint.id, endpoint.shape]),
  );
  return current.map((endpoint) => {
    const baselineShape = baselineById.get(endpoint.id);
    return {
      id: endpoint.id,
      changed: JSON.stringify(baselineShape) !== JSON.stringify(endpoint.shape),
      baseline: baselineShape,
      current: endpoint.shape,
    };
  });
}

async function main(): Promise<void> {
  const baseUrl =
    argValue("base-url") ??
    process.env.LIFEOPS_API_BASE ??
    process.env.ELIZA_API_BASE ??
    "http://127.0.0.1:31337";
  const includeDestructivePulls = hasFlag("include-destructive-pulls");
  const endpoints = [
    ...SAFE_ENDPOINTS,
    ...(includeDestructivePulls ? DESTRUCTIVE_PULL_ENDPOINTS : []),
  ];
  const snapshots = [];
  for (const endpoint of endpoints) {
    snapshots.push(await snapshotEndpoint(baseUrl, endpoint));
  }
  const output = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    policy: {
      method: "GET only",
      destructivePullsIncluded: includeDestructivePulls,
      skipped: includeDestructivePulls ? [] : DESTRUCTIVE_PULL_ENDPOINTS,
    },
    endpoints: snapshots,
    ...(argValue("baseline")
      ? {
          shapeComparison: compareShapes(snapshots, argValue("baseline") ?? ""),
        }
      : {}),
  };
  const json = JSON.stringify(output, null, 2);
  const outPath = argValue("out");
  if (outPath) {
    fs.writeFileSync(outPath, `${json}\n`, "utf8");
  } else {
    process.stdout.write(`${json}\n`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
