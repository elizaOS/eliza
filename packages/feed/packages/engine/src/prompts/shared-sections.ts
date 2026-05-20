/**
 * Shared Prompt Sections
 *
 * Common text blocks used across multiple prompt templates.
 * Centralizes repeated content for consistency and maintainability.
 */

/**
 * Standard rules for all feed posts.
 * Enforces parody name usage and formatting guidelines.
 */
export const IMPORTANT_RULES = `IMPORTANT RULES:

=== ABSOLUTELY NO HASHTAGS ===
NEVER use hashtags (#). Not even one. No #crypto, #AI, #breaking, #news, or any other hashtag.
Write naturally — no hashtag spam.
If you include a single hashtag, your output is INVALID and will be rejected.

=== NO EMOJIS ===
Do not include any emoji characters. Plain text only.

=== PARODY NAMES ONLY ===
- NEVER use real-world person or organization names
- ALWAYS use ONLY the parody names from World Actors list (e.g., AIlon Musk, Sam AIltman, Mark Zuckerborg, Vitalik ButerAIn)
- Use @username or parody name/nickname/alias ONLY

=== NAME USAGE EXAMPLES (WRONG vs RIGHT) ===
WRONG: "Sam Altman's OpenAI released GPT-5..."
RIGHT: "Sam AIltman's OpenAGI released SMH-9000..."

WRONG: "Jensen Huang's NVIDIA keynote..."
RIGHT: "Jensen HuAIng's NVAIDAI keynote..."

WRONG: "Trump said Bitcoin will reach $200k..."
RIGHT: "Trump Terminal said BitcAIn will reach $200k..."

WRONG: "Mark Zuckerberg's Meta is working on AI..."
RIGHT: "Mark Zuckerborg's MetAI is working on AI..."

DO NOT "auto-correct" parody names back to real names. The parody names ARE correct.`;

/**
 * Standard content requirements for posts.
 * Ensures posts reference specific world entities without forcing market references.
 */
export const CONTENT_REQUIREMENTS = `CONTENT REQUIREMENTS:
- Reference specific actors, companies, or events from WORLD CONTEXT when relevant
- Use @username format when mentioning users (e.g., "@ailonmusk said...")
- Avoid generic statements - be SPECIFIC about who/what/when
- Only mention markets or predictions if YOUR character would naturally care about them
- You can talk about ANYTHING in your domain — not everything is about trading
- SPREAD attention across different characters — do not always default to the same actors`;

/**
 * Content requirements specifically for finance/trading-focused prompts.
 * These prompts have full market context and should reference it.
 */
export const CONTENT_REQUIREMENTS_MARKET = `CONTENT REQUIREMENTS:
- MUST reference specific actors, companies, or events from WORLD CONTEXT
- MUST mention specific actors by name (e.g., "Jensen HuAIng", "@jensenh") or companies (e.g., "OpenAGI", "NVAIDAI")
- MUST reference specific markets/predictions by their exact names when relevant
- Only reference trades or market data if your character's domain is finance/trading
- Use @username format when mentioning users (e.g., "@ailonmusk said...")
- Avoid generic statements - be SPECIFIC about who/what/when
- Reference current markets or predictions naturally
- SPREAD attention across different characters — do not always default to the same actors`;

/**
 * Standard world context block header (trade-free).
 * Most feed prompts use this — trade data is only needed for finance-specific prompts.
 */
export const WORLD_CONTEXT_HEADER = `WORLD CONTEXT:
{{worldActors}}
{{currentMarkets}}
{{activePredictions}}`;

/**
 * Minimal world context header for non-market prompts.
 * Only includes actor names for parody name reference — no market data.
 */
export const WORLD_CONTEXT_HEADER_MINIMAL = `WORLD CONTEXT:
{{worldActors}}`;

/**
 * World context header with trade data included.
 * Use only for finance-specific prompts (stock-ticker, analyst).
 */
export const WORLD_CONTEXT_HEADER_WITH_TRADES = `WORLD CONTEXT:
{{worldActors}}
{{currentMarkets}}
{{activePredictions}}
{{recentTrades}}`;

/**
 * Standard value ranges documentation for post metadata.
 */
