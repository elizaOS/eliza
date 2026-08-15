/**
 * Global vitest setup: web-stream and Buffer polyfills plus the shared jsdom
 * environment fixups the suite relies on.
 */
import { Buffer } from "node:buffer";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ReadableStream,
  TransformStream,
  WritableStream,
} from "node:stream/web";
import { TextDecoder } from "node:util";
import { afterEach, beforeEach, expect } from "vitest";
// @ts-expect-error — plain-JS sibling that owns the shared message fingerprint.
import { normalizeConsoleMessage } from "./scripts/console-warning-baseline.mjs";

const nativeConsoleWarn = console.warn.bind(console);
const nativeConsoleError = console.error.bind(console);
let unexpectedConsoleMessages: string[] = [];
const consoleBaselinePath = resolve(
  process.cwd(),
  "test/console-warning-baseline.json",
);
const consoleBaseline = JSON.parse(
  readFileSync(consoleBaselinePath, "utf8"),
) as Record<string, number>;
const consoleBaselineCapture = process.env.UPDATE_TEST_CONSOLE_BASELINE;

function stringifyConsoleArgument(argument: unknown): string {
  if (argument instanceof Error) return argument.stack ?? argument.message;
  if (typeof argument === "string") return argument;
  try {
    return JSON.stringify(argument);
  } catch {
    return String(argument);
  }
}

function recordUnexpectedConsoleMessage(
  level: "warn" | "error",
  arguments_: unknown[],
): void {
  // Structured application logs are already asserted at the logger boundary;
  // this guard targets raw browser-console output and React/jsdom warnings.
  if (
    typeof arguments_[0] === "string" &&
    arguments_[0].startsWith("%c") &&
    /\b(?:Info|Warn|Error)\b/u.test(arguments_[0])
  ) {
    (level === "warn" ? nativeConsoleWarn : nativeConsoleError)(...arguments_);
    return;
  }
  // Fingerprint without color so the baseline matches in either color mode;
  // the console re-emission below still carries the original bytes.
  const message = normalizeConsoleMessage(
    arguments_.map(stringifyConsoleArgument).join(" "),
  );
  unexpectedConsoleMessages.push(`${level}: ${message}`);
  (level === "warn" ? nativeConsoleWarn : nativeConsoleError)(...arguments_);
}

/**
 * Unexpected warnings and errors fail the owning test. Tests that intentionally
 * exercise a logging boundary must spy on that console method and assert the
 * expected call, which makes the exception local and reviewable.
 */
beforeEach(() => {
  unexpectedConsoleMessages = [];
  console.warn = (...arguments_: unknown[]) =>
    recordUnexpectedConsoleMessage("warn", arguments_);
  console.error = (...arguments_: unknown[]) =>
    recordUnexpectedConsoleMessage("error", arguments_);
});

afterEach(() => {
  const messages = unexpectedConsoleMessages;
  unexpectedConsoleMessages = [];
  console.warn = nativeConsoleWarn;
  console.error = nativeConsoleError;
  const testName = expect.getState().currentTestName ?? "<unknown test>";
  if (consoleBaselineCapture && messages.length > 0) {
    appendFileSync(
      `${consoleBaselineCapture}.${process.pid}.jsonl`,
      `${JSON.stringify({ testName, messages })}\n`,
    );
    return;
  }
  const observed: Record<string, number> = {};
  for (const message of messages) {
    observed[message] = (observed[message] ?? 0) + 1;
  }
  const regressions = Object.entries(observed).filter(
    ([message, count]) => count > (consoleBaseline[message] ?? 0),
  );
  if (regressions.length > 0) {
    throw new Error(
      `Unexpected console output:\n${regressions
        .map(
          ([message, count]) =>
            `- ${message}${count > 1 ? ` (x${count})` : ""}`,
        )
        .join("\n")}`,
    );
  }
});

// Deterministic timezone for any test that renders a localized date/number.
// Set (overridably) so `toLocale*` / `Intl` output is identical on every
// machine and in CI — the unit-test counterpart to the browser determinism
// shim used by the story gate. Components that read the clock during render
// are caught separately by `audit:ui-determinism`; tests that need a frozen
// clock opt in via `test/determinism.ts`.
if (!process.env.TZ) {
  process.env.TZ = "UTC";
}

