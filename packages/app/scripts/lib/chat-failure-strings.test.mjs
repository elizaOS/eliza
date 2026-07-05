/**
 * Parity guard for the mobile chat-reply failure vocabulary and the iOS
 * XCUITest verifier that consumes it.
 *
 * The tests pin the historical smoke classifier behaviour, prove the checked-in
 * Swift and runtime TypeScript artifacts are generated from the shared list, and
 * guard the #13687 anti-false-green contract: the device verifier accepts only a
 * marker echo while classifying failure-string, not-ready, and unrecognized
 * replies distinctly.
 */
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
  renderTypeScriptFailureStrings,
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
const appCoreTsArtifactPath = path.resolve(
  here,
  "../../../app-core/src/platform/chat-failure-strings.generated.ts",
);
const iosRuntimeBridgePath = path.resolve(
  here,
  "../../../app-core/src/platform/ios-runtime-bridge.ts",
);
const appMainPath = path.resolve(here, "../../src/main.tsx");

// The exact hand-authored classifier sources that lived inline in
// mobile-local-chat-smoke.mjs before #13687. Android includes the old regex plus
// its old inline think-tag sidecar. Pinned here so a fragment reorder/edit that
// changes matching behaviour is caught, not silently accepted.
const HISTORICAL_IOS_SOURCE =
  "something went wrong|backend is not running|local backend is not running|no local backend|no local model|no model registered|no provider|connect a provider|waiting for the model download|timed out|<think\\b|<\\/think>|\\/?\\bno_think\\b";
const HISTORICAL_ANDROID_SOURCE =
  "something went wrong|no local gguf|no local model|no model registered|no provider|connect a provider|device_disconnected|device_timeout|timed out|chat generation failed|waiting for the model download|set chat routing|progress:\\s*0%|<think\\b|<\\/think>|\\/?\\bno_think\\b";

describe("chat-failure-strings single source of truth (#13687)", () => {
  it("reproduces the historical iOS/Android failure classifiers byte-for-byte", () => {
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
    for (const fragment of THINK_TAG_FAILURE_FRAGMENTS) {
      expect(IOS_FAILURE_FRAGMENTS).toContain(fragment);
      expect(ANDROID_FAILURE_FRAGMENTS).toContain(fragment);
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

  it("committed app-core TypeScript artifact byte-matches the generator", () => {
    const committed = fs.readFileSync(appCoreTsArtifactPath, "utf8");
    expect(committed).toBe(renderTypeScriptFailureStrings());
  });

  it("browser/runtime smoke checks consume the generated TypeScript artifact", () => {
    const bridge = fs.readFileSync(iosRuntimeBridgePath, "utf8");
    const appMain = fs.readFileSync(appMainPath, "utf8");
    expect(bridge).toContain('from "./chat-failure-strings.generated"');
    expect(appMain).toContain("IOS_FULL_BUN_SMOKE_FAILURE_RE");
    expect(bridge).not.toContain("backend is not running|local backend");
    expect(appMain).not.toContain("something went wrong|<think");
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
    expect(bootCapture).not.toContain("Say hello in exactly three words.");
    expect(bootCapture).toContain('let replyMarker = "IOS_CHAT_OK"');
    expect(bootCapture).toContain(
      '"Start your reply with exactly \\(replyMarker), then say hello in one short sentence."',
    );
    expect(bootCapture).toContain("marker-hit");
    expect(bootCapture).toContain("failure-string:");
    expect(bootCapture).toContain("not-ready");
    expect(bootCapture).toContain("reply-not-ready");
    expect(bootCapture).toContain("unrecognized-text");
    expect(bootCapture).toContain("reply-unrecognized-text");

    const markerBranch = bootCapture.match(
      /if let c = candidate,\s*c\.localizedCaseInsensitiveContains\(replyMarker\)\s*\{(?<body>[\s\S]*?)\n {12}\}/,
    );
    expect(markerBranch?.groups?.body).toContain("reply = c");

    const unrecognizedBranch = bootCapture.match(
      /if let c = candidate, !looksNotReady\(c\) \{(?<body>[\s\S]*?)\n {12}\}/,
    );
    expect(unrecognizedBranch?.groups?.body).toContain(
      "unrecognizedObservation = c",
    );
    expect(unrecognizedBranch?.groups?.body).not.toContain("reply = c");
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