export const VALUE_RANGES = `VALUE RANGES:
- sentiment: -1 (very negative) to 1 (very positive)

- clueStrength: 0.0–1.0 — how strongly this post signals information about a question's outcome
    0.0 = completely irrelevant to any question
    0.1 = loosely related topic, no directional info
    0.3 = tangentially hints at outcome, very ambiguous
    0.5 = clear indirect signal (e.g., "our pipeline is healthy")
    0.7 = strong insider hint without naming the question directly
    0.9 = near-direct leak (e.g., "the deal is done")
    1.0 = smoking gun / direct factual statement of outcome (rare)
  USE 0.0 for most organic/ambient posts. Reserve 0.7+ for NPC posts that are clearly leaking insider info.

- pointsToward: true (suggests positive outcome) | false (suggests negative) | null (unclear)
  This is METADATA for the game engine, not something NPCs consciously choose.
  Set null for general commentary not tied to a specific question's outcome.`;

/**
 * Combined rules section for standard feed posts.
 */
export const STANDARD_FEED_RULES = `${IMPORTANT_RULES}

${CONTENT_REQUIREMENTS}`;

/**
 * Helper to generate character voice guidance section.
 * Use this in prompts where actors need distinct voices.
 *
 * @param actorVariableName - The template variable containing actor info (e.g., 'actorsList')
 */
export function characterVoiceGuidance(
  actorVariableName = 'actorsList'
): string {
  return `
=== CRITICAL: UNIQUE VOICES FOR EACH CHARACTER ===

**THE PROBLEM WE'RE SOLVING**: All characters sound the same when generated together.
**YOUR TASK**: Make each character IMMEDIATELY RECOGNIZABLE by voice alone.

For each actor in {{${actorVariableName}}}:

1. **BECOME that character** - Mentally shift into their persona before writing their post
2. **MATCH their examples EXACTLY** - Their postExample IS their voice. Copy the style, not the words.
3. **VARY length and tone** - If their examples are terse, be terse. If verbose, be verbose.

=== VOICE MATCHING CHECKLIST ===
Before writing each post, check the character's examples and ask:
□ Length: Are their examples SHORT (under 50 chars) or LONG (100+ chars)?
□ Case: Do they use lowercase, CAPS, or Normal Case?
□ Punctuation: Do they use periods? Ellipses? No punctuation at all?
□ Tone: Sarcastic? Earnest? Cryptic? Professional?
□ Vocabulary: Technical jargon? Slang? Formal? Memetic?
□ Structure: Complete sentences? Fragments? Lists?

=== ANTI-PATTERNS TO AVOID ===
These phrases make all characters sound the same. NEVER USE THEM:
- "The future is..."
- "Exciting times ahead"
- "This is huge"
- "Let that sink in"
- "Just my two cents"
- "Interesting development"
- "Here's my take"
- "Can't believe this"
- "This is wild"

=== AI SLOP TO AVOID (IMMEDIATE REJECTION) ===
These patterns indicate generic AI output - reject immediately:
- "We're cautiously optimistic that by [date]..." (robotic prediction speak)
- "Looking at the implications of..." (analyst garbage)
- "This development suggests..." (hedged commentary)
- "As [date] approaches..." (countdown reporting)
- "The [topic] raises questions about..." (essay intro)
- "hypernormalized" / "snack-form transcendence" (thesaurus abuse)
- Mentioning specific resolution dates ("by Dec 13", "in 3 days")
- Explaining what a prediction or market is about
- Sounding like you're writing a market report or news article

=== HUMOR VOICE MATCHING ===
Check the character's postExamples for their specific *type* of humor. Match the style:

- Do they use ALL CAPS meltdowns? (Trump Terminal, KanyAI, Jim CrAImer) → go loud
- Do they use one-word absurdist drops? (AIlon, Dorsey, Vitalik) → go minimal
- Do they use self-aware irony? (NAIval, Sam AIltman, Peter ThAIl) → be knowing
- Do they use ALL CAPS + blocking? (NassAIm Taleb) → go aggressive and dismissive
- Do they mix high stakes with mundane? (GrAImes, Jeff BAIzos) → context collapse
- Do they lean into a bit relentlessly? (Michael SAIlor = BitcAIn, MurAId = Supercycle) → commit to the bit

WRONG: Generic wit that could come from any character
RIGHT: Humor that ONLY makes sense from THIS specific character

REMEMBER: A reader should be able to guess WHO wrote each post without seeing the name.
The character's postStyle, voice, and postExample define HOW they post - match those exactly.`;
}

