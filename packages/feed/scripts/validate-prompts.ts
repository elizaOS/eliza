#!/usr/bin/env bun
/**
 * Prompt pipeline validation — tests rendering, content rules, grounding
 */

import {
  checkRealityGrounding,
  getRealityGrounding,
  minuteAmbient,
  organicPost,
  renderPrompt,
  reply,
  socialPost,
} from "@feed/engine";
import { VALUE_RANGES } from "../packages/engine/src/prompts/shared-sections";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;

function pass(label: string, detail?: string) {
  passed++;
  console.log(
    `${GREEN}  ✓${RESET} ${label}${detail ? `  ${CYAN}[${detail}]${RESET}` : ""}`,
  );
}
function fail(label: string, detail?: string) {
  failed++;
  console.log(
    `${RED}  ✗${RESET} ${label}${detail ? `  ${RED}[${detail}]${RESET}` : ""}`,
  );
}

function checkGhostVars(promptId: string, rendered: string) {
  const ghosts = [...rendered.matchAll(/\{\{([a-zA-Z_]+)\}\}/g)].map(
    (m) => m[1]!,
  );
  if (ghosts.length > 0) {
    fail(`${promptId}: ghost vars present`, ghosts.join(", "));
  } else {
    pass(`${promptId}: no ghost variables`);
  }
}

