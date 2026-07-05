// #13687: the mobile chat-reply FAILURE vocabulary must be single-sourced. The
// mobile-local-chat-smoke.mjs regexes and the on-device iOS XCUITest reply
// verifier (via the generated Swift artifact) must classify the SAME error
// renders as failures — historically the two copies drifted and the Swift
// heuristic accepted an error render (e.g. the error-boundary "Something went
// wrong" heading) as a "genuine model reply".
//
// This parity test proves:
//   1. the derived regexes reproduce the historical hand-authored source exactly
//      (behaviour-preserving), and stay in lockstep with the fragment lists;
//   2. the committed Swift artifact byte-matches the generator output (so a hand
//      edit / stale regen is caught in CI, not on device);
//   3. representative error renders are classified as failures and a real reply
//      is not — the core anti-false-green property of the whole loop.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ANDROID_FAILURE_FRAGMENTS,
  ANDROID_FULL_TURN_FAILURE_RE,
  buildFailureRegExp,
  IOS_FAILURE_FRAGMENTS,
  IOS_FULL_BUN_SMOKE_FAILURE_RE,
  renderSwiftFailureStrings,
  THINK_TAG_FAILURE_FRAGMENTS,
} from "./chat-failure-strings.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const swiftArtifactPath = path.resolve(
  here,
  "../../../app-core/platforms/ios/App/AppUITests/ChatFailureStrings.generated.swift",
);
const bootCaptureUITestsPath = path.resolve(
  here,
  "../../../app-core/platforms/ios/App/AppUITests/BootCaptureUITests.swift",
);

// The exact hand-authored source that lived inline in mobile-local-chat-smoke.mjs
// before #13687. Pinned here so a fragment reorder/edit that changes matching
// behaviour is caught, not silently accepted.
const HISTORICAL_IOS_SOURCE =
  "something went wrong|backend is not running|local backend is not running|no local backend|no local model|no model registered|no provider|connect a provider|waiting for the model download|timed out|<think\\b|<\\/think>|\\/?\\bno_think\\b";
const HISTORICAL_ANDROID_SOURCE =
  "something went wrong|no local gguf|no local model|no model registered|no provider|connect a provider|device_disconnected|device_timeout|timed out|chat generation failed|waiting for the model download|set chat routing|progress:\\s*0%";

describe("chat-failure-strings single source of truth (#13687)", () => {
  it("reproduces the historical iOS/Android failure regexes byte-for-byte", () => {
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.source).toBe(HISTORICAL_IOS_SOURCE);
    expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.flags).toBe("i");
    expect(ANDROID_FULL_TURN_FAILURE_RE.source).toBe(HISTORICAL_ANDROID_SOURCE);
    expect(ANDROID_FULL_TURN_FAILURE_RE.flags).toBe("i");
  });

  it("derives each regex from its fragment list (join is the only transform)", () => {
    expect(buildFailureRegExp(IOS_FAILURE_FRAGMENTS).source).toBe(
      IOS_FULL_BUN_SMOKE_FAILURE_RE.source,
    );
    expect(buildFailureRegExp(ANDROID_FAILURE_FRAGMENTS).source).toBe(
      ANDROID_FULL_TURN_FAILURE_RE.source,
    );
  });

  it("shares the think-tag leakage fragments across surfaces", () => {
    // The iOS list carries the shared think-tag group; Android checks it inline.
    for (const fragment of THINK_TAG_FAILURE_FRAGMENTS) {
      expect(IOS_FAILURE_FRAGMENTS).toContain(fragment);
    }
    expect(THINK_TAG_FAILURE_FRAGMENTS.length).toBeGreaterThan(0);
  });

  it("rejects an empty fragment list (fail-closed builder)", () => {
    expect(() => buildFailureRegExp([])).toThrow(/non-empty/);
    expect(() => buildFailureRegExp(null)).toThrow(/non-empty/);
  });

  it("committed Swift artifact byte-matches the generator (no drift / stale regen)", () => {
    const committed = fs.readFileSync(swiftArtifactPath, "utf8");
    expect(committed).toBe(renderSwiftFailureStrings());
  });

  it("the XCUITest reply verifier consumes the shared vocabulary (not dead code)", () => {
    // Guards against the artifact drifting back into an unreferenced file while
    // BootCaptureUITests keeps its old "any new text is a reply" heuristic
    // (the #13687 false-green). The Swift verifier must reference the generated
    // enum so an error render is classified as a failure, not accepted.
    const bootCapture = fs.readFileSync(bootCaptureUITestsPath, "utf8");
    expect(bootCapture).toContain("ChatFailureStrings.ios");
  });

  it("the XCUITest verifier only accepts marker-echo replies and classifies every verdict", () => {
    const bootCapture = fs.readFileSync(bootCaptureUITestsPath, "utf8");
    expect(bootCapture).toContain("IOS_CHAT_OK");
    expect(bootCapture).toContain("marker-hit");
    expect(bootCapture).toContain("failure-string:");
    expect(bootCapture).toContain("unrecognized-text");
    expect(bootCapture).toContain("reply-unrecognized-text");
  });

  it("the Swift artifact enumerates the same fragments as the JS lists", () => {
    const swift = renderSwiftFailureStrings();
    for (const fragment of IOS_FAILURE_FRAGMENTS) {
      expect(swift).toContain(JSON.stringify(fragment));
    }
    for (const fragment of ANDROID_FAILURE_FRAGMENTS) {
      expect(swift).toContain(JSON.stringify(fragment));
    }
  });

  describe("classifies error renders as failures, real replies as pass", () => {
    // The exact heading the ErrorBoundary renders
    // (packages/ui/src/components/ui/error-boundary.tsx) — the #13687 false-green.
    it("iOS: error-boundary heading is a failure", () => {
      expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.test("Something went wrong")).toBe(
        true,
      );
    });

    it("iOS: backend-down + think-tag leak are failures", () => {
      expect(
        IOS_FULL_BUN_SMOKE_FAILURE_RE.test("Local backend is not running"),
      ).toBe(true);
      expect(
        IOS_FULL_BUN_SMOKE_FAILURE_RE.test("<think>chain of thought</think>"),
      ).toBe(true);
    });

    it("iOS: the genuine expected reply is NOT a failure", () => {
      expect(IOS_FULL_BUN_SMOKE_FAILURE_RE.test("ios smoke model works")).toBe(
        false,
      );
    });

    it("Android: device disconnect / chat-generation-failed are failures", () => {
      expect(ANDROID_FULL_TURN_FAILURE_RE.test("device_disconnected")).toBe(
        true,
      );
      expect(ANDROID_FULL_TURN_FAILURE_RE.test("chat generation failed")).toBe(
        true,
      );
      expect(ANDROID_FULL_TURN_FAILURE_RE.test("progress: 0%")).toBe(true);
    });

    it("Android: the genuine expected reply is NOT a failure", () => {
      expect(
        ANDROID_FULL_TURN_FAILURE_RE.test("android smoke model works"),
      ).toBe(false);
    });
  });
});
