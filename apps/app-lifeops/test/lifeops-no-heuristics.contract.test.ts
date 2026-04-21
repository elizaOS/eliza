import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("LifeOps no-heuristics architecture contracts", () => {
  it("keeps LIFE operation routing on the extractor path", async () => {
    const source = await readRepoFile("eliza/apps/app-lifeops/src/actions/life.ts");
    expect(source).not.toContain("export function classifyIntent");
    expect(source).not.toContain("classifyIntent(intent)");
    expect(source).not.toContain("getValidationKeywordTerms");
    expect(source).not.toContain("textIncludesKeywordTerm");
  });

  it("keeps INBOX subaction selection off keyword term banks", async () => {
    const source = await readRepoFile("eliza/apps/app-lifeops/src/actions/inbox.ts");
    expect(source).not.toContain("const TRIAGE_TERMS");
    expect(source).not.toContain("const DIGEST_TERMS");
    expect(source).not.toContain("const RESPOND_TERMS");
    expect(source).not.toContain("applyTriageRules");
    expect(source).not.toContain("looksLikeInboxConfirmation");
    expect(source).toContain("resolveSubactionPlan");
  });

  it("keeps inbox approval safety on model reflection instead of phrase lists", async () => {
    const source = await readRepoFile(
      "eliza/apps/app-lifeops/src/inbox/reflection.ts",
    );
    expect(source).not.toContain("CONFIRMATION_PATTERN");
    expect(source).not.toContain("REJECTION_PATTERN");
    expect(source).not.toContain("deterministic safety pre-check");
    expect(source).toContain("parseReflectionObject");
  });

  it("keeps inbox triage on explicit LLM classification failure handling", async () => {
    const source = await readRepoFile(
      "eliza/apps/app-lifeops/src/inbox/triage-classifier.ts",
    );
    expect(source).not.toContain('pattern.split(":")');
    expect(source).not.toContain("defaulting to notify");
    expect(source).toContain("InboxTriageClassificationError");
  });

  it("keeps cross-channel send execution on the dispatcher registry", async () => {
    const source = await readRepoFile(
      "eliza/apps/app-lifeops/src/actions/cross-channel-send.ts",
    );
    expect(source).not.toContain("switch (channel)");
    expect(source).toContain("CHANNEL_DISPATCHERS");
  });

  it("keeps CALENDAR action routing on structured params and the LLM planner", async () => {
    const source = await readRepoFile(
      "eliza/apps/app-lifeops/src/actions/calendar.ts",
    );
    expect(source).not.toContain("getValidationKeywordTerms");
    expect(source).not.toContain("textIncludesKeywordTerm");
    expect(source).not.toContain("collectKeywordTermMatchesForKey");
    expect(source).not.toContain("hasContextSignalSyncForKey");
    expect(source).not.toContain("function resolveCalendarIntent(");
    expect(source).not.toContain("function inferCalendarSubaction(");
    expect(source).not.toContain(
      "function looksLikeLifeReminderRequestForCalendarAction(",
    );
    expect(source).not.toContain("function inferCalendarSearchQuery(");
    expect(source).not.toContain("function inferTripWindowIntent(");
    expect(source).toContain("extractCalendarPlanWithLlm");
    expect(source).toContain("resolveStructuredCalendarSubaction");
  });

  it("keeps Gmail follow-up handling on LLM planning instead of phrase lists", async () => {
    const source = await readRepoFile(
      "eliza/apps/app-lifeops/src/actions/gmail.ts",
    );
    expect(source).not.toContain("function looksLikeReplyDraftRewriteFollowup(");
    expect(source).not.toContain("function looksLikeSendReplyFollowup(");
    expect(source).toContain("extractGmailPlanWithLlm");
  });

  it("keeps scheduling negotiation routing on structured params and the LLM planner", async () => {
    const source = await readRepoFile(
      "eliza/apps/app-lifeops/src/actions/scheduling.ts",
    );
    expect(source).not.toContain("function inferSchedulingSubaction(");
    expect(source).toContain("resolveSchedulingPlanWithLlm");
  });

  it("keeps RELATIONSHIP subaction routing on the LLM planner instead of English regex", async () => {
    const source = await readRepoFile(
      "eliza/apps/app-lifeops/src/actions/relationships.ts",
    );
    expect(source).not.toContain("function inferSubaction(");
    expect(source).not.toContain("list\\s+(contacts|people|rolodex)");
    expect(source).not.toContain("haven'?t\\s+(talked|heard|spoken)");
    expect(source).toContain("resolveRelationshipPlanWithLlm");
  });

  it("keeps HEALTH subaction and metric routing on the LLM planner instead of English regex", async () => {
    const source = await readRepoFile(
      "eliza/apps/app-lifeops/src/actions/health.ts",
    );
    expect(source).not.toContain("function inferSubaction(");
    expect(source).not.toContain("function inferMetric(");
    expect(source).not.toContain("\\b(steps|heart rate|sleep|calories|distance|active minutes)\\b");
    expect(source).toContain("resolveHealthPlanWithLlm");
  });

  it("keeps LIFE goal-update time-phrase extraction off English regex", async () => {
    const source = await readRepoFile(
      "eliza/apps/app-lifeops/src/actions/life.ts",
    );
    expect(source).not.toContain("function extractNaturalTimePhrase(");
    expect(source).not.toContain("\\bmornings?\\s+only\\b");
    expect(source).not.toContain("\\bafternoons?\\s+only\\b");
  });

  it("keeps inbox classifier JSON parsing off fragile regex extraction", async () => {
    const source = await readRepoFile(
      "eliza/apps/app-lifeops/src/inbox/triage-classifier.ts",
    );
    expect(source).not.toContain("raw.match(/\\[[\\s\\S]*\\]/)");
    expect(source).toContain("parseTriageJsonArray");
  });

  it("keeps CALENDAR personal/travel/preparation event detection off English regex", async () => {
    const source = await readRepoFile(
      "eliza/apps/app-lifeops/src/actions/calendar.ts",
    );
    // These are legacy English-only keyword regex helpers used to score
    // suggested durations and trip-window candidates. They must be replaced
    // with LLM-driven category extraction.
    expect(source).not.toContain("function isPersonalCreateEvent(");
    expect(source).not.toContain("function isShortPreparationEvent(");
    expect(source).not.toContain("function isTravelEvent(");
    expect(source).not.toContain(
      "/\\b(hug|wife|husband|partner|girlfriend|boyfriend",
    );
    expect(source).not.toContain(
      "/\\b(get ready|ready for|prep|prepare|packing|pack|leave for|head to|airport|flight|reminder|remind me)",
    );
    expect(source).not.toContain(
      "/\\b(flight|fly|travel|trip|hotel|stay|lodging|airbnb|check[- ]?in|check[- ]?out|return|home)",
    );
  });

  it("keeps scheduling day-of-week resolution off English weekday strings", async () => {
    const source = await readRepoFile(
      "eliza/apps/app-lifeops/src/actions/scheduling.ts",
    );
    // The day-of-week helper must derive the weekday numerically from
    // getZonedDateParts + UTC anchoring rather than parsing a localized
    // formatter string. The literal short-weekday map (Sun/Mon/...) and any
    // weekday: "short" formatter call inside dayOfWeekInTz are heuristics
    // because they only read correctly for en-US locales.
    expect(source).not.toContain("Sun: 0,\n    Mon: 1");
    const dayOfWeekFn = source.match(
      /function dayOfWeekInTz\([\s\S]*?\n\}\n/,
    );
    expect(dayOfWeekFn, "dayOfWeekInTz must be defined").toBeTruthy();
    expect(dayOfWeekFn?.[0] ?? "").not.toContain('weekday: "short"');
    expect(dayOfWeekFn?.[0] ?? "").toContain("getZonedDateParts");
  });

  it("keeps X read routing on structured params and the LLM planner", async () => {
    const source = await readRepoFile(
      "eliza/apps/app-lifeops/src/actions/x-read.ts",
    );
    expect(source).not.toContain("function inferSubactionFromIntent(");
    expect(source).toContain("resolveXReadPlanWithLlm");
  });

  it("keeps app blocker routing on the planner instead of package-name text scraping", async () => {
    const source = await readRepoFile(
      "eliza/apps/app-lifeops/src/actions/app-blocker.ts",
    );
    expect(source).not.toContain("function extractDurationMinutesFromText(");
    expect(source).not.toContain("function extractPackageNamesFromText(");
    expect(source).toContain("resolveAppBlockPlanWithLlm");
  });

  it("keeps website blocker routing on structured params and the LLM planner", async () => {
    const source = await readRepoFile(
      "eliza/apps/app-lifeops/src/actions/website-blocker.ts",
    );
    expect(source).not.toContain("extractDurationMinutesFromText");
    expect(source).not.toContain("extractWebsiteTargetsFromText");
    expect(source).not.toContain("hasWebsiteBlockDeferralIntent");
    expect(source).not.toContain("collectWebsiteBlockerConversation");
    expect(source).toContain("resolveWebsiteBlockPlanWithLlm");
  });

  it("keeps follow-up action gating on owner access instead of text heuristics", async () => {
    const sources = await Promise.all([
      readRepoFile(
        "eliza/apps/app-lifeops/src/followup/actions/listOverdueFollowups.ts",
      ),
      readRepoFile(
        "eliza/apps/app-lifeops/src/followup/actions/markFollowupDone.ts",
      ),
      readRepoFile(
        "eliza/apps/app-lifeops/src/followup/actions/setFollowupThreshold.ts",
      ),
    ]);
    for (const source of sources) {
      expect(source).not.toContain("function looksLike");
      expect(source).not.toContain("messageText(");
      expect(source).toContain("hasOwnerAccess");
    }
  });

  it("keeps website blocker engine parsing structured-only", async () => {
    const source = await readRepoFile(
      "eliza/apps/app-lifeops/src/website-blocker/engine.ts",
    );
    expect(source).toContain("parseSelfControlBlockRequest(\n  options?: HandlerOptions,");
    expect(source).not.toContain("parseSelfControlBlockRequest(\n  options?: HandlerOptions,\n  message?: Memory,");
    expect(source).not.toContain("extractDurationMinutesFromText(");
    expect(source).not.toContain("extractWebsiteTargetsFromText(");
    expect(source).not.toContain("hasWebsiteBlockDeferralIntent(");
    expect(source).not.toContain("hasWebsiteBlockIntent(");
    expect(source).not.toContain("hasIndefiniteBlockIntent(");
  });

  it("keeps website blocker routes on typed request bodies instead of synthetic chat messages", async () => {
    const source = await readRepoFile(
      "eliza/apps/app-lifeops/src/routes/website-blocker-routes.ts",
    );
    expect(source).not.toContain("text?: string");
    expect(source).not.toContain("function toSyntheticMessage(");
    expect(source).not.toContain("parseSelfControlBlockRequest(\n    {\n      parameters,\n    },");
  });

  it("keeps chat fallback execution off website-blocker regex intent detection", async () => {
    const source = await readRepoFile(
      "eliza/packages/agent/src/api/chat-routes.ts",
    );
    expect(source).not.toContain("fallbackHasWebsiteBlockDeferralIntent");
    expect(source).not.toContain("fallbackHasWebsiteBlockIntent");
    expect(source).not.toContain("inferWebsiteBlockFallback");
    expect(source).not.toContain("inferWebsiteBlockingPermissionFallback");
    expect(source).not.toContain("WEBSITE_BLOCK_SUBJECT_RE");
    expect(source).not.toContain("WEBSITE_BLOCK_FOLLOW_UP_RE");
  });

  it("keeps owner profile updates on typed action parameters", async () => {
    const source = await readRepoFile(
      "eliza/apps/app-lifeops/src/actions/update-owner-profile.ts",
    );
    expect(source).not.toContain("function extractOwnerProfilePatchFromText(");
    expect(source).toContain("normalizeLifeOpsOwnerProfilePatch(params ?? {})");
  });

  it("keeps Gmail triage free of sender-regex matching and additive score math", async () => {
    const source = await readRepoFile(
      "eliza/apps/app-lifeops/src/lifeops/google-gmail.ts",
    );
    expect(source).not.toContain("no-?reply");
    expect(source).not.toContain("triageScore +=");
  });

  it("surfaces connector degradation in the provider context", async () => {
    const source = await readRepoFile(
      "eliza/apps/app-lifeops/src/providers/lifeops.ts",
    );
    expect(source).toContain("connector degraded");
    expect(source).toContain("status unavailable");
  });
});