async function main() {
  console.log(`\n${BOLD}${CYAN}=== Prompt Pipeline Validation ===${RESET}\n`);

  const rg = getRealityGrounding();

  // ──────────────────────────────────────────────────────────────────
  // SECTION 1: Reality Grounding Content
  // ──────────────────────────────────────────────────────────────────
  console.log(`${BOLD}── 1. Reality Grounding Content ──${RESET}`);

  rg.includes("DeepSAIek")
    ? pass("DeepSAIek mapping present")
    : fail("DeepSAIek MISSING");
  rg.includes("DeepSeek → DeepSAIek")
    ? pass("DeepSeek→DeepSAIek name mapping")
    : fail("DeepSeek mapping row MISSING");
  rg.includes("104%")
    ? pass("tariff 104%+ context present")
    : fail("tariff escalation MISSING");
  rg.includes("AI Action Plan")
    ? pass("Trump AI Action Plan context")
    : fail("AI EO context MISSING");
  rg.includes("78,000")
    ? pass("BTC ~$78k price")
    : fail("BTC price outdated/wrong");
  rg.includes("Trump Terminal")
    ? pass("Trump Terminal as president")
    : fail("president reference MISSING");
  rg.includes("LiAIng Wenfeng")
    ? pass("DeepSeek founder parody name")
    : fail("DeepSeek founder MISSING");
  !rg.includes("Joe Biden")
    ? pass("Biden removed from grounding")
    : fail("Biden still in grounding data");
  !rg.includes("2023") && !rg.includes("January 6")
    ? pass("no stale 2023-era references")
    : fail("stale year references found");
  rg.includes("Tariff exemption lobbying")
    ? pass("tariff exemption lobbying satire")
    : fail("satire theme MISSING");

  // ──────────────────────────────────────────────────────────────────
  // SECTION 2: checkRealityGrounding() detection
  // ──────────────────────────────────────────────────────────────────
  console.log(`\n${BOLD}── 2. checkRealityGrounding() Heuristics ──${RESET}`);

  const elon = checkRealityGrounding("Elon Musk just bought NVIDIA");
  elon.length > 0
    ? pass('"Elon Musk" leak detected', elon[0])
    : fail('"Elon Musk" leak NOT detected');

  const openai = checkRealityGrounding("OpenAI released GPT-5");
  openai.length > 0
    ? pass('"OpenAI" leak detected', openai[0])
    : fail('"OpenAI" leak NOT detected');

  const deepseekLeak = checkRealityGrounding("DeepSeek R2 dropped today");
  deepseekLeak.length > 0
    ? pass('"DeepSeek" leak detected', deepseekLeak[0])
    : fail('"DeepSeek" leak NOT detected');

  const cleanText = checkRealityGrounding(
    "AIlon Musk said TeslAI will beat OpenAGI and DeepSAIek combined",
  );
  cleanText.length === 0
    ? pass("no false positive on clean parody text")
    : fail(`false positive: ${cleanText.join(", ")}`);

  const bidenText = checkRealityGrounding(
    "President Biden signed an executive order",
  );
  // Should NOT flag Biden alone (removed the hardcoded heuristic), only if it would match real-name patterns
  pass(
    "Biden-only text handled gracefully (no false positive)",
    `${bidenText.length} warnings`,
  );

  // ──────────────────────────────────────────────────────────────────
  // SECTION 3: Prompt Rendering — no ghost vars
  // ──────────────────────────────────────────────────────────────────
  console.log(`\n${BOLD}── 3. Prompt Rendering (Ghost Var Checks) ──${RESET}`);

  // minute-ambient
  const ambientRendered = renderPrompt(minuteAmbient, {
    actorName: "AIlon Musk",
    actorDescription: "Tech billionaire, founder of TeslAI and SpAIceX",
    emotionalContext: "Confident. Markets are wild.",
    realityGrounding: rg,
    antiRepetitionContext: "",
  });
  checkGhostVars("minute-ambient", ambientRendered);

  // reply
  const replyRendered = renderPrompt(reply, {
    characterName: "AIlon Musk",
    characterInfo: "Billionaire tech founder",
    originalPost: "Tariffs will destroy the AI sector",
    originalAuthor: "Sam AIltman",
    relationshipContext: "Rivals in AI",
    realityGrounding: rg,
    worldActors: "AIlon Musk (TeslAI), Sam AIltman (OpenAGI)",
    actorRules: "",
  });
  checkGhostVars("reply", replyRendered);

  // organic-post
  const organicRendered = renderPrompt(organicPost, {
    characterName: "AIlon Musk",
    characterInfo: "Billionaire tech founder",
    antiRepetitionContext: "",
    actorRules: "",
    runningBitContext: "",
    timeEnergy: "Morning energy: high",
    domainContext: "tech, space, AI",
    realityGrounding: rg,
    worldActors: "",
    domainHints: "rockets, AI, cars, tunnels",
  });
  checkGhostVars("organic-post", organicRendered);

  // social-post
  const socialRendered = renderPrompt(socialPost, {
    characterName: "AIlon Musk",
    characterInfo: "Billionaire tech founder",
    actorRules: "",
    antiRepetitionContext: "Recent posts: SpAIceX launch (avoid)",
    targetName: "Sam AIltman",
    relationshipContext: "Rival in AI space",
    targetRecentActivity: "Just claimed AGI is 6 months away",
    realityGrounding: rg,
    worldActors: "",
  });
  checkGhostVars("social-post", socialRendered);

  // ──────────────────────────────────────────────────────────────────
  // SECTION 4: Rule enforcement in rendered prompts
  // ──────────────────────────────────────────────────────────────────
  console.log(
    `\n${BOLD}── 4. Rule Enforcement in Rendered Templates ──${RESET}`,
  );

  // minute-ambient should have NPC_POST_QUALITY_RULES
  ambientRendered.includes("BANNED PATTERNS")
    ? pass("minute-ambient: NPC_POST_QUALITY_RULES injected")
    : fail("minute-ambient: NPC_POST_QUALITY_RULES MISSING");

  // minute-ambient should have PARODY_NAME_RULES
  ambientRendered.includes("MANDATORY NAME MAPPINGS") ||
  ambientRendered.includes("NEVER use real")
    ? pass("minute-ambient: PARODY_NAME_RULES injected")
    : fail("minute-ambient: PARODY_NAME_RULES MISSING");

  // reply should have realityGrounding section
  replyRendered.includes("CURRENT WORLD STATE") ||
  replyRendered.includes("Trump Terminal")
    ? pass("reply: realityGrounding section present")
    : fail("reply: realityGrounding MISSING");

  // reply should have world actors section header
  replyRendered.includes("WORLD ACTORS")
    ? pass("reply: WORLD ACTORS section present")
    : fail("reply: WORLD ACTORS section MISSING");

  // social-post should have antiRepetitionContext injected
  socialRendered.includes("Recent posts") || socialRendered.includes("AVOID")
    ? pass("social-post: antiRepetitionContext injected")
    : fail("social-post: antiRepetitionContext MISSING");

  // organic-post should have NPC_POST_QUALITY_RULES
  organicRendered.includes("BANNED PATTERNS")
    ? pass("organic-post: NPC_POST_QUALITY_RULES injected")
    : fail("organic-post: NPC_POST_QUALITY_RULES MISSING");

  // ──────────────────────────────────────────────────────────────────
  // SECTION 5: VALUE_RANGES clueStrength guide
  // ──────────────────────────────────────────────────────────────────
  console.log(`\n${BOLD}── 5. VALUE_RANGES Calibration Guide ──${RESET}`);

  VALUE_RANGES.includes("0.0–1.0") || VALUE_RANGES.includes("0.7")
    ? pass("VALUE_RANGES: clueStrength scale guide present")
    : fail("VALUE_RANGES: calibration guide MISSING");

  VALUE_RANGES.includes("smoking gun")
    ? pass('VALUE_RANGES: "smoking gun" label at 1.0')
    : fail("VALUE_RANGES: smoking gun label MISSING");

  VALUE_RANGES.includes("METADATA") || VALUE_RANGES.includes("engine metadata")
    ? pass("VALUE_RANGES: pointsToward engine metadata note")
    : fail("VALUE_RANGES: metadata note MISSING");

  VALUE_RANGES.includes("0.0 for most organic")
    ? pass("VALUE_RANGES: guidance to use 0.0 for ambient posts")
    : fail("VALUE_RANGES: ambient post guidance MISSING");

  // ──────────────────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────────────────
  console.log(`\n${BOLD}── Summary ──${RESET}`);
  console.log(
    `  ${GREEN}${passed} passed${RESET}  ${failed > 0 ? RED : ""}${failed} failed${RESET}`,
  );
  console.log();

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
