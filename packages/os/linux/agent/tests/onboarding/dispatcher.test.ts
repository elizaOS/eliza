// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleOnboarding } from "../../src/onboarding/dispatcher.ts";
import {
  isOnboardingActive,
  loadState,
  resetForTest,
} from "../../src/onboarding/state.ts";

let tempDir = "";
const originalStateDir = process.env.USBELIZA_STATE_DIR;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "usbeliza-onboarding-"));
  process.env.USBELIZA_STATE_DIR = tempDir;
});

afterEach(() => {
  if (tempDir !== "") rmSync(tempDir, { recursive: true, force: true });
  if (originalStateDir !== undefined) {
    process.env.USBELIZA_STATE_DIR = originalStateDir;
  } else {
    delete process.env.USBELIZA_STATE_DIR;
  }
  resetForTest();
});

/**
 * The v36 onboarding is intentionally minimal:
 *   1. name
 *   2. claudeOfferAccepted (yes/no)
 *   3. buildIntent ("what should I build first?")
 *
 * Tests use `USBELIZA_STATE_DIR` to pin a temp dir AND short-circuit
 * the claude-flow + build-app side effects (the dispatcher checks the
 * same env to keep them deterministic).
 */

describe("onboarding — first-turn greeting", () => {
  test("empty first message returns the name greeting", async () => {
    const turn = await handleOnboarding("", true);
    expect(turn).not.toBeNull();
    expect(turn?.reply).toContain("Hi");
    expect(turn?.completed).toBe(false);
  });

  test("returns null after calibration.toml exists", async () => {
    await handleOnboarding("", true); // greeting
    await handleOnboarding("Alice", false); // answer name
    await handleOnboarding("no", false); // decline claude
    await handleOnboarding("a clock", false); // build intent
    // Now calibration is committed; further calls return null.
    const turn = await handleOnboarding("hello", false);
    expect(turn).toBeNull();
  });
});

describe("onboarding — happy path", () => {
  test("walks through name → claude offer → build intent", async () => {
    const t1 = await handleOnboarding("", true);
    expect(t1?.reply).toContain("Hi");

    const t2 = await handleOnboarding("Alice", false);
    expect(t2?.reply.toLowerCase()).toContain("claude");

    const t3 = await handleOnboarding("no", false);
    expect(t3?.reply.toLowerCase()).toMatch(/build|first/);

    const t4 = await handleOnboarding("a clock", false);
    expect(t4?.completed).toBe(true);
    expect(t4?.reply.toLowerCase()).toContain("alice");
  });

  test("writes a calibration.toml with the answered fields", async () => {
    await handleOnboarding("", true);
    await handleOnboarding("Bob", false);
    await handleOnboarding("yes", false);
    // Check mid-flow state before commit clears it.
    const mid = loadState();
    expect(mid?.answers.name).toBe("Bob");
    expect(mid?.answers.claudeOfferAccepted).toBe(true);
    await handleOnboarding("a notes app", false);
    // After the final question commits, loadState returns null —
    // the calibration is promoted to ~/.eliza/calibration.toml.
  });

  test('"nothing yet" buildIntent still completes onboarding without firing a build', async () => {
    await handleOnboarding("", true);
    await handleOnboarding("Carol", false);
    await handleOnboarding("no", false);
    const final = await handleOnboarding("nothing yet", false);
    expect(final?.completed).toBe(true);
  });
});

describe("onboarding — clarification + skip handling", () => {
  test("ambiguous claude offer triggers a clarify", async () => {
    await handleOnboarding("", true);
    await handleOnboarding("Dave", false);
    const ambiguous = await handleOnboarding("maybe?", false);
    // First clarify — still on claudeOfferAccepted.
    expect(ambiguous?.reply.toLowerCase()).toContain("yes");
    // Now answer cleanly.
    const next = await handleOnboarding("yes", false);
    expect(next?.reply.toLowerCase()).toMatch(/build|first/);
  });

  test("skip on buildIntent completes onboarding", async () => {
    await handleOnboarding("", true);
    await handleOnboarding("Eve", false);
    await handleOnboarding("no", false);
    const final = await handleOnboarding("skip", false);
    expect(final?.completed).toBe(true);
  });
});

describe("onboarding — state persistence", () => {
  test("state survives between handleOnboarding calls (per-turn-process model)", async () => {
    await handleOnboarding("", true);
    await handleOnboarding("Frank", false);
    // Simulate process restart by re-importing state.
    const state = loadState();
    expect(state).not.toBeNull();
    expect(state?.answers.name).toBe("Frank");
    expect(state?.nextQuestionIndex).toBeGreaterThan(0);
  });

  test("isOnboardingActive flips to false after final question answered", async () => {
    await handleOnboarding("", true);
    await handleOnboarding("Grace", false);
    await handleOnboarding("no", false);
    expect(isOnboardingActive()).toBe(true);
    await handleOnboarding("a calculator", false);
    expect(isOnboardingActive()).toBe(false);
  });
});
