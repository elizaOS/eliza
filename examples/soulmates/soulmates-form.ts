/**
 * Soulmates Onboarding Form
 *
 * This implements the complete Ori onboarding flow:
 *
 * 1. ENTRY: Name and location capture
 * 2. INTENT: What are you searching for?
 * 3. DEEPER: How do you want to feel? What do you really want?
 * 4. VALIDATION: Ori reflects insight, asks "Did I get that right?"
 * 5. COMMITMENT: Explain how we help, ask for commitment
 * 6. DOMAIN DISCOVERY: Friend/Business/Love specific questions
 * 7. AVAILABILITY: Capture scheduling preferences
 *
 * The form supports:
 * - Progressive profiling (collect more over time)
 * - Validation loops ("What did I miss?")
 * - Domain-specific discovery branches
 * - Integration with scheduling plugin for availability
 */

import type {
  Action,
  IAgentRuntime,
  JsonValue,
  Plugin,
  TargetInfo,
  Task,
  TaskWorker,
} from "@elizaos/core";
import { C, Form, type FormService } from "@elizaos/plugin-form";
import type { MatchingService } from "./matching-service";

type JsonRecord = Record<string, JsonValue | object>;

// ============================================================================
// OPTIONS
// ============================================================================

const genderOptions = [
  { value: "woman", label: "Woman" },
  { value: "man", label: "Man" },
  { value: "nonbinary", label: "Non-binary" },
  { value: "other", label: "Other" },
  { value: "prefer_not_say", label: "Prefer not to say" },
];

const pronounExamples = ["she/her", "he/him", "they/them"];

const orientationOptions = [
  { value: "straight", label: "Straight" },
  { value: "gay", label: "Gay" },
  { value: "lesbian", label: "Lesbian" },
  { value: "bisexual", label: "Bisexual" },
  { value: "pansexual", label: "Pansexual" },
  { value: "queer", label: "Queer" },
  { value: "asexual", label: "Asexual" },
  { value: "questioning", label: "Questioning" },
  { value: "other", label: "Other" },
  { value: "prefer_not_say", label: "Prefer not to say" },
];

const intentOptions = [
  { value: "love", label: "Love / Romance" },
  { value: "friendship", label: "Friendship / Community" },
  { value: "business", label: "Business / Networking" },
  { value: "open", label: "Open to all" },
];

const yesNoOptions = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];

const cadenceOptions = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every two weeks" },
  { value: "monthly", label: "Monthly" },
  { value: "flexible", label: "Flexible" },
];

const timeOfDayOptions = [
  { value: "morning", label: "Morning (before noon)" },
  { value: "afternoon", label: "Afternoon (12-5pm)" },
  { value: "evening", label: "Evening (after 5pm)" },
  { value: "flexible", label: "Flexible" },
];

const dayOptions = [
  { value: "weekdays", label: "Weekdays" },
  { value: "weekends", label: "Weekends" },
  { value: "both", label: "Both weekdays and weekends" },
];

// ============================================================================
// DISCOVERY QUESTIONS
// ============================================================================

type DiscoveryQuestion = {
  id: string;
  text: string;
  theme: string;
  domain?: "love" | "friendship" | "business" | "general";
};

const DISCOVERY_QUESTION_COUNT = 3;

const discoveryQuestions: DiscoveryQuestion[] = [
  // Power questions (general)
  {
    id: "power_relationship_lessons",
    text: "Tell me about a relationship that didn't work out. What did you learn about yourself?",
    theme: "power",
    domain: "general",
  },
  {
    id: "power_good_week",
    text: "What does a good week look like for you right now?",
    theme: "power",
    domain: "general",
  },
  {
    id: "power_truly_seen",
    text: "When was the last time you felt truly seen by someone? What were they doing?",
    theme: "power",
    domain: "general",
  },
  {
    id: "power_changing_self",
    text: "What's something you're working on changing about yourself?",
    theme: "power",
    domain: "general",
  },
  {
    id: "power_trust_signals",
    text: "How do you know when you can trust someone?",
    theme: "power",
    domain: "general",
  },
  {
    id: "power_nonnegotiables",
    text: "What are you not willing to sacrifice right now?",
    theme: "power",
    domain: "general",
  },
  {
    id: "power_life_build",
    text: "What kind of life are you trying to build?",
    theme: "power",
    domain: "general",
  },
  {
    id: "power_feel_alive",
    text: "What makes you feel alive right now?",
    theme: "power",
    domain: "general",
  },

  // Love-specific questions
  {
    id: "love_taught_love",
    text: "Who taught you what love looks like and why?",
    theme: "relational_blueprint",
    domain: "love",
  },
  {
    id: "love_dynamic_different",
    text: "Tell me about a relationship dynamic you saw growing up that you're trying to do differently.",
    theme: "relational_blueprint",
    domain: "love",
  },
  {
    id: "love_emotional_intimacy",
    text: "What does emotional intimacy look like to you?",
    theme: "intimacy",
    domain: "love",
  },
  {
    id: "love_truly_known",
    text: "When have you felt truly known by someone?",
    theme: "intimacy",
    domain: "love",
  },
  {
    id: "love_physical_bond",
    text: "What role does physical connection play in how you bond with someone?",
    theme: "needs",
    domain: "love",
  },
  {
    id: "love_partnership_now",
    text: "What are you looking for in a partnership right now?",
    theme: "needs",
    domain: "love",
  },

  // Friendship-specific questions
  {
    id: "friendship_vibe",
    text: "What kind of energy do you bring to friendships?",
    theme: "vibe",
    domain: "friendship",
  },
  {
    id: "friendship_show_up",
    text: "How do you show up when a friend is struggling?",
    theme: "care",
    domain: "friendship",
  },
  {
    id: "friendship_missing",
    text: "What kind of companionship are you missing in your life?",
    theme: "needs",
    domain: "friendship",
  },
  {
    id: "friendship_boundaries",
    text: "What boundaries are important to you in friendships?",
    theme: "boundaries",
    domain: "friendship",
  },

  // Business-specific questions
  {
    id: "business_seeking",
    text: "What kind of professional connections are you seeking?",
    theme: "goals",
    domain: "business",
  },
  {
    id: "business_offer",
    text: "What unique perspective or skill do you bring to the table?",
    theme: "value",
    domain: "business",
  },
  {
    id: "business_collaboration",
    text: "Tell me about a collaboration that worked well. What made it successful?",
    theme: "style",
    domain: "business",
  },
  {
    id: "business_looking_for",
    text: "Are you looking for a mentor, peer, or mentee?",
    theme: "relationship_type",
    domain: "business",
  },

  // Values (general)
  {
    id: "values_walked_away",
    text: "What's something you've walked away from because it didn't align with who you are?",
    theme: "values",
    domain: "general",
  },
  {
    id: "values_refuse_compromise",
    text: "What do you refuse to compromise on? Why?",
    theme: "values",
    domain: "general",
  },

  // Passion (general)
  {
    id: "passion_lights_you_up",
    text: "What lights you up when you talk about it?",
    theme: "passion",
    domain: "general",
  },
  {
    id: "passion_most_alive",
    text: "When do you feel most alive?",
    theme: "passion",
    domain: "general",
  },
];

