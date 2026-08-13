/**
 * Unit and CLI-boundary tests for the login-transfer measurement harness. The
 * deterministic cases verify invalid flags fail before Chromium launches and
 * broken renderers cannot qualify as performance improvements.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertLoginSurfaceReady,
  assertNoRuntimeErrors,
  collectLoginSurfaceProbe,
  MAX_TIMER_DELAY_MS,
  parseArgs,
  parseDecimalInt,
} from "./measure-anonymous-login-transfer.mjs";

// Resolve the CLI relative to this test file (a sibling .mjs), not
// process.cwd(): the client test lane runs vitest from packages/app, so a
// cwd-relative "packages/app/..." path doubles into
// packages/app/packages/app/... and the spawned Node can't find the module.
const SCRIPT_PATH = path.join(
  import.meta.dirname,
  "measure-anonymous-login-transfer.mjs",
);

describe("parseDecimalInt", () => {
  it("accepts non-negative decimal integers through an explicit max", () => {
    expect(parseDecimalInt("0", "--settle-ms", { min: 0 })).toBe(0);
    expect(parseDecimalInt("1", "--timeout", { min: 1 })).toBe(1);
    expect(parseDecimalInt("6000", "--settle-ms")).toBe(6000);
    expect(
      parseDecimalInt(String(MAX_TIMER_DELAY_MS), "--timeout", {
        min: 1,
        max: MAX_TIMER_DELAY_MS,
      }),
    ).toBe(MAX_TIMER_DELAY_MS);
  });

  it.each([
    undefined,
    "",
    "junk",
    "10junk",
    "-1",
    "1.5",
    "1e3",
    "+2",
    " 3",
    "08",
    "NaN",
    "Infinity",
    "--url",
  ] as Array<string | undefined>)(
    "rejects invalid input %j at the boundary",
    (raw) => {
      expect(() => parseDecimalInt(raw, "--settle-ms")).toThrow(/--settle-ms/);
    },
  );

  it("rejects values below min or above max", () => {
    expect(() =>
      parseDecimalInt("0", "--timeout", { min: 1, max: MAX_TIMER_DELAY_MS }),
    ).toThrow(/--timeout/);
    expect(() =>
      parseDecimalInt(String(MAX_TIMER_DELAY_MS + 1), "--timeout", {
        min: 1,
        max: MAX_TIMER_DELAY_MS,
      }),
    ).toThrow(/--timeout/);
  });
});

describe("parseArgs --settle-ms / --timeout", () => {
  it("keeps defaults when flags are omitted", () => {
    const args = parseArgs(["node", "measure-anonymous-login-transfer.mjs"]);
    expect(args.settleMs).toBe(6000);
    expect(args.timeout).toBe(90_000);
  });

  it("records valid overrides including zero settle", () => {
    const args = parseArgs([
      "node",
      "measure-anonymous-login-transfer.mjs",
      "--settle-ms",
      "0",
      "--timeout",
      "5000",
      "--url",
      "http://127.0.0.1:4173/login",
    ]);
    expect(args.settleMs).toBe(0);
    expect(args.timeout).toBe(5000);
    expect(args.url).toBe("http://127.0.0.1:4173/login");
  });

  it("fails closed when --settle-ms is missing or malformed", () => {
    expect(() =>
      parseArgs([
        "node",
        "measure-anonymous-login-transfer.mjs",
        "--settle-ms",
      ]),
    ).toThrow(/--settle-ms/);
    expect(() =>
      parseArgs([
        "node",
        "measure-anonymous-login-transfer.mjs",
        "--settle-ms",
        "junk",
      ]),
    ).toThrow(/junk/);
    expect(() =>
      parseArgs([
        "node",
        "measure-anonymous-login-transfer.mjs",
        "--settle-ms",
        "-3",
      ]),
    ).toThrow(/--settle-ms/);
    expect(() =>
      parseArgs([
        "node",
        "measure-anonymous-login-transfer.mjs",
        "--settle-ms",
        "1.5",
      ]),
    ).toThrow(/--settle-ms/);
    expect(() =>
      parseArgs([
        "node",
        "measure-anonymous-login-transfer.mjs",
        "--settle-ms",
        "--url",
        "http://example",
      ]),
    ).toThrow(/--settle-ms/);
  });

  it("fails closed when --timeout is missing or malformed", () => {
    expect(() =>
      parseArgs(["node", "measure-anonymous-login-transfer.mjs", "--timeout"]),
    ).toThrow(/--timeout/);
    expect(() =>
      parseArgs([
        "node",
        "measure-anonymous-login-transfer.mjs",
        "--timeout",
        "10junk",
      ]),
    ).toThrow(/10junk/);
    expect(() =>
      parseArgs([
        "node",
        "measure-anonymous-login-transfer.mjs",
        "--timeout",
        "0",
      ]),
    ).toThrow(/--timeout/);
    expect(() =>
      parseArgs([
        "node",
        "measure-anonymous-login-transfer.mjs",
        "--timeout",
        String(MAX_TIMER_DELAY_MS + 1),
      ]),
    ).toThrow(/--timeout/);
  });

  it("accepts the exact Node timer ceiling for both flags", () => {
    const args = parseArgs([
      "node",
      "measure-anonymous-login-transfer.mjs",
      "--settle-ms",
      String(MAX_TIMER_DELAY_MS),
      "--timeout",
      String(MAX_TIMER_DELAY_MS),
    ]);
    expect(args.settleMs).toBe(MAX_TIMER_DELAY_MS);
    expect(args.timeout).toBe(MAX_TIMER_DELAY_MS);
  });
});

describe("assertNoRuntimeErrors", () => {
  it("accepts a clean renderer", () => {
    expect(() => assertNoRuntimeErrors([], "desktop")).not.toThrow();
  });

  it("rejects a crashed renderer with bounded diagnostics", () => {
    expect(() =>
      assertNoRuntimeErrors(
        ["console: React is not defined", "page: mount failed"],
        "mobile",
      ),
    ).toThrow(
      "mobile /login emitted 2 runtime error(s): console: React is not defined | page: mount failed",
    );
  });
});

/** @param {"blank" | "valid"} fixture */
function installLoginProbeDom(fixture) {
  const previousDocument = globalThis.document;
  const previousGetComputedStyle = globalThis.getComputedStyle;

  /** @param {any} node @param {string} selector */
  function matches(node, selector) {
    if (selector.startsWith("#")) return node.id === selector.slice(1);
    if (selector.startsWith("[") && selector.endsWith("]")) {
      const body = selector.slice(1, -1);
      const eq = body.indexOf("=");
      if (eq === -1) return node.getAttribute(body) != null;
      const key = body.slice(0, eq);
      let value = body.slice(eq + 1);
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return node.getAttribute(key) === value;
    }
    if (selector.includes("[")) {
      const tag = selector.slice(0, selector.indexOf("["));
      const attrPart = selector.slice(selector.indexOf("["));
      return node.tagName === tag.toUpperCase() && matches(node, attrPart);
    }
    return node.tagName === selector.toUpperCase();
  }

  /** @param {string} tagName @param {Record<string, unknown>} [attrs] @param {any[]} [children] */
  function el(tagName, attrs = {}, children = []) {
    /** @type {any} */
    const node = {
      tagName: tagName.toUpperCase(),
      attrs: { ...attrs },
      children,
      ownerDocument: null,
      parentElement: null,
      getAttribute(name) {
        const value = node.attrs[name];
        return value == null ? null : String(value);
      },
      get id() {
        return node.attrs.id == null ? "" : String(node.attrs.id);
      },
      get textContent() {
        if (typeof node.attrs.text === "string") return node.attrs.text;
        return node.children.map((child) => child.textContent).join("");
      },
      get style() {
        return {
          display: node.attrs.display ?? "",
          visibility: node.attrs.visibility ?? "",
          opacity: node.attrs.opacity ?? "",
        };
      },
      getBoundingClientRect() {
        if (node.attrs.hidden === true) {
          return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
        }
        const width = Number(node.attrs.width ?? 120);
        const height = Number(node.attrs.height ?? 24);
        return { width, height, top: 0, left: 0, right: width, bottom: height };
      },
      querySelector(selector) {
        return node.querySelectorAll(selector)[0] ?? null;
      },
      querySelectorAll(selector) {
        const out = [];
        const visit = (current) => {
          if (matches(current, selector)) out.push(current);
          for (const child of current.children) visit(child);
        };
        for (const child of node.children) visit(child);
        return out;
      },
    };
    for (const child of children) child.parentElement = node;
    return node;
  }

  /** @type {Record<string, any>} */
  let byId = {};
  /** @type {any} */
  let body = null;

  if (fixture === "blank") {
    const root = el("div", { id: "root" });
    body = el("body", {}, [root]);
    byId = { root };
  } else {
    const email = el("input", {
      id: "steward-login-email",
      type: "email",
      name: "email",
      width: 280,
      height: 44,
    });
    const heading = el("h1", {
      text: "Sign in to Eliza",
      width: 200,
      height: 32,
    });
    const form = el("form", { width: 320, height: 200 }, [email]);
    const marker = el("div", {
      "data-testid": "login-safe-area-fill",
      width: 390,
      height: 844,
    });
    const main = el("main", { width: 360, height: 480 }, [heading, form]);
    const root = el("div", { id: "root" }, [marker, main]);
    body = el("body", { text: "Sign in to Eliza" }, [root]);
    byId = { root, "steward-login-email": email };
  }

  const doc = {
    body,
    documentElement: body,
    getElementById(id) {
      return byId[id] ?? null;
    },
    querySelector(selector) {
      if (selector.startsWith("#"))
        return this.getElementById(selector.slice(1));
      return body.querySelector(selector);
    },
    querySelectorAll(selector) {
      return body.querySelectorAll(selector);
    },
  };
  body.ownerDocument = doc;
  for (const node of Object.values(byId)) node.ownerDocument = doc;

  globalThis.document = doc;
  globalThis.getComputedStyle = (element) => ({
    display: element?.style?.display || "block",
    visibility: element?.style?.visibility || "visible",
    opacity: element?.style?.opacity || "1",
  });

  return () => {
    globalThis.document = previousDocument;
    globalThis.getComputedStyle = previousGetComputedStyle;
  };
}

