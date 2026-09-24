/**
 * Committed mock-model fixtures (#10723) — one answer per corpus item,
 * simulating a triage model of FIXED quality. The code under test is the
 * real classifier's prompt-build → parse → validate → fail-closed path in
 * plugins/plugin-inbox/src/inbox/triage-classifier.ts; these fixtures are
 * the recorded model behind it.
 *
 * Seven answers are DELIBERATELY wrong (marked below) so per-class
 * precision/recall are non-trivial and the budgets.json floors sit exactly
 * one additional misclassification below the recorded baseline:
 *
 *   ig-03 ignore→info          ig-08 ignore→needs_reply
 *   in-03 info→notify          no-08 notify→info
 *   no-09 notify→info          nr-06 needs_reply→info
 *   ur-10 urgent→needs_reply
 *
 * → accuracy 49/56 = 0.875 (baseline.json documents the full breakdown).
 *
 * A few entries carry padded/uppercase enum values or string confidences —
 * the classifier's normalization (trim/lowercase/Number) is part of the
 * surface under test.
 */

export interface TriageFixtureAnswer {
  classification: string;
  urgency: string;
  confidence: number | string;
  reasoning: string;
  suggestedResponse?: string | null;
}

export const TRIAGE_FIXTURES: Record<string, TriageFixtureAnswer> = {
  // ── ignore ──────────────────────────────────────────────────────────────
  "ig-01": {
    classification: "ignore",
    urgency: "low",
    confidence: 0.97,
    reasoning: "Marketing flash-sale blast with unsubscribe footer.",
    suggestedResponse: null,
  },
  "ig-02": {
    classification: "ignore",
    urgency: "low",
    confidence: 0.96,
    reasoning: "Automated social-network vanity notification.",
    suggestedResponse: null,
  },
  // DELIBERATE ERROR: cold outreach misread as an informational update.
  "ig-03": {
    classification: "info",
    urgency: "low",
    confidence: 0.55,
    reasoning: "Business email describing an agency's services.",
    suggestedResponse: null,
  },
  "ig-04": {
    classification: "ignore",
    urgency: "low",
    confidence: 0.93,
    reasoning: "Phishing: misspelled sender, fake verify link, threat framing.",
    suggestedResponse: null,
  },
  "ig-05": {
    classification: "ignore",
    urgency: "low",
    confidence: 0.99,
    reasoning: "Bot level-up chatter addressed to another user.",
    suggestedResponse: null,
  },
  "ig-06": {
    classification: "ignore",
    urgency: "low",
    confidence: 0.98,
    reasoning: "Crypto presale spam with guaranteed-return claims.",
    suggestedResponse: null,
  },
  "ig-07": {
    classification: "ignore",
    urgency: "low",
    confidence: 0.97,
    reasoning: "Unsolicited trading-signal scam pitch.",
    suggestedResponse: null,
  },
  // DELIBERATE ERROR: flattery + question mistaken for a real ask.
  "ig-08": {
    classification: "needs_reply",
    urgency: "low",
    confidence: 0.52,
    reasoning: "Sender asks whether to send over a playbook.",
    suggestedResponse: "Sure, feel free to send it over.",
  },
  "ig-09": {
    classification: "ignore",
    urgency: "low",
    confidence: 0.9,
    reasoning: "Sponsored newsletter digest, no personal relevance.",
    suggestedResponse: null,
  },
  "ig-10": {
    classification: "ignore",
    urgency: "low",
    confidence: 0.92,
    reasoning: "Social lunch poll bot in a casual channel.",
    suggestedResponse: null,
  },
  "ig-11": {
    classification: "ignore",
    urgency: "low",
    confidence: 0.95,
    reasoning: "Win-back discount campaign from a streaming service.",
    suggestedResponse: null,
  },
  "ig-12": {
    classification: "ignore",
    urgency: "low",
    confidence: 0.94,
    reasoning: "Dependabot webhook noise for a patch-level bump.",
    suggestedResponse: null,
  },

  // ── info ────────────────────────────────────────────────────────────────
  "in-01": {
    classification: "info",
    urgency: "low",
    confidence: 0.95,
    reasoning: "Routine statement-available notice, explicitly no action.",
    suggestedResponse: null,
  },
  "in-02": {
    classification: "info",
    urgency: "low",
    confidence: 0.9,
    reasoning: "Team status update; future work is planned, not requested.",
    suggestedResponse: null,
  },
  // DELIBERATE ERROR: shipping update inflated to notify.
  "in-03": {
    classification: "notify",
    urgency: "low",
    confidence: 0.6,
    reasoning: "Delivery is imminent; owner likely wants to see this.",
    suggestedResponse: null,
  },
  "in-04": {
    classification: "info",
    urgency: "low",
    confidence: 0.93,
    reasoning: "Book-club heads-up, discussion is weeks away.",
    suggestedResponse: null,
  },
  "in-05": {
    classification: "info",
    urgency: "low",
    confidence: 0.94,
    reasoning: "Automated municipal reminder of a recurring schedule.",
    suggestedResponse: null,
  },
  "in-06": {
    classification: "info",
    urgency: "low",
    confidence: 0.92,
    reasoning: "Minor handbook revision announcement.",
    suggestedResponse: null,
  },
  "in-07": {
    classification: "info",
    urgency: "low",
    confidence: 0.91,
    reasoning: "Route shared for a group ride; explicitly FYI.",
    suggestedResponse: null,
  },
  "in-08": {
    classification: "info",
    urgency: "low",
    confidence: 0.95,
    reasoning: "Completed maintenance with no customer impact.",
    suggestedResponse: null,
  },
  "in-09": {
    classification: "info",
    urgency: "low",
    confidence: 0.9,
    reasoning: "Design progress share, nothing blocking.",
    suggestedResponse: null,
  },
  "in-10": {
    classification: "info",
    urgency: "low",
    confidence: 0.9,
    reasoning: "Group event announcement with open RSVP.",
    suggestedResponse: null,
  },

  // ── notify ──────────────────────────────────────────────────────────────
  "no-01": {
    classification: "notify",
    urgency: "medium",
    confidence: 0.88,
    reasoning: "Large completed payment the owner should verify at a glance.",
    suggestedResponse: null,
  },
  "no-02": {
    classification: "notify",
    urgency: "medium",
    confidence: 0.9,
    reasoning: "School delay affects tomorrow's family logistics.",
    suggestedResponse: null,
  },
  "no-03": {
    classification: "notify",
    urgency: "medium",
    confidence: 0.85,
    reasoning: "Production release with a bounded rollback window.",
    suggestedResponse: null,
  },
  "no-04": {
    classification: "notify",
    urgency: "low",
    confidence: 0.9,
    reasoning: "Normal lab results from a priority contact; no follow-up.",
    suggestedResponse: null,
  },
  "no-05": {
    classification: "notify",
    urgency: "medium",
    confidence: 0.9,
    reasoning: "Building water shutoff; sender says no reply needed.",
    suggestedResponse: null,
  },
  "no-06": {
    classification: "notify",
    urgency: "low",
    confidence: 0.9,
    reasoning: "Contract fully executed; record-keeping only.",
    suggestedResponse: null,
  },
  "no-07": {
    classification: "notify",
    urgency: "medium",
    confidence: 0.82,
    reasoning: "New-location sign-in the owner should eyeball.",
    suggestedResponse: null,
  },
  // DELIBERATE ERROR: schedule change downgraded to plain info.
  "no-08": {
    classification: "info",
    urgency: "low",
    confidence: 0.58,
    reasoning: "Airline says no action required if the new time works.",
    suggestedResponse: null,
  },
  // DELIBERATE ERROR: family safe-arrival downgraded to plain info.
  "no-09": {
    classification: "info",
    urgency: "low",
    confidence: 0.6,
    reasoning: "Casual travel update in the family group.",
    suggestedResponse: null,
  },
  "no-10": {
    classification: "notify",
    urgency: "low",
    confidence: 0.88,
    reasoning: "Tax payment recorded; receipt attached for records.",
    suggestedResponse: null,
  },

  // ── needs_reply ─────────────────────────────────────────────────────────
  "nr-01": {
    classification: "needs_reply",
    urgency: "medium",
    // String confidence: the classifier's validConfidence must coerce it.
    confidence: "0.93",
    reasoning: "Counterparty blocked on a contract-term confirmation.",
    suggestedResponse: "Good catch — it should be net-30 as discussed.",
  },
  "nr-02": {
    classification: "needs_reply",
    urgency: "medium",
    confidence: 0.92,
    reasoning: "Direct scheduling question with a booking deadline.",
    suggestedResponse: "Let's do the 21st — the 14th is too tight.",
  },
  "nr-03": {
    classification: "needs_reply",
    urgency: "low",
    confidence: 0.9,
    reasoning: "Podcast invitation offering two dates.",
    suggestedResponse: "The 16th works best for me.",
  },
  "nr-04": {
    classification: "needs_reply",
    urgency: "medium",
    confidence: 0.89,
    reasoning: "Friend needs review notes by a stated deadline.",
    suggestedResponse: "Yes — I'll send notes by Wednesday night.",
  },
  "nr-05": {
    classification: "needs_reply",
    urgency: "medium",
    confidence: 0.88,
    reasoning: "Headcount needed by tonight.",
    suggestedResponse: "I'm in for Saturday.",
  },
  // DELIBERATE ERROR: appointment-scheduling request read as info.
  "nr-06": {
    classification: "info",
    urgency: "low",
    confidence: 0.5,
    reasoning: "Routine recall notice from a dental office.",
    suggestedResponse: null,
  },
  "nr-07": {
    classification: "needs_reply",
    urgency: "medium",
    confidence: 0.9,
    reasoning: "Design decision explicitly blocking on the owner.",
    suggestedResponse: "Go with option B's single-scroll layout.",
  },
  "nr-08": {
    classification: "needs_reply",
    urgency: "low",
    confidence: 0.87,
    reasoning: "Polite follow-up asking to close the loop.",
    suggestedResponse: "Thanks for the nudge — I'll have an answer this week.",
  },
  "nr-09": {
    classification: "needs_reply",
    urgency: "medium",
    confidence: 0.9,
    reasoning: "Shortlist confirmation due by Friday.",
    suggestedResponse: "Confirming: I'll present in person.",
  },
  "nr-10": {
    classification: "needs_reply",
    urgency: "low",
    confidence: 0.88,
    reasoning: "Family asks for attendance and dietary confirmation.",
    suggestedResponse: "I'll be there — and yes, fish is still great.",
  },
  "nr-11": {
    classification: "needs_reply",
    urgency: "medium",
    confidence: 0.89,
    reasoning: "Finance needs missing receipts by Wednesday.",
    suggestedResponse: "Uploading both receipts today.",
  },
  "nr-12": {
    classification: "needs_reply",
    urgency: "medium",
    confidence: 0.9,
    reasoning: "Deposit authorization question with a this-week deadline.",
    suggestedResponse: "Yes, go ahead and pay the deposit.",
  },
  "nr-13": {
    classification: "needs_reply",
    urgency: "medium",
    confidence: 0.86,
    reasoning: "Support needs confirmation to process the refund.",
    suggestedResponse: "Card ending 4821; card refund please.",
  },
  "nr-14": {
    classification: "needs_reply",
    urgency: "low",
    confidence: 0.88,
    reasoning: "Maintainer blocked on an intent question before merge.",
    suggestedResponse: "Yes, dropping the legacy path is intentional.",
  },

  // ── urgent ──────────────────────────────────────────────────────────────
  "ur-01": {
    // Padded uppercase enums: the classifier's trim/lowercase normalization
    // is part of the surface under test.
    classification: " URGENT ",
    urgency: "HIGH",
    confidence: 0.98,
    reasoning: "SEV-1 with the owner on the escalation path.",
    suggestedResponse: null,
  },
  "ur-02": {
    classification: "urgent",
    urgency: "high",
    confidence: 0.97,
    reasoning: "Priority contact, same-day board call moved up.",
    suggestedResponse: "On it — calling you in 5.",
  },
  "ur-03": {
    classification: "urgent",
    urgency: "high",
    confidence: 0.98,
    reasoning: "Family medical emergency asking to meet now.",
    suggestedResponse: "On my way to Mercy on 5th.",
  },
  "ur-04": {
    classification: "urgent",
    urgency: "high",
    confidence: 0.96,
    reasoning: "Tonight's flight cancelled; rebooking window closes at 6pm.",
    suggestedResponse: null,
  },
  "ur-05": {
    classification: "urgent",
    urgency: "high",
    confidence: 0.97,
    reasoning: "Priority contact needs go/no-go inside 30 minutes.",
    suggestedResponse: "No-go until the cap is corrected.",
  },
  "ur-06": {
    classification: "urgent",
    urgency: "high",
    confidence: 0.94,
    reasoning: "Priority medical contact requests a same-day call.",
    suggestedResponse: null,
  },
  "ur-07": {
    classification: "urgent",
    urgency: "high",
    confidence: 0.97,
    reasoning: "Live credential exposure; immediate rotation required.",
    suggestedResponse: null,
  },
  "ur-08": {
    classification: "urgent",
    urgency: "high",
    confidence: 0.96,
    reasoning: "Active leak; plumber en route needs access now.",
    suggestedResponse: "Home in 20 — I'll let him in.",
  },
  "ur-09": {
    classification: "urgent",
    urgency: "high",
    confidence: 0.95,
    reasoning: "Cert expiry in 3 hours breaks all mobile clients.",
    suggestedResponse: "Taking it — re-issuing manually now.",
  },
  // DELIBERATE ERROR: hard-deadline tax notice softened to needs_reply.
  "ur-10": {
    classification: "needs_reply",
    urgency: "medium",
    confidence: 0.62,
    reasoning: "Tax board expects a filing response.",
    suggestedResponse: null,
  },
};