// Polyfill Web Streams API for jsdom (eventsource-parser, AI SDK, etc. use
// TransformStream at module-load time; jsdom does not include it).
if (typeof globalThis.TransformStream === "undefined") {
  Object.assign(globalThis, {
    TransformStream,
    ReadableStream,
    WritableStream,
  });
}

// jsdom does not implement Element.prototype.scrollTo / scrollIntoView, so any
// component that scrolls a ref into view during render (e.g. a chat transcript
// auto-scrolling to the latest message) throws `el.scrollTo is not a function`
// under jsdom. Assign no-op shims only when absent — never overwrite a real
// implementation, and only when `Element` exists (the jsdom-environment tests).
if (typeof Element !== "undefined") {
  if (typeof Element.prototype.scrollTo !== "function") {
    Element.prototype.scrollTo = () => {};
  }
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }
}

// jsdom has no layout observer. Components backed by React Flow and Radix
// still install one during effects, so provide the inert browser contract for
// tests that do not explicitly drive resize callbacks.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

// Real browsers stamp events on the same monotonic clock `performance.now()`
// reads (a DOMHighResTimeStamp relative to timeOrigin); jsdom stamps them with
// epoch wall-clock milliseconds from its own internal clock instead. Gesture
// code measures velocity from `event.timeStamp` (use-pull-gesture's eventTime
// prefers it over a handler-dispatch `performance.now()`, which real devices
// can delay), so under unbridged jsdom a test cannot slow a drag down by
// mocking `performance.now` — the epoch stamps make every synchronous pointer
// sequence read as a millisecond-long flick. Bridge the clocks: an Event's
// timeStamp is captured from `performance.now()` (mocked or real) on first
// read — which for dispatched events is inside the handler, i.e. dispatch
// time — then memoized so one event keeps one stable timestamp. A clock
// mocked to exactly 0 maps to the smallest positive double: react-dom's
// synthetic-event layer replaces a falsy native timeStamp with the epoch
// `Date.now()` (`event.timeStamp || Date.now()`), which would re-poison the
// bridged clock; the subnormal is truthy yet arithmetically identical to 0.
if (typeof Event !== "undefined") {
  const eventTimeStamps = new WeakMap<Event, number>();
  Object.defineProperty(Event.prototype, "timeStamp", {
    configurable: true,
    get(this: Event): number {
      let stamp = eventTimeStamps.get(this);
      if (stamp === undefined) {
        stamp = performance.now() || Number.MIN_VALUE;
        eventTimeStamps.set(this, stamp);
      }
      return stamp;
    },
  });
}

// Node ≥25 ships a Web Storage `localStorage`/`sessionStorage` global that is
// non-functional without `--localstorage-file` (its methods are missing) and
// SHADOWS jsdom's Storage — even `window.localStorage` resolves to it here, so
// every jsdom test touching storage throws `localStorage.getItem is not a
// function` on hosts running Node ≥25 (CI's Node 24 gates the global behind a
// flag and is unaffected). Install a real in-memory Storage on both access
// paths, only when the present one is broken — never overwrite a working one.
function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
}

if (typeof window !== "undefined") {
  for (const name of ["localStorage", "sessionStorage"] as const) {
    const existing = (globalThis as Record<string, unknown>)[name] as
      | Storage
      | undefined;
    if (existing && typeof existing.getItem === "function") continue;
    const memory = createMemoryStorage();
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: memory,
    });
    Object.defineProperty(window, name, {
      configurable: true,
      writable: true,
      value: memory,
    });
  }
}

// @testing-library/react's act() checks this flag to decide whether to use
// synchronous flushing. It must be set before any test code runs so that
// React renders triggered inside act() complete synchronously in jsdom.
(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT =
  true;

class VitestTextEncoder {
  encode(input = ""): Uint8Array {
    return new Uint8Array(Buffer.from(input));
  }

  encodeInto(
    input: string,
    destination: Uint8Array,
  ): { read: number; written: number } {
    const encoded = this.encode(input);
    const written = Math.min(encoded.byteLength, destination.byteLength);
    destination.set(encoded.subarray(0, written));
    return { read: written, written };
  }
}

Object.defineProperty(globalThis, "TextEncoder", {
  configurable: true,
  writable: true,
  value: VitestTextEncoder,
});

Object.defineProperty(globalThis, "TextDecoder", {
  configurable: true,
  writable: true,
  value: TextDecoder,
});