// ============================================================================
// QUESTION SELECTION
// ============================================================================

function hashStringToSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pickDiscoveryQuestions(
  count: number,
  seed: number,
  domain?: "love" | "friendship" | "business",
): DiscoveryQuestion[] {
  if (count <= 0) {
    return [];
  }

  // Filter questions by domain (include general + domain-specific)
  const pool = discoveryQuestions.filter(
    (q) => q.domain === "general" || q.domain === domain,
  );

  const rng = createSeededRng(seed);
  const shuffled = [...pool];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex],
      shuffled[index],
    ];
  }

  return shuffled.slice(0, Math.min(count, shuffled.length));
}

// ============================================================================
// FORM DEFINITION
// ============================================================================

/**
 * Stage 1: Entry Form
 * Collects basic info: name, location, initial intent
 */
export const soulmatesEntryForm = Form.create("soulmates_entry")
  .name("Soulmates Entry")
  .description("Initial connection with Ori")
  .control(
    C.text("fullName").required().ask("What's your name?").example("Alex"),
  )
  .control(
    C.text("city")
      .required()
      .ask("Where are you based?")
      .example("San Francisco"),
  )
  .control(
    C.select("consent", yesNoOptions)
      .required()
      .ask(
        "Before we begin: do you consent to Ori using your responses to match you with others? You can stop anytime.",
      ),
  )
  .control(
    C.select("privacyConsent", yesNoOptions)
      .required()
      .ask(
        "Do you agree to our privacy policy? We'll only use your data to match you and support safety. Reply YES to continue.",
      ),
  )
  .control(
    C.select("safetyConsent", yesNoOptions)
      .required()
      .ask(
        "Do you agree to follow our community safety and conduct guidelines? Reply YES to continue.",
      ),
  )
  .control(
    C.select("intent", intentOptions)
      .required()
      .ask("What kind of connection are you looking for?"),
  )
  .onStart("soulmates_entry_started")
  .onSubmit("soulmates_entry_submitted")
  .build();

/**
 * Stage 1.5: Verification Form
 * Confirms the user can receive messages on this number
 */
export const soulmatesVerificationForm = Form.create("soulmates_verification")
  .name("Soulmates Verification")
  .description("Confirm your number to continue")
  .control(
    C.text("verificationCode")
      .required()
      .ask("Enter the 4-digit code I just sent you.")
      .example("1234"),
  )
  .onStart("soulmates_verification_started")
  .onSubmit("soulmates_verification_submitted")
  .build();

/**
 * Stage 2: Deeper Discovery Form
 * Collects emotional drivers: desired feelings, core desires
 */
export const soulmatesDeeperForm = Form.create("soulmates_deeper")
  .name("Soulmates Deeper")
  .description("Understanding what you really want")
  .control(
    C.text("desiredFeeling")
      .required()
      .ask("How do you want to feel with the right person?")
      .description("Be honest. What feeling are you chasing?")
      .example("Seen, calm, energized"),
  )
  .control(
    C.text("coreDesire")
      .required()
      .ask("What do you really want right now?")
      .description("Not the surface answer. The real one.")
      .example("A partner to build a life with"),
  )
  .onStart("soulmates_deeper_started")
  .onSubmit("soulmates_deeper_submitted")
  .build();

/**
 * Stage 3: Validation Form
 * Ori reflects back insight, asks for confirmation
 */
export const soulmatesValidationForm = Form.create("soulmates_validation")
  .name("Soulmates Validation")
  .description("Confirming Ori understood correctly")
  .control(C.text("oriInsight").hidden())
  .control(
    C.select("insightCorrect", yesNoOptions)
      .required()
      .label("Did I get that right?")
      .ask("{{oriInsight}}\n\nDid I get that right?"),
  )
  .control(
    C.text("correction")
      .label("What did I miss?")
      .ask("I'm still getting to know you. What did I miss?")
      .description("Help me understand you better")
      .dependsOn("insightCorrect", "equals", "no"),
  )
  .onStart("soulmates_validation_started")
  .onSubmit("soulmates_validation_submitted")
  .build();

/**
 * Stage 4: Profile Details Form
 * Collects demographics and preferences
 */
export const soulmatesProfileForm = Form.create("soulmates_profile")
  .name("Soulmates Profile")
  .description("Building your profile")
  .control(
    C.text("pronouns")
      .required()
      .ask("What pronouns should I use for you?")
      .example(
        pronounExamples[Math.floor(Math.random() * pronounExamples.length)],
      ),
  )
  .control(C.number("age").required().min(18).ask("How old are you?"))
  .control(
    C.select("gender", genderOptions).required().ask("What's your gender?"),
  )
  .control(
    C.select("orientation", orientationOptions)
      .required()
      .ask("What's your orientation?")
      .dependsOn("intent", "equals", "love"),
  )
  .control(
    C.text("values")
      .required()
      .ask("What matters most in a match?")
      .example("Kind, curious, grounded"),
  )
  .control(
    C.text("communityTags")
      .ask("Any community tags that describe you? (optional)")
      .example("designers, founders, writers"),
  )
  .control(
    C.text("dealbreakers")
      .ask("Any dealbreakers?")
      .example("Dishonesty, rudeness"),
  )
  .onStart("soulmates_profile_started")
  .onSubmit("soulmates_profile_submitted")
  .build();

