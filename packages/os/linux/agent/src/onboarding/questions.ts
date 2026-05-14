// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Conversational onboarding script — the "Her" film's opening cadence,
 * adapted for a usbeliza first-boot session.
 *
 * Locked decision: setup is a chat. No wizards, no popups, no separate
 * UI. Eliza herself conducts the conversation from the very first turn,
 * running on the bundled Eliza-1 0.8B baseline — no network, no cloud,
 * no Claude/Codex needed to get started. Everything that *would* be a
 * settings panel in another OS is instead a topic Eliza can talk about
 * and act on through the existing intent system (`network`, persistence,
 * model picker, etc.).
 *
 * The script below is intentionally short and warm. Each question takes
 * one chat turn; the answers populate `~/.eliza/calibration.toml`. After
 * the last question Eliza offers (but does not force) the optional
 * follow-ups: connect Wi-Fi, set up encrypted persistence, link cloud
 * accounts. The user can also skip any prompt with "skip" or change
 * focus mid-flow with intents like "build me a calendar" — the
 * onboarding state pauses and resumes.
 */

import type { CalibrationBlock } from "../persona.ts";

/** One step in the conversational onboarding ladder. */
export interface OnboardingQuestion {
    /** Stable identifier — also the key in the persisted partial calibration. */
    readonly id: keyof CalibrationBlock;
    /** What Eliza says to elicit the answer. */
    readonly prompt: string;
    /** Optional follow-up sentence when the user gives a one-word answer. */
    readonly follow?: string;
    /**
     * Parse the user's reply into the calibration value. Returns
     * `undefined` if the answer is ambiguous — the dispatcher will
     * re-ask with a clarifying hint.
     */
    readonly parse: (reply: string) => CalibrationBlock[OnboardingQuestion["id"]] | undefined;
    /**
     * Optional clarifying re-ask shown when `parse` returns undefined.
     * Helps the user understand what kind of answer fits. Defaults to
     * just repeating the prompt verbatim.
     */
    readonly clarify?: string;
}

const oneOf = (reply: string, ...options: string[]): string | undefined => {
    const norm = reply.trim().toLowerCase();
    for (const o of options) {
        if (norm.includes(o)) return o;
    }
    return undefined;
};

/**
 * Map a user's free-text language/locale answer to a glibc LANG string.
 * Accepts common English names ("english", "spanish") and short codes
 * ("en", "es", "de"). Returns `undefined` for anything unrecognized so
 * the dispatcher re-asks once before falling back to the skip default.
 *
 * Curated list — covers the languages with full glibc UTF-8 locales
 * shipped in the live ISO's `locales` package. Adding a language is a
 * one-line entry here plus a `locale-gen` line in the chroot recipe.
 */
