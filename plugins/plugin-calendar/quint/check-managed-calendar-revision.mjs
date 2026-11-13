import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  calendarAgentWrite,
  managedCalendarUpdatedAt,
} from "../src/service/managed-calendar-host.ts";

const cli = fileURLToPath(
  new URL(
    "../../../node_modules/@informalsystems/quint/dist/src/cli.js",
    import.meta.url,
  ),
);
const model = path.resolve(process.argv[2]);
const output = mkdtempSync(path.join(tmpdir(), "managed-calendar-revision-"));
const states = new Map();
try {
  execFileSync(
    process.execPath,
    [
      cli,
      "run",
      model,
      "--main=ManagedCalendarRevision",
      "--backend=typescript",
      "--seed=20261112",
      "--max-samples=24",
      "--n-traces=24",
      "--max-steps=6",
      "--invariant=invariant",
      `--out-itf=${path.join(output, "trace-{seq}.itf.json")}`,
      "--verbosity=0",
    ],
    { stdio: "inherit" },
  );
  for (const file of readdirSync(output)) {
    for (const state of JSON.parse(
      readFileSync(path.join(output, file), "utf8"),
    ).states) {
      if (!state.synchronized) continue;
      const values = [
        "providerRevision",
        "legacyRevision",
        "refreshTime",
        "cachedRevision",
      ].map((key) => Number(state[key]["#bigint"]));
      states.set(values.join(","), values);
    }
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}

const scope = "a".repeat(64);
const event = {
  title: "Calendar fixture",
  description: "",
  location: "",
  startAt: "2026-11-24T19:00:00.000Z",
  endAt: "2026-11-24T19:30:00.000Z",
  timeZone: "UTC",
  isAllDay: false,
  attendees: [],
};
const timestamp = (revision) =>
  new Date(Date.UTC(2026, 9, 1) + revision * 86_400_000).toISOString();
const covered = new Set();
for (const [primary, legacy, refreshed, cached] of states.values()) {
  covered.add(primary >= 0 ? "current" : legacy >= 0 ? "legacy" : "missing");
  const metadata = {
    etag: '"v1"',
    ...(primary >= 0 ? { updatedAt: timestamp(primary) } : {}),
    ...(legacy >= 0 ? { updated: timestamp(legacy) } : {}),
  };
  const syncedAt = timestamp(refreshed);
  const result = await calendarAgentWrite(
    {
      async googleCalendarSync(command) {
        if (command.kind === "get")
          return { event: { eventId: "event", etag: metadata.etag, event } };
        assert.equal(command.kind, "capabilities");
        return {
          version: 1,
          calendarId: "primary",
          accountId: "fixture",
          read: true,
          write: true,
          idempotentCreate: true,
          conditionalWrites: true,
          providerExactlyOnce: false,
        };
      },
      async googleCalendarFeed() {
        return {
          syncedAt,
          events: [{ ...event, externalId: "event", metadata }],
        };
      },
    },
    "fixture",
    scope,
    {
      operation: "write-target",
      grantId: `google:${scope}`,
      calendarId: "primary",
      eventId: "event",
    },
    new AbortController().signal,
  );
  assert.equal(result.event.updatedAt, timestamp(cached));
  assert.equal(result.event.syncedAt, syncedAt);
  assert.equal(managedCalendarUpdatedAt(metadata, syncedAt), timestamp(cached));
}
assert.deepEqual(covered, new Set(["current", "legacy", "missing"]));
console.log(
  `Managed Calendar readback matches ${states.size} model-generated states`,
);
