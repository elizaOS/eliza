import { Buffer } from "node:buffer";
import {
  ReadableStream,
  TransformStream,
  WritableStream,
} from "node:stream/web";
import { TextDecoder } from "node:util";

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