/**
 * Stage 5: Discovery Questions Form
 * Domain-specific deeper questions
 */
export const soulmatesDiscoveryForm = Form.create("soulmates_discovery")
  .name("Soulmates Discovery")
  .description("Getting to know you deeper")
  // Hidden fields for question metadata
  .control(C.text("discoveryQuestion1Id").hidden())
  .control(C.text("discoveryQuestion1Theme").hidden())
  .control(C.text("discoveryQuestion1Text").hidden())
  .control(C.text("discoveryQuestion2Id").hidden())
  .control(C.text("discoveryQuestion2Theme").hidden())
  .control(C.text("discoveryQuestion2Text").hidden())
  .control(C.text("discoveryQuestion3Id").hidden())
  .control(C.text("discoveryQuestion3Theme").hidden())
  .control(C.text("discoveryQuestion3Text").hidden())
  // Visible answer fields
  .control(
    C.text("discoveryAnswer1")
      .required()
      .label("{{discoveryQuestion1Text}}")
      .ask("{{discoveryQuestion1Text}}"),
  )
  .control(
    C.text("discoveryAnswer2")
      .required()
      .label("{{discoveryQuestion2Text}}")
      .ask("{{discoveryQuestion2Text}}"),
  )
  .control(
    C.text("discoveryAnswer3")
      .label("{{discoveryQuestion3Text}}")
      .ask("{{discoveryQuestion3Text}}"),
  )
  .onStart("soulmates_discovery_started")
  .onSubmit("soulmates_discovery_submitted")
  .build();

/**
 * Stage 6: Commitment Form
 * Explain how we help, ask for commitment
 */
export const soulmatesCommitmentForm = Form.create("soulmates_commitment")
  .name("Soulmates Commitment")
  .description("Making a commitment to the process")
  .control(C.text("howWeHelp").hidden())
  .control(
    C.select("readyToCommit", yesNoOptions)
      .required()
      .label("Ready to commit?")
      .ask("{{howWeHelp}}\n\nAre you ready to give this a real try?"),
  )
  .control(
    C.text("hesitation")
      .label("What's holding you back?")
      .ask("What's holding you back?")
      .dependsOn("readyToCommit", "equals", "no"),
  )
  .onStart("soulmates_commitment_started")
  .onSubmit("soulmates_commitment_submitted")
  .build();

/**
 * Stage 7: Availability Form
 * Collect scheduling preferences
 */
export const soulmatesAvailabilityForm = Form.create("soulmates_availability")
  .name("Soulmates Availability")
  .description("Setting your availability for meetings")
  .control(
    C.text("timeZone")
      .required()
      .ask("What's your time zone?")
      .example("America/New_York")
      .description("This helps me coordinate meetings across time zones"),
  )
  .control(
    C.select("preferredDays", dayOptions)
      .required()
      .ask("When are you usually available to meet?"),
  )
  .control(
    C.select("preferredTimes", timeOfDayOptions)
      .multiple()
      .required()
      .ask("What times of day work best?"),
  )
  .control(
    C.select("meetingCadence", cadenceOptions)
      .required()
      .ask("How often would you like to meet new people?"),
  )
  .onStart("soulmates_availability_started")
  .onSubmit("soulmates_availability_submitted")
  .build();

// ============================================================================
// LEGACY COMBINED FORM (for backward compatibility)
// ============================================================================

export const soulmatesIntakeForm = Form.create("soulmates_intake")
  .name("Soulmates Intake")
  .description("Build your matchmaking profile")
  .control(
    C.text("fullName")
      .required()
      .ask("What's your name?")
      .example("Alex Rivera"),
  )
  .control(C.number("age").required().min(18).ask("How old are you?"))
  .control(
    C.text("city")
      .required()
      .ask("Where are you based?")
      .example("Los Angeles"),
  )
  .control(
    C.select("gender", genderOptions).required().ask("What's your gender?"),
  )
  .control(
    C.select("orientation", orientationOptions)
      .required()
      .ask("What's your orientation?"),
  )
  .control(
    C.select("intent", intentOptions)
      .required()
      .ask("What are you looking for?"),
  )
  .control(
    C.text("desiredFeeling")
      .required()
      .ask("How do you want to feel with the right person?")
      .example("Seen, calm, energized"),
  )
  .control(
    C.text("coreDesire")
      .required()
      .ask("What do you really want right now?")
      .example("A partner to build a home with"),
  )
  .control(
    C.text("values")
      .required()
      .ask("What matters most in a match?")
      .example("Kind, curious, grounded"),
  )
  .control(
    C.text("dealbreakers")
      .required()
      .ask("Any dealbreakers?")
      .example("Dishonesty, rudeness"),
  )
  .control(C.text("discoveryQuestionOneId").hidden())
  .control(C.text("discoveryQuestionOneTheme").hidden())
  .control(C.text("discoveryQuestionOneText").hidden())
  .control(C.text("discoveryQuestionTwoId").hidden())
  .control(C.text("discoveryQuestionTwoTheme").hidden())
  .control(C.text("discoveryQuestionTwoText").hidden())
  .control(
    C.text("discoveryQuestionOneAnswer")
      .required()
      .label("{{discoveryQuestionOneText}}")
      .description("Answer this question: {{discoveryQuestionOneText}}")
      .ask("{{discoveryQuestionOneText}}"),
  )
  .control(
    C.text("discoveryQuestionTwoAnswer")
      .required()
      .label("{{discoveryQuestionTwoText}}")
      .description("Answer this question: {{discoveryQuestionTwoText}}")
      .ask("{{discoveryQuestionTwoText}}"),
  )
  .onStart("soulmates_intake_started")
  .onSubmit("soulmates_intake_submitted")
  .build();

// ============================================================================
// HELPERS
// ============================================================================