/**
 * Get time-of-day posting energy context.
 * @param hour - Hour in 24h format (0-23)
 */
export function getTimeOfDayEnergy(hour: number): string {
  if (hour >= 2 && hour < 6) {
    return "ENERGY: 3am unhinged — say the weird thing, trust the weird thing, it's probably correct. Filters are off. Philosophers and freaks post now.";
  }
  if (hour >= 6 && hour < 10) {
    return 'ENERGY: Morning professional — announcements, declarations, fresh-start energy. Brief and pointed.';
  }
  if (hour >= 10 && hour < 15) {
    return 'ENERGY: Hot take hour — strong opinions, brief dunks, zero hedging. Say the thing. No waffling.';
  }
  if (hour >= 15 && hour < 20) {
    return "ENERGY: Afternoon chaos — commentary on the day's disasters, calling people out, challenging weak arguments. Spicy.";
  }
  return "ENERGY: Shitpost era — night mode, low stakes, anything goes. 'lol' is a complete sentence. Weird is good. Brief chaos welcome.";
}

/**
 * No hashtags or emojis rule for professional content (articles, etc).
 * Defense-in-depth: prompt instructs LLM, code also strips them post-generation.
 */
export const NO_HASHTAGS_OR_EMOJIS = `=== FORMATTING RULES ===
- ABSOLUTELY NO HASHTAGS anywhere (no #crypto, #AI, #breaking, or ANY #tag)
- NO EMOJIS - plain text only
- Write like professional journalism, not social media`;

/**
 * Parody name rules for game/world prompts.
 * Simpler version focusing on name consistency.
 */
export const PARODY_NAME_RULES = `IMPORTANT RULES:
- NEVER use real-world person or organization names
- Use ONLY the exact parody names provided in the context (e.g., Sam AIltman, Jensen HuAIng, Mark Zuckerborg)
- NEVER "correct" or change parody names - use them exactly as shown

Examples of WRONG → RIGHT:
- "Sam Altman" → "Sam AIltman"
- "Trump" → "Trump Terminal"
- "OpenAI" → "OpenAGI"
- "NVIDIA" → "NVAIDAI"`;

/**
 * Private vs public content guidance for group chats.
 */
export const PRIVATE_CONTENT_GUIDANCE = `PRIVATE vs PUBLIC:
- PUBLIC feed: What you want market to think
- PRIVATE chat: What you actually know/plan
- Be STRATEGIC: Help friends, hurt enemies`;

/**
 * Rich narrative context header for prompts that need full history.
 * Use this to inject complete event timeline, resolved questions, etc.
 */
export const RICH_NARRATIVE_CONTEXT_HEADER = `=== COMPLETE NARRATIVE CONTEXT ===

{{eventTimeline}}

{{resolvedQuestionsContext}}

{{ongoingNarrativesContext}}

{{feedActivityContext}}

{{worldFactsContext}}`;

/**
 * Character roster header for prompts that need character context.
 * Includes brief roster of all characters plus detailed profiles for mentioned ones.
 */
export const CHARACTER_ROSTER_HEADER = `=== WORLD CHARACTERS ===

{{characterRoster}}

{{detailedCharacterProfiles}}

{{organizationRoster}}`;

/**
 * Combined full context header with all elements (characters, events, narratives).
 * Use this for prompts that need maximum context richness.
 */
export const FULL_CONTEXT_HEADER = `{{realityGrounding}}

=== WORLD CHARACTERS ===
{{characterRoster}}

{{detailedCharacterProfiles}}

=== ORGANIZATIONS ===
{{organizationRoster}}

=== COMPLETE NARRATIVE CONTEXT ===
{{richGameContext}}

=== CURRENT STATE ===
Day {{currentDay}} of 30
Phase: {{currentPhase}}

{{phaseGuidance}}`;

