/**
 * Deterministic `node --test` coverage for the assistant-role/IME/assist-key
 * verification parsers (#13581). Fixtures are real-shaped `adb`/`dumpsys`/`cmd`/
 * `logcat` output slices, not mocks of the parser — the parsers are pure
 * string→decision functions, so this suite proves the string handling that
 * regresses silently off-device (a garbled scrape reading as "absent"), covering
 * the present, absent, short-vs-full component form, and empty/garbage cases.
 *
 * Run: `node --test packages/app/scripts/lib/android-assistant-verify-lib.test.mjs`
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APP_PACKAGE,
  ASSISTANT_IME_COMPONENT,
  ASSISTANT_VIS_COMPONENT,
  assertDeepLinkLanded,
  classifyImeAsrOutcome,
  DEEP_LINK_SOURCES,
  detectSurfaceInvocation,
  LOG_TAGS,
  normalizeComponent,
  parseAssistantSurfaces,
  parseDefaultInputMethod,
  parseEnabledImes,
  parseRoleHolders,
  parseServiceRegistration,
  parseVoiceInteractionService,
  ROLE_ASSISTANT,
  summarizeLaneVerdict,
} from "./android-assistant-verify-lib.mjs";

test("normalizeComponent canonicalizes short and full forms equally", () => {
  const full = "ai.elizaos.app/ai.elizaos.app.ElizaVoiceInteractionService";
  assert.equal(
    normalizeComponent("ai.elizaos.app/.ElizaVoiceInteractionService"),
    full,
  );
  assert.equal(normalizeComponent(full), full);
  assert.throws(() => normalizeComponent("not a component"));
  assert.throws(() => normalizeComponent(""));
  assert.throws(() => normalizeComponent(undefined));
});

test("parseServiceRegistration finds the VIS in a real dumpsys package slice (short form)", () => {
  const dump = `
  Service Resolver Table:
    Non-Data Actions:
      android.service.voice.VoiceInteractionService:
        4f2a1c ai.elizaos.app/.ElizaVoiceInteractionService filter 88b
          Action: "android.service.voice.VoiceInteractionService"
`;
  const result = parseServiceRegistration(
    dump,
    ASSISTANT_VIS_COMPONENT,
    "android.service.voice.VoiceInteractionService",
  );
  assert.equal(result.registered, true);
  assert.equal(result.actionSeen, true);
});

test("parseServiceRegistration reports absence when the component is missing", () => {
  const dump = `Service Resolver Table:\n  android.view.InputMethod:\n    ce01 com.other.keyboard/.SomeIme filter aa\n`;
  const result = parseServiceRegistration(
    dump,
    ASSISTANT_IME_COMPONENT,
    "android.view.InputMethod",
  );
  assert.equal(result.registered, false);
});

test("parseAssistantSurfaces detects every declared surface, and reports the missing one", () => {
  const full = `
      ai.elizaos.app/.ElizaVoiceInteractionService
      ai.elizaos.app/.ElizaVoiceInteractionSessionService
      ai.elizaos.app/.ElizaRecognitionService
      ai.elizaos.app/.ElizaVoiceInputMethodService
      ai.elizaos.app/.ElizaAssistActivity
`;
  const ok = parseAssistantSurfaces(full);
  assert.equal(ok.allPresent, true);
  assert.deepEqual(ok.missing, []);

  const missingIme = full.replace(
    "ai.elizaos.app/.ElizaVoiceInputMethodService\n",
    "",
  );
  const partial = parseAssistantSurfaces(missingIme);
  assert.equal(partial.allPresent, false);
  assert.deepEqual(partial.missing, ["inputMethodService"]);
  assert.equal(partial.present.voiceInteractionService, true);
});

test("parseAssistantSurfaces treats a renamed VIS as ABSENT (regression canary)", () => {
  // A renamed component must not prefix-match the expected id — this is exactly
  // the regression the lane exists to catch (rename the VIS → it stops
  // registering under its expected component id).
  const renamed = `
      ai.elizaos.app/.ElizaVoiceInteractionServiceRENAMED
      ai.elizaos.app/.ElizaVoiceInteractionSessionService
      ai.elizaos.app/.ElizaRecognitionService
      ai.elizaos.app/.ElizaVoiceInputMethodService
      ai.elizaos.app/.ElizaAssistActivity
`;
  const parsed = parseAssistantSurfaces(renamed);
  assert.equal(parsed.allPresent, false);
  assert.deepEqual(parsed.missing, ["voiceInteractionService"]);
  // The session service must still match despite sharing a prefix with the VIS.
  assert.equal(parsed.present.voiceInteractionSessionService, true);
});

test("parseRoleHolders recognizes the held ROLE_ASSISTANT and rejects noise lines", () => {
  const held = parseRoleHolders("ai.elizaos.app\n");
  assert.equal(held.heldByExpected, true);
  assert.deepEqual(held.holders, [APP_PACKAGE]);

  const none = parseRoleHolders("");
  assert.equal(none.heldByExpected, false);

  const other = parseRoleHolders("com.google.android.googlequicksearchbox\n");
  assert.equal(other.heldByExpected, false);

  const errorLine = parseRoleHolders(
    "Exception occurred while executing 'holders'",
  );
  assert.deepEqual(errorLine.holders, []);
  assert.equal(errorLine.heldByExpected, false);

  assert.equal(ROLE_ASSISTANT, "android.app.role.ASSISTANT");
});

test("parseVoiceInteractionService reads dumpsys ComponentInfo and flattened settings forms", () => {
  const dumpsys =
    "  mCurInteractor=ComponentInfo{ai.elizaos.app/ai.elizaos.app.ElizaVoiceInteractionService}";
  const fromDump = parseVoiceInteractionService(dumpsys);
  assert.equal(fromDump.isEliza, true);

  const settings =
    "ai.elizaos.app/ai.elizaos.app.ElizaVoiceInteractionService\n";
  assert.equal(parseVoiceInteractionService(settings).isEliza, true);

  const other =
    "  mCurInteractor=ComponentInfo{com.google.android.googlequicksearchbox/com.google.VoiceInteractionService}";
  assert.equal(parseVoiceInteractionService(other).isEliza, false);

  assert.equal(parseVoiceInteractionService("").selected, null);
});

test("parseDefaultInputMethod distinguishes selected Eliza IME from another keyboard and null", () => {
  const eliza = parseDefaultInputMethod(
    "ai.elizaos.app/.ElizaVoiceInputMethodService\n",
  );
  assert.equal(eliza.isEliza, true);

  const other = parseDefaultInputMethod(
    "com.google.android.inputmethod.latin/.LatinIME",
  );
  assert.equal(other.isEliza, false);
  assert.equal(
    other.selected,
    "com.google.android.inputmethod.latin/.LatinIME",
  );

  assert.equal(parseDefaultInputMethod("null").selected, null);
  assert.equal(parseDefaultInputMethod("").selected, null);
});

test("parseEnabledImes finds the Eliza IME in an `ime list -s` set", () => {
  const list = [
    "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME",
    "ai.elizaos.app/.ElizaVoiceInputMethodService",
  ].join("\n");
  const parsed = parseEnabledImes(list);
  assert.equal(parsed.elizaEnabled, true);
  assert.equal(parsed.enabled.length, 2);

  const without = parseEnabledImes(
    "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME",
  );
  assert.equal(without.elizaEnabled, false);
});

test("detectSurfaceInvocation catches the IME class tag, bracket marker, and deep-link source", () => {
  const byTag = detectSurfaceInvocation(
    "07-04 12:00:01.234  4210  4210 I ElizaVoiceIme: [ElizaVoiceInputMethodService] opening Eliza",
    {
      tag: LOG_TAGS.ime,
      bracket: "ElizaVoiceInputMethodService",
      source: DEEP_LINK_SOURCES.ime,
    },
  );
  assert.equal(byTag.tagHit, true);
  assert.equal(byTag.bracketHit, true);
  assert.equal(byTag.detected, true);

  const bySource = detectSurfaceInvocation(
    "ActivityTaskManager: START u0 {act=android.intent.action.VIEW dat=elizaos://voice?source=android-ime...}",
    { source: DEEP_LINK_SOURCES.ime },
  );
  assert.equal(bySource.sourceHit, true);
  assert.equal(bySource.detected, true);

  const miss = detectSurfaceInvocation("nothing relevant here", {
    tag: LOG_TAGS.vis,
    source: DEEP_LINK_SOURCES.assistantSession,
  });
  assert.equal(miss.detected, false);
});

test("assertDeepLinkLanded requires BOTH resumed MainActivity and the expected source tag", () => {
  const activityDump =
    "  ResumedActivity: ActivityRecord{a1b2 u0 ai.elizaos.app/.MainActivity t42}";
  const logcat =
    "ActivityTaskManager: START u0 {dat=elizaos://voice?source=android-assistant-session&voice=1 cmp=ai.elizaos.app/.MainActivity}";
  const landed = assertDeepLinkLanded(
    activityDump,
    logcat,
    DEEP_LINK_SOURCES.assistantSession,
  );
  assert.equal(landed.landed, true);
  assert.equal(landed.mainActivityResumed, true);
  assert.equal(landed.sourceSeen, true);

  // Foreground MainActivity but no matching source tag → NOT landed (guards
  // against a coincidental unrelated foreground pass).
  const wrongSource = assertDeepLinkLanded(
    activityDump,
    "unrelated log",
    DEEP_LINK_SOURCES.ime,
  );
  assert.equal(wrongSource.mainActivityResumed, true);
  assert.equal(wrongSource.landed, false);

  // Source present but MainActivity not resumed → NOT landed.
  const notResumed = assertDeepLinkLanded(
    "ResumedActivity: com.other/.Home",
    logcat,
    DEEP_LINK_SOURCES.assistantSession,
  );
  assert.equal(notResumed.landed, false);
});

test("classifyImeAsrOutcome distinguishes committed / engineOff / modelNotReady / error", () => {
  assert.equal(
    classifyImeAsrOutcome(
      "ElizaVoiceIme: [ElizaVoiceInputMethodService] transcript committed (14 chars)",
    ),
    "committed",
  );
  assert.equal(
    classifyImeAsrOutcome(
      "ElizaVoiceIme: [ElizaVoiceInputMethodService] ASR loopback unreachable: Connection refused",
    ),
    "engineOff",
  );
  assert.equal(
    classifyImeAsrOutcome(
      "ElizaVoiceIme: [ElizaVoiceInputMethodService] ASR responded 503",
    ),
    "modelNotReady",
  );
  assert.equal(
    classifyImeAsrOutcome(
      "ElizaVoiceIme: [ElizaVoiceInputMethodService] transcription error",
    ),
    "error",
  );
  assert.equal(classifyImeAsrOutcome("nothing"), "unknown");
});

test("summarizeLaneVerdict passes only when every required surface checks out", () => {
  const green = {
    surfacesRegistered: true,
    roleHeld: true,
    imeSelected: true,
    assistLanded: true,
    imeLanded: true,
    asrOutcome: "committed",
  };
  assert.equal(summarizeLaneVerdict(green, true).pass, true);

  // Engine off is acceptable when the agent is NOT required...
  assert.equal(
    summarizeLaneVerdict({ ...green, asrOutcome: "engineOff" }, false).pass,
    true,
  );
  // ...but a hard failure when the agent IS required (never green-by-skip).
  const requiredButOff = summarizeLaneVerdict(
    { ...green, asrOutcome: "engineOff" },
    true,
  );
  assert.equal(requiredButOff.pass, false);
  assert.match(requiredButOff.failures.join(" "), /ENGINE_OFF/);

  const roleMissing = summarizeLaneVerdict(
    { ...green, roleHeld: false },
    false,
  );
  assert.equal(roleMissing.pass, false);
  assert.match(roleMissing.failures.join(" "), /assistant role/);

  const notRegistered = summarizeLaneVerdict(
    { ...green, surfacesRegistered: false },
    false,
  );
  assert.equal(notRegistered.pass, false);
});

test("exported component ids match the native manifest components", () => {
  assert.equal(
    ASSISTANT_VIS_COMPONENT,
    "ai.elizaos.app/.ElizaVoiceInteractionService",
  );
  assert.equal(
    ASSISTANT_IME_COMPONENT,
    "ai.elizaos.app/.ElizaVoiceInputMethodService",
  );
});