function isRecord(value: JsonValue | object | undefined): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(values: JsonRecord, key: string): string | undefined {
  const value = values[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNumber(values: JsonRecord, key: string): number | undefined {
  const value = values[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function parseTags(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const tags = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

function formatDiscoveryEntry(
  question: string | undefined,
  answer: string | undefined,
): string | undefined {
  if (!question && !answer) {
    return undefined;
  }
  const questionText = question ?? "Question not captured";
  const answerText = answer ?? "No answer provided";
  return `"${questionText}": ${answerText}`;
}

/**
 * Generate Ori's insight based on collected data
 */
function generateInsight(values: JsonRecord): string {
  const name = readString(values, "fullName") ?? "friend";
  const intent = readString(values, "intent");
  const desiredFeeling = readString(values, "desiredFeeling");
  const coreDesire = readString(values, "coreDesire");

  const intentMap: Record<string, string> = {
    love: "finding someone special",
    friendship: "building meaningful friendships",
    business: "making valuable professional connections",
    open: "being open to whatever comes",
  };

  const intentText = intent
    ? intentMap[intent] || "finding connection"
    : "finding connection";

  let insight = `${name}, from what you've shared, you're ${intentText}.`;

  if (desiredFeeling) {
    insight += ` You want to feel ${desiredFeeling.toLowerCase()}.`;
  }

  if (coreDesire) {
    insight += ` At your core, you're looking for ${coreDesire.toLowerCase()}.`;
  }

  insight += " That's something I can help with.";

  return insight;
}

/**
 * Generate explanation of how Ori can help
 */
function generateHowWeHelp(values: JsonRecord): string {
  const intent = readString(values, "intent");

  const explanations: Record<string, string> = {
    love: "I'll introduce you to people who share your values and are looking for the same depth of connection. No swiping, no games. Just real conversations with people I think you'll click with.",
    friendship:
      "I'll connect you with people who share your interests and energy. Building friendships takes time, and I'm here to make those first introductions easier.",
    business:
      "I'll introduce you to professionals who complement your skills and goals. Quality over quantity, focusing on connections that could actually matter for your career.",
    open: "I'll pay attention to what resonates with you and introduce you to people across different areas of life. Sometimes the best connections come from unexpected places.",
  };

  return explanations[intent ?? "open"] ?? explanations.open;
}

// ============================================================================
// TASK WORKERS
// ============================================================================

const soulmatesEntryStartedWorker: TaskWorker = {
  name: "soulmates_entry_started",
  execute: async (runtime: IAgentRuntime, _options, _task: Task) => {
    runtime.logger.info("[SoulmatesForm] Entry session started");
  },
};

const soulmatesEntrySubmittedWorker: TaskWorker = {
  name: "soulmates_entry_submitted",
  execute: async (runtime: IAgentRuntime, options, task: Task) => {
    const submissionValue = options.submission;
    if (!isRecord(submissionValue)) {
      return;
    }

    const values = submissionValue.values;
    if (!isRecord(values)) {
      return;
    }

    const fullName = readString(values, "fullName") ?? "Unknown";
    const city = readString(values, "city") ?? "Unknown";
    const consent = readString(values, "consent");
    const privacyConsent = readString(values, "privacyConsent");
    const safetyConsent = readString(values, "safetyConsent");
    const intent = readString(values, "intent") ?? "open";

    runtime.logger.info(
      `[SoulmatesForm] Entry submitted: ${fullName} from ${city}, looking for ${intent}`,
    );

    // Update flow state and advance to next stage
    const entityId = task.entityId;
    const roomId = task.roomId;
    if (entityId && roomId) {
      try {
        // Dynamic import to avoid circular dependency
        const { getOrCreateUserState, saveUserState, advanceStage } =
          await import("./flow-orchestrator");
        const state = await getOrCreateUserState(entityId);
        state.profile.fullName = fullName;
        state.profile.city = city;
        state.intent = intent as "love" | "friendship" | "business" | "open";
        state.consent.granted = consent === "yes";
        state.consent.grantedAt = consent === "yes" ? Date.now() : undefined;
        state.consent.privacyGranted = privacyConsent === "yes";
        state.consent.privacyGrantedAt =
          privacyConsent === "yes" ? Date.now() : undefined;
        state.consent.safetyGranted = safetyConsent === "yes";
        state.consent.safetyGrantedAt =
          safetyConsent === "yes" ? Date.now() : undefined;
        if (
          !state.consent.granted ||
          !state.consent.privacyGranted ||
          !state.consent.safetyGranted
        ) {
          state.stage = "blocked";
          await saveUserState(state);
          await runtime.sendMessageToTarget(
            { roomId, entityId } as TargetInfo,
            {
              text: "Thanks for letting me know. If you want to continue later, just say hi.",
            },
          );
          return;
        }
        await saveUserState(state);
        await advanceStage(runtime, state, roomId);
      } catch (err) {
        runtime.logger.error(`[SoulmatesForm] Error advancing flow: ${err}`);
      }
    }
  },
};

const soulmatesVerificationStartedWorker: TaskWorker = {
  name: "soulmates_verification_started",
  execute: async (runtime: IAgentRuntime, _options, _task: Task) => {
    runtime.logger.info("[SoulmatesForm] Verification started");
  },
};

const soulmatesVerificationSubmittedWorker: TaskWorker = {
  name: "soulmates_verification_submitted",
  execute: async (runtime: IAgentRuntime, options, task: Task) => {
    const submissionValue = options.submission;
    if (!isRecord(submissionValue)) {
      return;
    }

    const values = submissionValue.values;
    if (!isRecord(values)) {
      return;
    }

    const enteredCode = readString(values, "verificationCode")?.trim() ?? "";
    const entityId = task.entityId;
    const roomId = task.roomId;
    if (!entityId || !roomId) return;

    try {
      const {
        getUserState,
        saveUserState,
        advanceStage,
        issueVerificationCode,
        MAX_VERIFICATION_ATTEMPTS,
      } = await import("./flow-orchestrator");
      const state = await getUserState(entityId);
      if (!state) return;

      if (!state.verification || !state.verification.code) {
        await issueVerificationCode(runtime, state, roomId);
        return;
      }

      if (enteredCode && enteredCode === state.verification.code) {
        state.verification.status = "verified";
        state.verification.verifiedAt = Date.now();
        state.verification.code = undefined;
        await saveUserState(state);
        await advanceStage(runtime, state, roomId);
        return;
      }

      state.verification.attempts += 1;
      if (state.verification.attempts >= MAX_VERIFICATION_ATTEMPTS) {
        state.stage = "blocked";
        state.verification.status = "locked";
        await saveUserState(state);
        await runtime.sendMessageToTarget({ roomId, entityId } as TargetInfo, {
          text: "I could not verify your number. Please reply HELP and we can try again.",
        });
        return;
      }

      await saveUserState(state);
      await runtime.sendMessageToTarget({ roomId, entityId } as TargetInfo, {
        text: "That code didn't match. Please try again or reply RESEND for a new code.",
      });
    } catch (err) {
      runtime.logger.error(`[SoulmatesForm] Verification error: ${err}`);
    }
  },
};

const soulmatesDeeperStartedWorker: TaskWorker = {
  name: "soulmates_deeper_started",
  execute: async (runtime: IAgentRuntime, _options, _task: Task) => {
    runtime.logger.info("[SoulmatesForm] Deeper discovery started");
  },
};

const soulmatesDeeperSubmittedWorker: TaskWorker = {
  name: "soulmates_deeper_submitted",
  execute: async (runtime: IAgentRuntime, options, task: Task) => {
    const submissionValue = options.submission;
    if (!isRecord(submissionValue)) {
      return;
    }

    const values = submissionValue.values;
    if (!isRecord(values)) {
      return;
    }

    const desiredFeeling = readString(values, "desiredFeeling");
    const coreDesire = readString(values, "coreDesire");

    runtime.logger.info(
      `[SoulmatesForm] Deeper submitted: wants to feel "${desiredFeeling}", core desire: "${coreDesire}"`,
    );

    // Update flow state and advance to next stage
    const entityId = task.entityId;
    const roomId = task.roomId;
    if (entityId && roomId) {
      try {
        const { getUserState, saveUserState, advanceStage } = await import(
          "./flow-orchestrator"
        );
        const state = await getUserState(entityId);
        if (state) {
          state.profile.desiredFeeling = desiredFeeling;
          state.profile.coreDesire = coreDesire;
          await saveUserState(state);
          await advanceStage(runtime, state, roomId);
        }
      } catch (err) {
        runtime.logger.error(`[SoulmatesForm] Error advancing flow: ${err}`);
      }
    }
  },
};

const soulmatesValidationStartedWorker: TaskWorker = {
  name: "soulmates_validation_started",
  execute: async (runtime: IAgentRuntime, _options, _task: Task) => {
    runtime.logger.info("[SoulmatesForm] Validation started");
  },
};

const soulmatesValidationSubmittedWorker: TaskWorker = {
  name: "soulmates_validation_submitted",
  execute: async (runtime: IAgentRuntime, options, task: Task) => {
    const submissionValue = options.submission;
    if (!isRecord(submissionValue)) {
      return;
    }

    const values = submissionValue.values;
    if (!isRecord(values)) {
      return;
    }

    const insightCorrect = readString(values, "insightCorrect");
    const correction = readString(values, "correction");

    const entityId = task.entityId;
    const roomId = task.roomId;

    if (insightCorrect === "yes") {
      runtime.logger.info(
        "[SoulmatesForm] Validation confirmed - insight was correct",
      );

      // Advance to profile stage
      if (entityId && roomId) {
        try {
          const { getUserState, advanceStage } = await import(
            "./flow-orchestrator"
          );
          const state = await getUserState(entityId);
          if (state) {
            await advanceStage(runtime, state, roomId);
          }
        } catch (err) {
          runtime.logger.error(`[SoulmatesForm] Error advancing flow: ${err}`);
        }
      }
    } else {
      runtime.logger.info(
        `[SoulmatesForm] Validation needs revision - correction: "${correction}"`,
      );

      // Go back for correction
      if (entityId && roomId) {
        try {
          const { getUserState, saveUserState, advanceStage } = await import(
            "./flow-orchestrator"
          );
          const state = await getUserState(entityId);
          if (state) {
            state.validationAttempts += 1;
            state.validation.correction = correction;
            state.stage = "validation_retry";
            await saveUserState(state);
            await advanceStage(runtime, state, roomId);
          }
        } catch (err) {
          runtime.logger.error(
            `[SoulmatesForm] Error handling validation retry: ${err}`,
          );
        }
      }
    }
  },
};

const soulmatesProfileStartedWorker: TaskWorker = {
  name: "soulmates_profile_started",
  execute: async (runtime: IAgentRuntime, _options, _task: Task) => {
    runtime.logger.info("[SoulmatesForm] Profile capture started");
  },
};

const soulmatesProfileSubmittedWorker: TaskWorker = {
  name: "soulmates_profile_submitted",
  execute: async (runtime: IAgentRuntime, options, task: Task) => {
    const submissionValue = options.submission;
    if (!isRecord(submissionValue)) {
      return;
    }

    const values = submissionValue.values;
    if (!isRecord(values)) {
      return;
    }

    const pronouns = readString(values, "pronouns");
    const age = readNumber(values, "age");
    const gender = readString(values, "gender");
    const orientation = readString(values, "orientation");
    const userValues = readString(values, "values");
    const communityTags = parseTags(readString(values, "communityTags"));
    const dealbreakers = readString(values, "dealbreakers");

    runtime.logger.info(
      `[SoulmatesForm] Profile submitted: ${age} years old, ${gender}, ${orientation}, values: ${userValues}`,
    );

    // Update flow state and advance
    const entityId = task.entityId;
    const roomId = task.roomId;
    if (entityId && roomId) {
      try {
        const { getUserState, saveUserState, advanceStage } = await import(
          "./flow-orchestrator"
        );
        const state = await getUserState(entityId);
        if (state) {
          state.profile.pronouns = pronouns;
          state.profile.age = age;
          state.profile.gender = gender;
          state.profile.orientation = orientation;
          state.profile.values = userValues;
          state.profile.communityTags = communityTags;
          state.profile.dealbreakers = dealbreakers;
          await saveUserState(state);
          await advanceStage(runtime, state, roomId);
        }
      } catch (err) {
        runtime.logger.error(`[SoulmatesForm] Error advancing flow: ${err}`);
      }
    }
  },
};

const soulmatesDiscoveryStartedWorker: TaskWorker = {
  name: "soulmates_discovery_started",
  execute: async (runtime: IAgentRuntime, _options, _task: Task) => {
    runtime.logger.info("[SoulmatesForm] Discovery questions started");
  },
};

const soulmatesDiscoverySubmittedWorker: TaskWorker = {
  name: "soulmates_discovery_submitted",
  execute: async (runtime: IAgentRuntime, options, task: Task) => {
    const submissionValue = options.submission;
    if (!isRecord(submissionValue)) {
      return;
    }

    const values = submissionValue.values;
    if (!isRecord(values)) {
      return;
    }

    const q1Id = readString(values, "discoveryQuestion1Id");
    const q1Theme = readString(values, "discoveryQuestion1Theme");
    const q1Text = readString(values, "discoveryQuestion1Text");
    const a1 = readString(values, "discoveryAnswer1");
    const q2Id = readString(values, "discoveryQuestion2Id");
    const q2Theme = readString(values, "discoveryQuestion2Theme");
    const q2Text = readString(values, "discoveryQuestion2Text");
    const a2 = readString(values, "discoveryAnswer2");
    const q3Id = readString(values, "discoveryQuestion3Id");
    const q3Theme = readString(values, "discoveryQuestion3Theme");
    const q3Text = readString(values, "discoveryQuestion3Text");
    const a3 = readString(values, "discoveryAnswer3");

    const entries = [
      formatDiscoveryEntry(q1Text, a1),
      formatDiscoveryEntry(q2Text, a2),
      formatDiscoveryEntry(q3Text, a3),
    ].filter(Boolean);

    runtime.logger.info(
      `[SoulmatesForm] Discovery submitted with ${entries.length} answers`,
    );

    // Update flow state and advance
    const entityId = task.entityId;
    const roomId = task.roomId;
    if (entityId && roomId) {
      try {
        const { getUserState, saveUserState, advanceStage } = await import(
          "./flow-orchestrator"
        );
        const state = await getUserState(entityId);
        if (state) {
          state.profile.discoveryAnswers = [];
          if (q1Id && q1Text && a1) {
            state.profile.discoveryAnswers.push({
              questionId: q1Id,
              theme: q1Theme ?? "unknown",
              question: q1Text,
              answer: a1,
            });
          }
          if (q2Id && q2Text && a2) {
            state.profile.discoveryAnswers.push({
              questionId: q2Id,
              theme: q2Theme ?? "unknown",
              question: q2Text,
              answer: a2,
            });
          }
          if (q3Id && q3Text && a3) {
            state.profile.discoveryAnswers.push({
              questionId: q3Id,
              theme: q3Theme ?? "unknown",
              question: q3Text,
              answer: a3,
            });
          }
          await saveUserState(state);
          await advanceStage(runtime, state, roomId);
        }
      } catch (err) {
        runtime.logger.error(`[SoulmatesForm] Error advancing flow: ${err}`);
      }
    }
  },
};

const soulmatesCommitmentStartedWorker: TaskWorker = {
  name: "soulmates_commitment_started",
  execute: async (runtime: IAgentRuntime, _options, _task: Task) => {
    runtime.logger.info("[SoulmatesForm] Commitment ask started");
  },
};

const soulmatesCommitmentSubmittedWorker: TaskWorker = {
  name: "soulmates_commitment_submitted",
  execute: async (runtime: IAgentRuntime, options, task: Task) => {
    const submissionValue = options.submission;
    if (!isRecord(submissionValue)) {
      return;
    }

    const values = submissionValue.values;
    if (!isRecord(values)) {
      return;
    }

    const readyToCommit = readString(values, "readyToCommit");
    const hesitation = readString(values, "hesitation");

    const entityId = task.entityId;
    const roomId = task.roomId;

    if (readyToCommit === "yes") {
      runtime.logger.info("[SoulmatesForm] User committed to the process");

      // Advance to availability stage
      if (entityId && roomId) {
        try {
          const { getUserState, advanceStage } = await import(
            "./flow-orchestrator"
          );
          const state = await getUserState(entityId);
          if (state) {
            await advanceStage(runtime, state, roomId);
          }
        } catch (err) {
          runtime.logger.error(`[SoulmatesForm] Error advancing flow: ${err}`);
        }
      }
    } else {
      runtime.logger.info(
        `[SoulmatesForm] User hesitant - reason: "${hesitation}"`,
      );

      // Handle hesitation - go to commitment_retry
      if (entityId && roomId) {
        try {
          const { getUserState, saveUserState, advanceStage } = await import(
            "./flow-orchestrator"
          );
          const state = await getUserState(entityId);
          if (state) {
            state.commitmentAttempts += 1;
            state.stage = "commitment_retry";
            await saveUserState(state);
            // Don't auto-advance - let them respond naturally
          }
        } catch (err) {
          runtime.logger.error(
            `[SoulmatesForm] Error handling commitment hesitation: ${err}`,
          );
        }
      }
    }
  },
};

const soulmatesAvailabilityStartedWorker: TaskWorker = {
  name: "soulmates_availability_started",
  execute: async (runtime: IAgentRuntime, _options, _task: Task) => {
    runtime.logger.info("[SoulmatesForm] Availability capture started");
  },
};

const soulmatesAvailabilitySubmittedWorker: TaskWorker = {
  name: "soulmates_availability_submitted",
  execute: async (runtime: IAgentRuntime, options, task: Task) => {
    const submissionValue = options.submission;
    if (!isRecord(submissionValue)) {
      return;
    }

    const values = submissionValue.values;
    if (!isRecord(values)) {
      return;
    }

    const timeZone = readString(values, "timeZone");
    const preferredDays = readString(values, "preferredDays");
    const preferredTimesRaw = values.preferredTimes;
    const preferredTimes = Array.isArray(preferredTimesRaw)
      ? preferredTimesRaw.filter((t): t is string => typeof t === "string")
      : undefined;
    const meetingCadence = readString(values, "meetingCadence");

    runtime.logger.info(
      `[SoulmatesForm] Availability submitted: ${timeZone}, ${preferredDays}, cadence: ${meetingCadence}`,
    );

    // Update flow state, sync to matching service, and advance to matching queue
    const entityId = task.entityId;
    const roomId = task.roomId;
    if (entityId && roomId) {
      try {
        const { getUserState, saveUserState, advanceStage } = await import(
          "./flow-orchestrator"
        );
        const state = await getUserState(entityId);
        if (state) {
          state.profile.timeZone = timeZone;
          state.profile.preferredDays = preferredDays;
          state.profile.preferredTimes = preferredTimes;
          state.profile.meetingCadence = meetingCadence;
          await saveUserState(state);

          // Sync to matching service so they can be matched
          const matchingService =
            runtime.getService<MatchingService>("SOULMATES_MATCHING");
          if (matchingService) {
            await matchingService.addOrUpdatePersona(entityId, state);
            runtime.logger.info(
              `[SoulmatesForm] User ${entityId} synced to matching service`,
            );
          }

          await advanceStage(runtime, state, roomId);
        }
      } catch (err) {
        runtime.logger.error(`[SoulmatesForm] Error advancing flow: ${err}`);
      }
    }
  },
};

// Legacy workers for backward compatibility
const soulmatesIntakeStartedWorker: TaskWorker = {
  name: "soulmates_intake_started",
  execute: async (runtime: IAgentRuntime, _options, _task: Task) => {
    runtime.logger.info("[SoulmatesForm] Intake session started");
  },
};

const soulmatesIntakeSubmittedWorker: TaskWorker = {
  name: "soulmates_intake_submitted",
  execute: async (runtime: IAgentRuntime, options, _task: Task) => {
    const submissionValue = options.submission;
    if (!isRecord(submissionValue)) {
      runtime.logger.warn("[SoulmatesForm] Submission payload missing");
      return;
    }

    const values = submissionValue.values;
    if (!isRecord(values)) {
      runtime.logger.warn("[SoulmatesForm] Submission values missing");
      return;
    }

    const fullName = readString(values, "fullName") ?? "Unknown";
    const age = readNumber(values, "age");
    const city = readString(values, "city") ?? "Unknown";
    const gender = readString(values, "gender") ?? "Unknown";
    const orientation = readString(values, "orientation") ?? "Unknown";
    const intent = readString(values, "intent") ?? "Unknown";
    const desiredFeeling = readString(values, "desiredFeeling") ?? "Unknown";
    const coreDesire = readString(values, "coreDesire") ?? "Unknown";
    const valuesText = readString(values, "values");
    const dealbreakers = readString(values, "dealbreakers");
    const discoveryQuestionOneText = readString(
      values,
      "discoveryQuestionOneText",
    );
    const discoveryQuestionOneAnswer = readString(
      values,
      "discoveryQuestionOneAnswer",
    );
    const discoveryQuestionTwoText = readString(
      values,
      "discoveryQuestionTwoText",
    );
    const discoveryQuestionTwoAnswer = readString(
      values,
      "discoveryQuestionTwoAnswer",
    );

    const ageText = age ? `${age}` : "Unknown";
    const profileNotes: string[] = [];
    if (valuesText) {
      profileNotes.push(`Values: ${valuesText}`);
    }
    if (dealbreakers) {
      profileNotes.push(`Dealbreakers: ${dealbreakers}`);
    }

    const discoveryEntries = [
      formatDiscoveryEntry(
        discoveryQuestionOneText,
        discoveryQuestionOneAnswer,
      ),
      formatDiscoveryEntry(
        discoveryQuestionTwoText,
        discoveryQuestionTwoAnswer,
      ),
    ].filter((entry): entry is string => Boolean(entry));

    const profileSummary =
      profileNotes.length > 0 ? ` ${profileNotes.join(" | ")}` : "";
    const discoverySummary =
      discoveryEntries.length > 0
        ? ` Discovery: ${discoveryEntries.join(" | ")}`
        : "";

    runtime.logger.info(
      `[SoulmatesForm] Intake submitted for ${fullName} (${ageText}) in ${city}. ${gender}, ${orientation}, ${intent}. Desired feeling: ${desiredFeeling}. Core desire: ${coreDesire}.${profileSummary}${discoverySummary}`,
    );
  },
};

// ============================================================================
// ACTIONS
// ============================================================================

/**
 * Action to start the onboarding flow
 */
const startSoulmatesOnboardingAction: Action = {
  name: "START_SOULMATES_ONBOARDING",
  similes: [
    "START_ORI",
    "BEGIN_ONBOARDING",
    "START_MATCHMAKING",
    "FIND_MATCH",
    "MATCH_ME",
    "FIND_SOULMATE",
    "START_DATING",
    "CONNECT_ME",
  ],
  description: "Start the Soulmates onboarding flow",
  validate: async (_runtime, message) => {
    const text = message.content?.text?.toLowerCase() ?? "";
    return (
      text.includes("match me") ||
      text.includes("find me") ||
      text.includes("find someone") ||
      text.includes("soulmate") ||
      text.includes("start") ||
      text.includes("dating") ||
      text.includes("connect") ||
      text.includes("begin") ||
      text.includes("hello") ||
      text.includes("hi")
    );
  },
  handler: async (runtime, message, _state, _options, callback) => {
    const formService = runtime.getService<FormService>("FORM");
    if (!formService) {
      await callback?.({
        text: "I cannot start right now. Please try again in a moment.",
      });
      return { success: false };
    }

    const entityId = message.entityId;
    const roomId = message.roomId;

    if (!entityId || !roomId) {
      await callback?.({ text: "I could not identify this chat yet." });
      return { success: false };
    }

    const existing = await formService.getActiveSession(entityId, roomId);
    if (existing) {
      await callback?.({
        text: "We're already in the middle of something. Want to continue where we left off?",
      });
      return { success: false };
    }

    // Start with the entry form
    const source = message.content?.source ?? "whatsapp";
    await formService.startSession("soulmates_entry", entityId, roomId, {
      context: { source, stage: "entry" },
    });

    await callback?.({
      text: "Let's begin. What's your name?",
    });

    return { success: true };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Hi" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Let's begin. What's your name?" },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Match me" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Let's begin. What's your name?" },
      },
    ],
  ],
};

/**
 * Action to start the legacy intake form (backward compatibility)
 */
const startSoulmatesIntakeAction: Action = {
  name: "START_SOULMATES_INTAKE",
  similes: ["QUICK_INTAKE"],
  description: "Start the Soulmates quick intake (legacy)",
  validate: async (_runtime, message) => {
    const text = message.content?.text?.toLowerCase() ?? "";
    return text.includes("quick") && text.includes("intake");
  },
  handler: async (runtime, message, _state, _options, callback) => {
    const formService = runtime.getService<FormService>("FORM");
    if (!formService) {
      await callback?.({
        text: "I cannot start the intake right now.",
      });
      return { success: false };
    }

    const entityId = message.entityId;
    const roomId = message.roomId;

    if (!entityId || !roomId) {
      await callback?.({ text: "I could not identify this chat yet." });
      return { success: false };
    }

    const existing = await formService.getActiveSession(entityId, roomId);
    if (existing) {
      await callback?.({
        text: "You already have an intake in progress. Want to continue it?",
      });
      return { success: false };
    }

    const seed = hashStringToSeed(String(entityId));
    const questions = pickDiscoveryQuestions(2, seed);
    const firstQuestion = questions[0] ?? discoveryQuestions[0]!;
    const secondQuestion =
      questions[1] ?? discoveryQuestions[1] ?? discoveryQuestions[0]!;

    const source = message.content?.source ?? "whatsapp";
    await formService.startSession("soulmates_intake", entityId, roomId, {
      context: { source },
      initialValues: {
        discoveryQuestionOneId: firstQuestion.id,
        discoveryQuestionOneTheme: firstQuestion.theme,
        discoveryQuestionOneText: firstQuestion.text,
        discoveryQuestionTwoId: secondQuestion.id,
        discoveryQuestionTwoTheme: secondQuestion.theme,
        discoveryQuestionTwoText: secondQuestion.text,
      },
    });

    await callback?.({
      text: "Let's begin. What's your name?",
    });

    return { success: true };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Quick intake" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Let's begin. What's your name?" },
      },
    ],
  ],
};