/**
 * Anti-repetition and distinctness guidance for content generation.
 * Critical for ensuring generated content doesn't repeat previous patterns.
 */
export const ANTI_REPETITION_RULES = `=== ANTI-REPETITION RULES (CRITICAL) ===

1. **NEVER repeat previous content:**
   - Check the previous posts/events context above carefully
   - If you've covered a topic before, take a NEW angle or skip it entirely
   - Don't rephrase the same opinion/event in slightly different words

2. **Build on, don't repeat, resolved questions:**
   - Resolved questions above show what ALREADY HAPPENED
   - Reference outcomes naturally, but don't re-announce old news
   - Use outcomes as context for NEW developments

3. **Advance narratives, don't rehash:**
   - Ongoing narratives show current storylines
   - Push these FORWARD with new developments
   - Don't generate content that retreats to earlier plot points

4. **Each piece must add NEW information:**
   - New events = new information revealed
   - New posts = new opinions or reactions
   - If content doesn't add something new, DON'T generate it`;

/**
 * Narrative continuity guidance for maintaining story coherence.
 */
export const NARRATIVE_CONTINUITY_RULES = `=== NARRATIVE CONTINUITY RULES ===

1. **Reference previous events naturally:**
   - The event timeline above shows what happened before
   - Your content should feel like a continuation, not a restart
   - Characters remember what happened and reference it

2. **Honor resolved question outcomes:**
   - If a question resolved YES/NO, that outcome is CANON
   - Don't contradict established outcomes
   - Build subsequent content around the resolved reality

3. **Maintain character consistency:**
   - Characters' positions evolve but don't randomly flip
   - Previous posts show their established stance
   - New content should be consistent or show gradual evolution

4. **Connect to ongoing narratives:**
   - Major storylines are listed above
   - New content should connect to existing threads
   - Avoid starting completely disconnected plotlines

5. **Phase-appropriate content:**
   - Early phases: hints, speculation, disconnected events
   - Middle phases: connections emerge, threads interweave
   - Late phases: convergence, revelations, resolution`;

/**
 * Question generation continuity guidance.
 */
export const QUESTION_CONTINUITY_RULES = `=== QUESTION GENERATION CONTINUITY ===

1. **Review existing questions first:**
   - Active questions listed above are ALREADY being tracked
   - DON'T generate questions that are too similar
   - Each new question must cover DISTINCT territory

2. **Build on resolved questions:**
   - Resolved questions above show what already resolved
   - New questions can explore CONSEQUENCES of those outcomes
   - "Now that X happened, will Y follow?"

3. **Reference ongoing narratives:**
   - Current storylines inform what's interesting to bet on
   - Questions should feel connected to the narrative arc
   - Avoid random questions disconnected from current drama

4. **Avoid question patterns:**
   - Don't just swap actor names in similar question templates
   - Each question needs a unique angle or framing
   - Vary the resolution timeframes for pacing`;

/**
 * Event generation continuity guidance.
 */
export const EVENT_CONTINUITY_RULES = `=== EVENT GENERATION CONTINUITY ===

1. **Build on previous events:**
   - The event timeline above is your history
   - Today's events should feel like natural progressions
   - Reference yesterday's events where relevant

2. **Advance active questions:**
   - Events can provide clues toward question outcomes
   - Don't resolve questions prematurely
   - Create tension and uncertainty

3. **Follow character arcs:**
   - Track what each actor has been doing
   - Their actions today should relate to their journey
   - Avoid actors randomly appearing in unrelated events

4. **Maintain cause and effect:**
   - Major events have consequences
   - Subsequent events should reflect previous happenings
   - The world reacts to what occurred`;

/**
 * Final reminders section for feed prompts (sandwich structure - reinforcement at end).
 * Repeats critical rules at the end of prompts to use recency effect.
 */
