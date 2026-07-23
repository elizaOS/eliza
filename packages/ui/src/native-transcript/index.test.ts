/**
 * Barrel smoke: the public `@elizaos/ui/native-transcript` surface re-exports the
 * schema constant, decoder, reducer, and renderer that shells import. Guards the
 * subpath export from silently losing a symbol.
 */

import { describe, expect, it } from "vitest";
import * as api from "./index";

describe("native-transcript public surface", () => {
  it("re-exports the contract, decoder, reducer, and renderer", () => {
    expect(api.NATIVE_TRANSCRIPT_SCHEMA).toBe("eliza.native-transcript/v1");
    expect(api.TRANSCRIPT_EVENT_TYPES).toContain("stt.partial");
    expect(typeof api.decodeTranscriptEvent).toBe("function");
    expect(typeof api.decodeTranscriptStream).toBe("function");
    expect(typeof api.applyTranscriptEvent).toBe("function");
    expect(typeof api.reduceTranscriptEvents).toBe("function");
    expect(typeof api.toViewModel).toBe("function");
    expect(typeof api.TranscriptEventView).toBe("function");
    expect(typeof api.useTranscriptEvents).toBe("function");
  });
});