// ============================================================================
// PLUGIN
// ============================================================================

async function registerFormsWhenReady(
  runtime: IAgentRuntime,
  retries = 10,
): Promise<void> {
  const formService = runtime.getService<FormService>("FORM");
  if (formService) {
    // Register all stage forms
    formService.registerForm(soulmatesEntryForm);
    formService.registerForm(soulmatesVerificationForm);
    formService.registerForm(soulmatesDeeperForm);
    formService.registerForm(soulmatesValidationForm);
    formService.registerForm(soulmatesProfileForm);
    formService.registerForm(soulmatesDiscoveryForm);
    formService.registerForm(soulmatesCommitmentForm);
    formService.registerForm(soulmatesAvailabilityForm);
    formService.registerForm(soulmatesIntakeForm); // Legacy
    runtime.logger.info("[SoulmatesForm] All onboarding forms registered");
    return;
  }

  if (retries <= 0) {
    runtime.logger.error(
      "[SoulmatesForm] Form service not found after retries",
    );
    return;
  }

  // Wait and retry
  await new Promise((resolve) => setTimeout(resolve, 500));
  return registerFormsWhenReady(runtime, retries - 1);
}

export const soulmatesFormPlugin: Plugin = {
  name: "soulmates-form",
  description: "Soulmates onboarding forms and matchmaking triggers",
  dependencies: ["form"],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    // Register workers immediately (these don't need the service)
    runtime.registerTaskWorker(soulmatesEntryStartedWorker);
    runtime.registerTaskWorker(soulmatesEntrySubmittedWorker);
    runtime.registerTaskWorker(soulmatesVerificationStartedWorker);
    runtime.registerTaskWorker(soulmatesVerificationSubmittedWorker);
    runtime.registerTaskWorker(soulmatesDeeperStartedWorker);
    runtime.registerTaskWorker(soulmatesDeeperSubmittedWorker);
    runtime.registerTaskWorker(soulmatesValidationStartedWorker);
    runtime.registerTaskWorker(soulmatesValidationSubmittedWorker);
    runtime.registerTaskWorker(soulmatesProfileStartedWorker);
    runtime.registerTaskWorker(soulmatesProfileSubmittedWorker);
    runtime.registerTaskWorker(soulmatesDiscoveryStartedWorker);
    runtime.registerTaskWorker(soulmatesDiscoverySubmittedWorker);
    runtime.registerTaskWorker(soulmatesCommitmentStartedWorker);
    runtime.registerTaskWorker(soulmatesCommitmentSubmittedWorker);
    runtime.registerTaskWorker(soulmatesAvailabilityStartedWorker);
    runtime.registerTaskWorker(soulmatesAvailabilitySubmittedWorker);
    runtime.registerTaskWorker(soulmatesIntakeStartedWorker); // Legacy
    runtime.registerTaskWorker(soulmatesIntakeSubmittedWorker); // Legacy

    // Register forms with retry (service may not be ready yet)
    registerFormsWhenReady(runtime).catch((err) => {
      runtime.logger.error(`[SoulmatesForm] Failed to register forms: ${err}`);
    });
  },
  actions: [startSoulmatesOnboardingAction, startSoulmatesIntakeAction],
};

// Export utilities for use by other parts of the system
export {
  generateInsight,
  generateHowWeHelp,
  pickDiscoveryQuestions,
  hashStringToSeed,
  DISCOVERY_QUESTION_COUNT,
  discoveryQuestions,
};

export default soulmatesFormPlugin;