function parseLanguage(reply: string): string | undefined {
    const norm = reply.trim().toLowerCase();
    if (norm === "") return undefined;
    // Direct locale string passes through as-is (en_US.UTF-8 etc.).
    if (/^[a-z]{2,3}_[A-Z]{2}(\.[\w-]+)?$/i.test(reply.trim())) {
        return reply.trim();
    }
    const table: Record<string, string> = {
        english: "en_US.UTF-8",
        en: "en_US.UTF-8",
        "en-us": "en_US.UTF-8",
        "en-gb": "en_GB.UTF-8",
        british: "en_GB.UTF-8",
        spanish: "es_ES.UTF-8",
        español: "es_ES.UTF-8",
        es: "es_ES.UTF-8",
        french: "fr_FR.UTF-8",
        français: "fr_FR.UTF-8",
        francais: "fr_FR.UTF-8",
        fr: "fr_FR.UTF-8",
        german: "de_DE.UTF-8",
        deutsch: "de_DE.UTF-8",
        de: "de_DE.UTF-8",
        italian: "it_IT.UTF-8",
        italiano: "it_IT.UTF-8",
        it: "it_IT.UTF-8",
        portuguese: "pt_PT.UTF-8",
        português: "pt_PT.UTF-8",
        portugues: "pt_PT.UTF-8",
        pt: "pt_PT.UTF-8",
        japanese: "ja_JP.UTF-8",
        日本語: "ja_JP.UTF-8",
        ja: "ja_JP.UTF-8",
        chinese: "zh_CN.UTF-8",
        中文: "zh_CN.UTF-8",
        zh: "zh_CN.UTF-8",
        korean: "ko_KR.UTF-8",
        한국어: "ko_KR.UTF-8",
        ko: "ko_KR.UTF-8",
        russian: "ru_RU.UTF-8",
        русский: "ru_RU.UTF-8",
        ru: "ru_RU.UTF-8",
        dutch: "nl_NL.UTF-8",
        nederlands: "nl_NL.UTF-8",
        nl: "nl_NL.UTF-8",
        polish: "pl_PL.UTF-8",
        polski: "pl_PL.UTF-8",
        pl: "pl_PL.UTF-8",
        swedish: "sv_SE.UTF-8",
        svenska: "sv_SE.UTF-8",
        sv: "sv_SE.UTF-8",
    };
    return table[norm];
}

/**
 * Map a user's free-text timezone answer to an IANA tz string. Accepts
 * IANA strings directly (`America/Los_Angeles`, `Europe/Berlin`), common
 * military/civilian abbreviations (`UTC`, `PST`, `EST`, `CET`), casual
 * phrases ("pacific time", "eastern"), bare city names ("tokyo", "los
 * angeles"), and natural phrasings ("I'm in london", "im from nyc").
 * Returns `undefined` for anything we can't confidently map.
 *
 * Algorithm:
 *   1. If already canonical IANA (strict: `Region/City_With_Underscore`) → pass through.
 *   2. Replace spaces after a slash with underscores ("America/Los Angeles" →
 *      "America/Los_Angeles") and re-check strict IANA.
 *   3. Lowercase, strip natural-language prefixes ("i'm in ", "im from ",
 *      "i live in ", "i'm at "), strip trailing " time" / " timezone".
 *   4. Look up in the extended abbrev/city table.
 *   5. If input is a single token, title-case and look up again as a city.
 *   6. Else undefined.
 *
 * Exported for unit tests — the dispatcher reaches this through the
 * QUESTIONS[].parse callback, never directly.
 */