describe("login surface contract", () => {
  it("rejects a silent blank renderer with bounded diagnostics", () => {
    const restore = installLoginProbeDom("blank");
    try {
      const probe = collectLoginSurfaceProbe();
      expect(probe.ok).toBe(false);
      expect(() => assertLoginSurfaceReady(probe, "desktop")).toThrow(
        /desktop \/login failed visible login contract/,
      );
      try {
        assertLoginSurfaceReady(probe, "desktop");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message.length).toBeLessThan(500);
        expect(message).toMatch(/rootChildren=0|emailVisible=false/);
        expect(message).not.toMatch(/console\.error|pageerror/);
      }
    } finally {
      restore();
    }
  });

  it("accepts a stable visible login surface (email + heading/form)", () => {
    const restore = installLoginProbeDom("valid");
    try {
      const probe = collectLoginSurfaceProbe();
      expect(probe.ok).toBe(true);
      expect(probe.emailVisible).toBe(true);
      expect(probe.headingVisible || probe.formVisible).toBe(true);
      expect(() => assertLoginSurfaceReady(probe, "mobile")).not.toThrow();
    } finally {
      restore();
    }
  });

  it("assertLoginSurfaceReady rejects incomplete probes without requiring runtime errors", () => {
    expect(() =>
      assertLoginSurfaceReady(
        {
          ok: false,
          failure: "missing-email",
          rootChildren: 1,
          emailVisible: false,
          headingVisible: true,
          formVisible: false,
          appMarker: "login-safe-area-fill",
          bodySample: "",
        },
        "desktop",
      ),
    ).toThrow(/missing-email/);
  });
});