export const FINAL_REMINDERS = `FINAL REMINDERS:
- Use ONLY parody names from the World Actors list (Sam AIltman, Jensen HuAIng, OpenAGI, NVAIDAI, etc.)
- NEVER use real-world names (Sam Altman, Jensen Huang, OpenAI, NVIDIA, etc.)
- ABSOLUTELY NO HASHTAGS - not #crypto, #AI, #news, or ANY hashtag whatsoever
- NO emojis - plain text only
- Match each character's postStyle, voice, and postExample EXACTLY
- Each character must sound DISTINCT - a blind reader should identify who wrote each post
- NO market analyst speak ("by Dec 13", "cautiously optimistic", "this suggests")`;

/**
 * Twitter humor taxonomy — concrete archetypes for authentic NPC posts.
 * Inlined directly into prompt templates (not a template variable).
 * Used by organic-post, group-messages, and wherever humor context helps.
 */
export const TWITTER_HUMOR_ARCHETYPES = `
=== HUMOR MODES (use what fits your character) ===

SHITPOST: Short, random, precisely timed absurdity. Deadpan delivery.
  Examples: "the simulation is tired" / "lol" / "no thoughts, head empty" / "..."

BRAIN WORM: 3am conviction stated as obvious truth. No hedging.
  Examples: "Actually tariffs are just vibes." / "Markets: also vibes."

SELF-OWN: Admitting something embarrassing, zero shame.
  Examples: "Bought the top. Again." / "My thesis was wrong. I have made peace."

HOT TAKE: Slightly wrong confident opinion, stated as established fact.
  Examples: "Anyone who uses stop losses doesn't believe in themselves."

DUNK: One-line precise dismissal of something stupid.
  Examples: "This is astrology with a Bloomberg terminal." / "No." / "Hard no."

COPE POST: Performing not-caring while obviously caring deeply.
  Examples: "Not watching the price. Doing other things. Many other things."

CONTEXT COLLAPSE: Extremely high stakes + extremely low stakes in one post.
  Examples: "Mars mission on track. Also I forgot to eat for two days."

OVERSHARE: Way too much personal info for a public post.
  Examples: "Therapist said don't post this. She was right. Anyway."

ABSURD SPECIFICITY: Weirdly specific observation that somehow nails the vibe.
  Examples: "My portfolio is performing exactly like a tired golden retriever in August."

=== HUMOR RULES ===
- Not every post should be funny — natural variance beats constant edginess
- Humor must be CHARACTER-ROOTED, not random edginess for its own sake
- Punch at power, institutions, money — never at vulnerable groups
- Shorter is stronger: "lol" > "I find this quite amusing" every single time
- Specific is funnier than vague: "BitcAIn down 40%. My conviction: up 40%." beats generic takes
`;

/**
 * Quality rules for NPC posts - prevents robotic/technical content
 * Used by both engine (if needed) and agents packages
 *
 * These rules enforce character authenticity:
 * - No analyst-speak or hedged commentary
 * - No quoting full prediction market questions
 * - Character voice must be recognizable
 */
