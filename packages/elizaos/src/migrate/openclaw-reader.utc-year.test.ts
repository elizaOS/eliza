/**
 * `OcDailyLog.epochMs` is documented as "epoch ms of the date at UTC midnight",
 * so it must agree with the `date` string parsed out of the same filename.
 *
 * `Date.UTC(year, ...)` remaps years 0-99 into 1900-1999, and the daily-log
 * filename pattern is `\d{4}`, so `0099-03-04.md` parses to `Number("0099")`
 * === 99 and lands on 1999-03-04 while `date` still reads "0099-03-04". The
 * record contradicts itself, and the migration then tiers those memories by a
 * timestamp 1900 years off.
 *
 * Drives the real exported reader against a real temp directory — no mocks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readOcAgentHome } from "./openclaw-reader.js";

const made: string[] = [];

function homeWithDailyLogs(names: string[]): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-utc-"));
  made.push(home);
  const memoryDir = path.join(home, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  for (const name of names) {
    fs.writeFileSync(path.join(memoryDir, name), `log ${name}\n`, "utf8");
  }
  return home;
}

/** UTC midnight for a calendar date, with years 0-99 kept literal. */
function utcMidnight(year: number, month: number, day: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

afterEach(() => {
  while (made.length > 0) {
    const dir = made.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("openclaw daily log epochMs", () => {
  it("matches the parsed date for an ordinary four-digit year", () => {
    const source = readOcAgentHome(homeWithDailyLogs(["2026-03-04.md"]), "a");
    const log = source.dailyLogs.find((l) => l.filename === "2026-03-04.md");
    expect(log?.date).toBe("2026-03-04");
    expect(log?.epochMs).toBe(utcMidnight(2026, 3, 4));
  });

  it("keeps a year in 0-99 literal instead of remapping it into the 1900s", () => {
    const source = readOcAgentHome(homeWithDailyLogs(["0099-03-04.md"]), "a");
    const log = source.dailyLogs.find((l) => l.filename === "0099-03-04.md");
    expect(log?.date).toBe("0099-03-04");
    expect(log?.epochMs).toBe(utcMidnight(99, 3, 4));
    // The remapped value Date.UTC produces is 1999-03-04.
    expect(log?.epochMs).not.toBe(Date.UTC(99, 2, 4));
    expect(new Date(log?.epochMs ?? 0).getUTCFullYear()).toBe(99);
  });

  it("keeps year 0000 literal", () => {
    const source = readOcAgentHome(homeWithDailyLogs(["0000-01-01.md"]), "a");
    const log = source.dailyLogs.find((l) => l.filename === "0000-01-01.md");
    expect(new Date(log?.epochMs ?? 0).getUTCFullYear()).toBe(0);
  });

  it("orders low-year logs before modern ones", () => {
    const source = readOcAgentHome(
      homeWithDailyLogs(["2026-03-04.md", "0099-03-04.md"]),
      "a",
    );
    const ordered = [...source.dailyLogs].sort((a, b) => a.epochMs - b.epochMs);
    expect(ordered.map((l) => l.date)).toEqual(["0099-03-04", "2026-03-04"]);
  });
});