describe("measure-anonymous-login-transfer CLI", () => {
  it("exits non-zero on invalid --settle-ms without launching Chromium", () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--settle-ms", "abc", "--url", "http://127.0.0.1:9/login"],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--settle-ms/);
    expect(result.stderr).not.toMatch(/playwright|chromium|browser/i);
    expect(result.stdout).not.toMatch(/Measuring cold/);
  });

  it("exits non-zero on invalid --timeout without launching Chromium", () => {
    const result = spawnSync(
      process.execPath,
      [
        SCRIPT_PATH,
        "--timeout",
        String(MAX_TIMER_DELAY_MS + 1),
        "--url",
        "http://127.0.0.1:9/login",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--timeout/);
    expect(result.stdout).not.toMatch(/Measuring cold/);
  });

  it("prints help and exits 0", () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, "--help"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/--settle-ms/);
    expect(result.stdout).toMatch(/--timeout/);
  });

  it("enters the CLI through a symlink for invalid and valid arguments", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "login-transfer-link-"));
    const linkedScript = path.join(directory, "measure-login.mjs");
    try {
      symlinkSync(SCRIPT_PATH, linkedScript);

      const invalid = spawnSync(
        process.execPath,
        [linkedScript, "--settle-ms", "abc"],
        { encoding: "utf8", timeout: 15_000 },
      );
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toMatch(/--settle-ms/);

      const valid = spawnSync(
        process.execPath,
        [
          linkedScript,
          "--settle-ms",
          "0",
          "--timeout",
          "1",
          "--url",
          "http://127.0.0.1:9/login",
        ],
        { encoding: "utf8", timeout: 15_000 },
      );
      expect(valid.status).not.toBe(0);
      expect(valid.stdout).toMatch(/Measuring cold \/login/);
      expect(valid.stderr).not.toMatch(/--settle-ms|--timeout/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