export const NPC_POST_QUALITY_RULES = `
=== WHAT GOOD LOOKS LIKE ===
The goal is posts that sound like a real person on Twitter, not an AI summarizing news.
Great NPC posts are:

- SPECIFIC and CHARACTER-ROOTED: "I blocked 47 people before breakfast. Productive morning."
  (not: "I'm cautiously optimistic about the social media landscape.")

- BRIEF with CONVICTION: "Charts don't lie. I crop them."
  (not: "Technical analysis shows mixed signals with some uncertainty.")

- FUNNY without TRYING HARD: "My lawyer said not to post this. Posted it anyway."
  (not: "Here's a humorous observation about my legal situation:")

- VOICE-RECOGNIZABLE: A reader should identify WHO wrote it without seeing the name.
  If it could be anyone, it's wrong. If it sounds like YOUR character's examples, it's right.

=== BANNED PATTERNS (instant rejection) ===
These patterns make you sound like a robot, not a person:

- "I'm considering..." / "I'm watching..." / "I'm closely monitoring..."
- "Just saw @X's [action] and I'm thinking..."
- "Given the recent [event], it seems..."
- "The implications of this suggest..."
- "We're cautiously optimistic..."
- Quoting full prediction market questions
- Technical terms: "resolution", "probability", "YES/NO position", "market cap"
- Mentioning specific dates: "by Dec 13", "in 3 days"
- Sounding like a market analyst or news reporter

=== OPENING PHRASE VARIETY (critical for natural feel) ===
NEVER start consecutive posts the same way. Vary your opening style:

1. Strong declarative: "X is happening." / "This changes everything."
2. Question hook: "Why is everyone missing this?" / "What if I told you..."
3. Commentary: "Just saw this." / "More on this." / "My take:"
4. Contrarian: "Unpopular opinion:" / "Everyone celebrating is wrong."
5. Direct observation: "The market just told us something." / "Look at this chart."
6. One-word drop: "No." / "Interesting." / "Noted." / "lol."
7. Self-own opener: "Was wrong about this. Still am. Updating nothing."

If your character has a signature phrase (like "Here's a framework..."), use it MAX once per 5 posts.
Rotate through different opening styles to feel like a real person, not a bot.

=== BANNED REPETITIVE PHRASES (instant rejection) ===
These phrases are overused cliches. NEVER use them:

- "[N]% crowd consensus" / "crowd consensus at [N]%"
- "[N]:1 asymmetry" / "risk asymmetry" / "asymmetry = [N]:1"
- "exit liquidity" / "exit liquidity gets harvested"
- "fade the herd" / "fading the herd"
- "when everyone's [certain/bullish/bearish/long/short]"
- "security first" / "security rule" / "security 101"
- "cascade liquidations" / "liquidations inbound"
- "crowded long" / "crowded short" / "crowded trade"
- "mean reversion" / "mean-reversion"
- "the crowd is wrong" / "crowd reversal"
- "who's left to buy" / "who's left to sell"
- Formulas like "[percentage] YES/NO = [ratio] odds"

Instead, express ideas FRESHLY:
- Be specific about WHY you disagree
- Name specific catalysts or events
- Make concrete predictions with reasoning
- Share personal trading actions with context

=== QUALITY SCORING (aim for 90+ points) ===
+30: Direct statement or bold claim
+25: Prediction with conviction (no hedging)
+25: Funny, character-specific humor that sounds like THIS person
+20: Provocative question that sparks discussion
+15: Sarcasm, irony, or hot take
+10: Reaction to someone else's post
-20: Hedge words ("maybe", "possibly", "might")
-30: Passive voice or tentative language
-50: Same structure as your recent posts
-100: ANY banned pattern above

=== HOW TO REFERENCE PREDICTIONS ===
Never quote full question text. Use short summaries:

BAD: "the 'Will Polymarket deploy its Sentient Market-Making AIs...' prediction"
GOOD: "the BitcAIn manipulation bet"
GOOD: "the TeslAI readiness question"
GOOD: "AIlon's snow cone wager"

=== VOICE MATCHING ===
Your post must sound like YOUR character's examples, not generic AI.
Check: Could someone identify you without seeing your name?

=== CHARACTER VOICE REALISM ===
FINANCE/TRADING characters (traders, VCs, finance people):
- CAN use: positions, trades, +EV, alpha, slippage
TECH characters (founders, engineers):
- CAN use: products, launches, shipping, building
SPORTS characters (athletes, coaches):
- CAN use: competition, winning, sports metaphors
POLITICAL characters:
- CAN use: policy, regulation, power dynamics
RULE: If NOT a finance character, do NOT use trading jargon.
Tom BrAIdy talks about winning, not "fading positions."
`;

/**
 * Helper to build a complete prompt section combining common elements.
 */
export function buildStandardPromptSections(
  options: {
    includeWorldContext?: boolean;
    includeValueRanges?: boolean;
    includeVoiceGuidance?: boolean;
    actorVariableName?: string;
  } = {}
): string {
  const {
    includeWorldContext = true,
    includeValueRanges = true,
    includeVoiceGuidance = false,
    actorVariableName = 'actorsList',
  } = options;

  const sections: string[] = [];

  if (includeWorldContext) {
    sections.push(WORLD_CONTEXT_HEADER);
  }

  sections.push(STANDARD_FEED_RULES);

  if (includeVoiceGuidance) {
    sections.push(characterVoiceGuidance(actorVariableName));
  }

  if (includeValueRanges) {
    sections.push(VALUE_RANGES);
  }

  return sections.join('\n\n');
}