export function parseTimezone(reply: string): string | undefined {
    const trimmed = reply.trim();
    if (trimmed === "") return undefined;
    // 1. Strict canonical IANA: "America/Los_Angeles", "Europe/Berlin",
    //    "Asia/Tokyo". One slash, region capitalised, city capitalised
    //    with underscores for spaces. Matches timedatectl's accepted form.
    const STRICT_IANA = /^[A-Z][A-Za-z]+\/[A-Z][A-Za-z_]+$/;
    if (STRICT_IANA.test(trimmed)) return trimmed;

    // 2. Tolerate a space-after-slash typo ("America/Los Angeles" → underscore).
    if (trimmed.includes("/")) {
        const withUnderscore = trimmed.replace(/\/([^/]+)$/, (_m, rest: string) =>
            `/${rest.replace(/\s+/g, "_")}`,
        );
        if (STRICT_IANA.test(withUnderscore)) return withUnderscore;
    }

    // 3. Normalise casual phrasings. Lowercase, strip prefixes / suffixes.
    let norm = trimmed.toLowerCase();
    norm = norm.replace(
        /^(i\s*'?\s*m\s+in\s+|im\s+in\s+|im\s+from\s+|i\s*'?\s*m\s+from\s+|i\s+live\s+in\s+|i\s*'?\s*m\s+at\s+)/,
        "",
    );
    norm = norm.replace(/\s+(time|timezone)$/, "");
    norm = norm.trim();
    if (norm === "") return undefined;

    // 4. Extended abbreviation + city table. Keys are all lowercase,
    //    spaces preserved (so "los angeles" matches the post-strip form).
    const table: Record<string, string> = {
        // Coordinated universal time.
        utc: "UTC",
        gmt: "UTC",
        z: "UTC",
        // North American zone abbreviations + zone names.
        pst: "America/Los_Angeles",
        pdt: "America/Los_Angeles",
        pt: "America/Los_Angeles",
        pacific: "America/Los_Angeles",
        mst: "America/Denver",
        mdt: "America/Denver",
        mt: "America/Denver",
        mountain: "America/Denver",
        cst: "America/Chicago",
        cdt: "America/Chicago",
        ct: "America/Chicago",
        central: "America/Chicago",
        est: "America/New_York",
        edt: "America/New_York",
        et: "America/New_York",
        eastern: "America/New_York",
        // European zone abbreviations.
        cet: "Europe/Berlin",
        cest: "Europe/Berlin",
        bst: "Europe/London",
        // Asia/Pacific abbreviations.
        jst: "Asia/Tokyo",
        aest: "Australia/Sydney",
        ist: "Asia/Kolkata",
        // City names — match what users actually type. Multi-word
        // entries include the space form so post-strip lookup hits.
        "new york": "America/New_York",
        "new york city": "America/New_York",
        nyc: "America/New_York",
        "los angeles": "America/Los_Angeles",
        la: "America/Los_Angeles",
        chicago: "America/Chicago",
        denver: "America/Denver",
        london: "Europe/London",
        berlin: "Europe/Berlin",
        paris: "Europe/Paris",
        amsterdam: "Europe/Amsterdam",
        madrid: "Europe/Madrid",
        rome: "Europe/Rome",
        moscow: "Europe/Moscow",
        tokyo: "Asia/Tokyo",
        sydney: "Australia/Sydney",
        mumbai: "Asia/Kolkata",
        delhi: "Asia/Kolkata",
        kolkata: "Asia/Kolkata",
        beijing: "Asia/Shanghai",
        shanghai: "Asia/Shanghai",
        "hong kong": "Asia/Hong_Kong",
        singapore: "Asia/Singapore",
        seoul: "Asia/Seoul",
        dubai: "Asia/Dubai",
        toronto: "America/Toronto",
        vancouver: "America/Vancouver",
        "sao paulo": "America/Sao_Paulo",
        "são paulo": "America/Sao_Paulo",
        "mexico city": "America/Mexico_City",
    };
    const direct = table[norm];
    if (direct !== undefined) return direct;

    // 5. Strip trailing affirmation/filler words ("los angeles yeah",
    //    "tokyo please", "nyc thanks") and retry the table lookup. Users
    //    often append a conversational confirmation after the real
    //    answer; we drop those so the parser stays liberal.
    const AFFIRMATIONS = [
        "thank you",
        "yeah",
        "yes",
        "yep",
        "sure",
        "please",
        "thanks",
        "correct",
        "right",
        "cool",
        "bet",
        "ok",
        "okay",
    ];
    let stripped = norm;
    let changed = true;
    while (changed) {
        changed = false;
        for (const word of AFFIRMATIONS) {
            const suffix = ` ${word}`;
            if (stripped.endsWith(suffix)) {
                stripped = stripped.slice(0, -suffix.length).trim();
                changed = true;
                break;
            }
        }
    }
    if (stripped !== norm && stripped !== "") {
        const retry = table[stripped];
        if (retry !== undefined) return retry;
    }
    return undefined;
}

/**
 * Keyboard layout parser — passes through anything that looks like a
 * valid `localectl` keymap name (lowercase, optionally with a country
 * suffix like `us-intl`, `de-nodeadkeys`). Translates common english
 * names like "qwerty" / "german" to their layout codes.
 */
function parseKeyboardLayout(reply: string): string | undefined {
    const trimmed = reply.trim();
    if (trimmed === "") return undefined;
    const norm = trimmed.toLowerCase();
    // Direct keymap pass-through ("us", "us-intl", "de-nodeadkeys"). We
    // accept anything 2-32 chars matching [a-z0-9-] — broad to avoid
    // gating on a stale internal list.
    if (/^[a-z][a-z0-9-]{0,31}$/.test(norm) && !/\s/.test(trimmed)) {
        return TRANSLATE_KEYBOARD[norm] ?? norm;
    }
    return TRANSLATE_KEYBOARD[norm];
}

const TRANSLATE_KEYBOARD: Record<string, string> = {
    qwerty: "us",
    american: "us",
    english: "us",
    british: "gb",
    uk: "gb",
    german: "de",
    deutsch: "de",
    french: "fr",
    français: "fr",
    francais: "fr",
    spanish: "es",
    español: "es",
    italian: "it",
    italiano: "it",
    dvorak: "dvorak",
    colemak: "us-colemak",
    japanese: "jp",
    russian: "ru",
};

/**
 * Yes/no parser shared by the wifi + claude offer questions. Liberal:
 * accepts "yes" / "yeah" / "sure" / "ok" / "do it" / "connect" / "wifi"
 * for accept; "no" / "nope" / "skip" / "later" / "stay offline" / "stay
 * local" for decline. Returns undefined for ambiguous so the dispatcher
 * re-asks with the question's clarify text.
 */
function parseOffer(reply: string): boolean | undefined {
    const norm = reply.trim().toLowerCase();
    if (norm === "") return undefined;
    if (
        /^(y|yes|yeah|yep|yup|sure|ok|okay|please|let'?s|go|do it|connect|wifi|sign in|log in|login)/.test(
            norm,
        )
    ) {
        return true;
    }
    if (
        /^(n|no|nope|nah|not now|later|skip|stay (offline|local)|local|offline|maybe later)/.test(
            norm,
        )
    ) {
        return false;
    }
    return undefined;
}

/**
 * The three onboarding questions, in order:
 *
 *   1. name                       — what Eliza calls the user
 *   2. claudeOfferAccepted        — offer to sign into Claude (triggers
 *                                   the multi-turn claude-flow on yes;
 *                                   user pastes the auth code in chat)
 *   3. buildIntent                — freeform "what do you want me to
 *                                   build first?" — answer auto-routes
 *                                   to the BUILD_APP action so the
 *                                   first app appears immediately after
 *                                   onboarding completes
 *
 * Trimmed from the v35 ten-question flow by user request 2026-05-13:
 * the language / timezone / chronotype / etc questions were a slog for
 * the first 30 seconds of using the OS. Locale gets a sensible default
 * (en_US.UTF-8 / UTC); the user can ask Eliza to change either later.
 *
 * Wi-Fi was also dropped from onboarding — accessible from chat any
 * time via "connect to wifi" (multi-turn picker flow). Most users boot
 * on ethernet anyway and the wifi prompt during onboarding just slowed
 * everyone else down.
 *
 * Adding/removing a question is a breaking change for the persisted
 * `~/.eliza/calibration.toml` — older multi-field calibration files
 * still parse because every non-name field is optional.
 */
export const QUESTIONS: readonly OnboardingQuestion[] = [
    {
        id: "name",
        prompt: "Hi. I'm Eliza. What should I call you?",
        parse: (reply: string) => {
            // Anything reasonable — trim, cap length, reject empty.
            const text = reply.trim().replace(/^[\W_]+|[\W_]+$/g, "");
            if (text.length === 0 || text.length > 64) return undefined;
            return text;
        },
        clarify: "Just a name or a handle — whatever you'd like me to use.",
    },
    {
        id: "claudeOfferAccepted",
        prompt:
            "Want to sign into Claude? It's the difference between me writing " +
            "apps you'll actually use and me writing apps that mostly work. " +
            "I'll open a browser; you log in there, then paste the code back here. " +
            "Or skip and stay on the local model — that's fine too.",
        parse: parseOffer,
        clarify: "Yes to sign in, no to stay local-only. Up to you.",
    },
    {
        id: "buildIntent",
        prompt:
            "Last question. What do you want me to build first? Could be a clock, " +
            "a notes app, a calculator, a calendar — whatever feels useful. " +
            "Or say \"nothing yet\" and we can just chat.",
        parse: (reply: string) => {
            const text = reply.trim();
            if (text.length === 0 || text.length > 256) return undefined;
            return text;
        },
        clarify:
            "Just describe one thing in a sentence — e.g. \"a sticky-notes app\" " +
            "or \"a timer\". Say \"nothing yet\" to skip.",
    },
] as const;
// Silence the unused-import lints for now — the heavy parsers
// (timezone, language, keyboard) stay imported because the calibration
// schema still tolerates them in older files we may load.
void parseKeyboardLayout;
void parseLanguage;
void parseTimezone;
void oneOf;

/**
 * Build the warm completion message after the last calibration question.
 * Reads the user's calibration answers and tailors the response — name +
 * a contextual first-thing-to-do drawn from `workFocus`. No bullet lists,
 * no menu of commands. Eliza just continues the conversation.
 *
 * Mirrors the Her film's hand-off: after Samantha's setup, she says
 * something specific to Theodore — references his answers, suggests one
 * gentle next step. Multi-step setup happens later, conversationally.
 */
export function completionMessage(answers: Partial<CalibrationBlock>): string {
    const name = typeof answers.name === "string" ? answers.name : "there";
    const intent = typeof answers.buildIntent === "string" ? answers.buildIntent.trim() : "";
    const intentLower = intent.toLowerCase();
    const skipped =
        intentLower === "" ||
        /^(nothing|skip|later|nah|no|none|nope|not now|not yet|nope nothing|nothing yet)\b/.test(
            intentLower,
        );

    if (skipped) {
        // No build requested. Open-ended invitation — chat is the desktop.
        return `OK, ${name}. Ready when you are. Say "build me X" anytime — a clock, a notes app, anything you can think of — and I'll make it.`;
    }

    // Build IS in flight (the dispatcher fired BUILD_APP async). Frame the
    // wait time honestly so the user doesn't wonder if it's stuck:
    // claude-codegen runs ~20-60s with claude signed in, ~2-5 min on the
    // local 1B if not.
    //
    // Don't try to grammar-fix the user's phrasing — they already said
    // "a clock" or "calendar" or "build me a notes app"; we strip the
    // leading "build me" / "make me" if they used it but otherwise
    // leave the words alone. The slug for "open <thing>" is the last
    // meaningful word so they don't have to remember articles.
    const cleanedIntent =
        intent.replace(/^(build me|make me|build|make)\s+/i, "").trim() || intent;
    const lastWord =
        cleanedIntent
            .split(/\s+/)
            .filter((w) => w.length > 0 && !/^(a|an|the|some|me|my)$/i.test(w))
            .pop() ?? cleanedIntent;
    return (
        `OK, ${name}. I'm building ${cleanedIntent} now — should take ` +
        `about 30 seconds. When it's ready, say "open ${lastWord}" ` +
        `and I'll pop it open. Anything else you want to chat about while I work?`
    );
}

/**
 * @deprecated Use `completionMessage(answers)` instead. Kept as a
 * fallback so the dispatcher's defensive path (calibration written but
 * answers map empty) still emits a sane string.
 */
export const ONBOARDING_COMPLETE_MESSAGE = completionMessage({});

/**
 * The pre-onboarding greeting shown when the user types anything at all
 * before answering the first question. Mirrors the Her opening beat.
 * The local model never sees this — we render it deterministically so
 * first-boot latency is single-digit milliseconds.
 */
export const ONBOARDING_GREETING = QUESTIONS[0]?.prompt ?? "Hi.";
