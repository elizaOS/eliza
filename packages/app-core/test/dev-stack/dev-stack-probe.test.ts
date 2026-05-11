/**
 * Live desktop dev stack probe.
 *
 * Opt in with `MILADY_DESKTOP_QA=1 bun run --cwd packages/app-core test -- dev-stack`.
 * Requires `bun run dev:desktop` to be running concurrently (so the API on
 * 127.0.0.1:<MILADY_API_PORT> and the Vite UI are up).
 *
 * Without the env var, every test in this file skips cleanly. This file is
 * not part of CI — CI does not set `MILADY_DESKTOP_QA`.
 */

import { exec } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  type DevStackPayload,
  ELIZA_DEV_STACK_SCHEMA,
} from "../../src/api/dev-stack";

const execFile = promisify(exec);

const QA_ENABLED = process.env.MILADY_DESKTOP_QA === "1";
const HTTP_TIMEOUT_MS = 10_000;

const fileDir = path.dirname(fileURLToPath(import.meta.url));
const stackStatusScript = path.resolve(
  fileDir,
  "../../scripts/desktop-stack-status.mjs",
);

type StackStatusReport = {
  uiPort: number;
  apiPort: number;
  uiListening: boolean;
  apiListening: boolean;
  devStack: DevStackPayload | null;
  apiHealth: { ok: boolean; status: number };
  apiStatus: { ok: boolean; status: number };
};

function isStackStatusReport(value: unknown): value is StackStatusReport {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.uiListening === "boolean" &&
    typeof obj.apiListening === "boolean" &&
    typeof obj.apiPort === "number" &&
    typeof obj.uiPort === "number" &&
    typeof obj.apiHealth === "object" &&
    obj.apiHealth !== null &&
    typeof obj.apiStatus === "object" &&
    obj.apiStatus !== null
  );
}

function assertDevStackShape(
  value: unknown,
): asserts value is DevStackPayload {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  const v = value as Record<string, unknown>;
  expect(v.schema).toBe(ELIZA_DEV_STACK_SCHEMA);

  expect(v.api).toBeTypeOf("object");
  const api = v.api as Record<string, unknown>;
  expect(typeof api.listenPort).toBe("number");
  expect(api.listenPort).toBeGreaterThan(0);
  expect(typeof api.baseUrl).toBe("string");

  expect(v.desktop).toBeTypeOf("object");
  const desktop = v.desktop as Record<string, unknown>;
  expect(
    desktop.rendererUrl === null || typeof desktop.rendererUrl === "string",
  ).toBe(true);
  expect(
    desktop.uiPort === null || typeof desktop.uiPort === "number",
  ).toBe(true);
  expect(
    desktop.desktopApiBase === null ||
      typeof desktop.desktopApiBase === "string",
  ).toBe(true);

  expect(v.cursorScreenshot).toBeTypeOf("object");
  const cs = v.cursorScreenshot as Record<string, unknown>;
  expect(typeof cs.available).toBe("boolean");
  expect(cs.path === null || typeof cs.path === "string").toBe(true);

  expect(v.desktopDevLog).toBeTypeOf("object");
  const log = v.desktopDevLog as Record<string, unknown>;
  expect(
    log.filePath === null || typeof log.filePath === "string",
  ).toBe(true);
  expect(
    log.apiTailPath === null || typeof log.apiTailPath === "string",
  ).toBe(true);

  expect(Array.isArray(v.hints)).toBe(true);
}

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

describe("live desktop dev stack probe", () => {
  test.skipIf(!QA_ENABLED)(
    "desktop dev stack not opted in via MILADY_DESKTOP_QA=1",
    () => {
      // This test only runs when MILADY_DESKTOP_QA=1, where it acts as a
      // self-check that the env was read correctly. When the env is unset,
      // vitest reports this test as skipped with the message above — that's
      // the explicit "not opted in" signal the runner asked for.
      expect(QA_ENABLED).toBe(true);
    },
  );

  describe.skipIf(!QA_ENABLED)("with MILADY_DESKTOP_QA=1", () => {
    let report: StackStatusReport;
    let baseUrl: string;

    test("desktop:stack-status --json exits 0 and emits parseable JSON", async () => {
      const { stdout } = await execFile(
        `node ${JSON.stringify(stackStatusScript)} --json`,
        { timeout: 15_000 },
      );

      const parsed: unknown = JSON.parse(stdout);
      expect(isStackStatusReport(parsed)).toBe(true);
      report = parsed as StackStatusReport;

      expect(report.uiListening).toBe(true);
      expect(report.apiListening).toBe(true);
      expect(report.devStack).not.toBeNull();

      assertDevStackShape(report.devStack);
      baseUrl = (report.devStack as DevStackPayload).api.baseUrl;

      const url = new URL(baseUrl);
      expect(url.hostname).toBe("127.0.0.1");
      expect(url.protocol).toBe("http:");
      expect(Number.parseInt(url.port, 10)).toBeGreaterThan(0);
    });

    test("GET /api/dev/stack returns a well-formed DevStackPayload", async () => {
      expect(baseUrl, "previous test populated baseUrl").toBeTruthy();
      const res = await fetchWithTimeout(`${baseUrl}/api/dev/stack`);
      expect(res.status).toBe(200);
      const payload: unknown = await res.json();
      assertDevStackShape(payload);
    });

    test("GET /api/dev/cursor-screenshot returns PNG or documented 503/404", async () => {
      expect(baseUrl, "previous test populated baseUrl").toBeTruthy();
      const res = await fetchWithTimeout(`${baseUrl}/api/dev/cursor-screenshot`);

      if (res.status === 200) {
        const contentType = res.headers.get("content-type") ?? "";
        expect(contentType).toContain("image/png");
        const buf = Buffer.from(await res.arrayBuffer());
        expect(buf.byteLength).toBeGreaterThan(0);
        // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
        expect(buf.subarray(0, 4).toString("hex")).toBe("89504e47");
        return;
      }

      // Documented non-success cases:
      // - 404 when screenshot server not enabled
      // - 502/503 when Electrobun not running / upstream unreachable
      // - 403 from upstream auth
      expect([403, 404, 502, 503]).toContain(res.status);
      const body = (await res.json()) as { error?: string };
      expect(typeof body.error).toBe("string");
      expect(body.error?.length ?? 0).toBeGreaterThan(0);
    });

    test("GET /api/dev/console-log?maxLines=10 returns text content", async () => {
      expect(baseUrl, "previous test populated baseUrl").toBeTruthy();
      const res = await fetchWithTimeout(
        `${baseUrl}/api/dev/console-log?maxLines=10`,
      );

      if (res.status === 200) {
        const contentType = res.headers.get("content-type") ?? "";
        expect(contentType).toContain("text/plain");
        const text = await res.text();
        expect(typeof text).toBe("string");
        return;
      }

      // 404 when ELIZA_DESKTOP_DEV_LOG_PATH is not configured (opt-out via
      // ELIZA_DESKTOP_DEV_LOG=0). Body carries a documented error string.
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: string };
      expect(typeof body.error).toBe("string");
    });
  });
});
