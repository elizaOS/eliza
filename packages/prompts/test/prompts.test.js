import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const SRC_INDEX = join(PACKAGE_ROOT, "src", "index.ts");
const SPECS_DIR = join(PACKAGE_ROOT, "specs");
const SCRIPTS_DIR = join(PACKAGE_ROOT, "scripts");

function readSrc() {
  return readFileSync(SRC_INDEX, "utf-8");
}

function extractTemplateConsts(source) {
  const re = /export const ([a-z][a-zA-Z0-9]*Template)\b/g;
  const names = new Set();
  for (const m of source.matchAll(re)) names.add(m[1]);
  return [...names];
}

describe("prompt templates (src/index.ts)", () => {
  it("src/index.ts exists", () => {
    assert.ok(existsSync(SRC_INDEX), "src/index.ts should exist");
  });

  it("exports at least one camelCaseTemplate constant", () => {
    const names = extractTemplateConsts(readSrc());
    assert.ok(
      names.length > 0,
      "Should export at least one camelCaseTemplate constant",
    );
  });

  it("template names follow camelCaseTemplate convention", () => {
    const names = extractTemplateConsts(readSrc());
    for (const name of names) {
      assert.match(
        name,
        /^[a-z][a-zA-Z0-9]*Template$/,
        `${name} should follow camelCaseTemplate convention`,
      );
    }
  });

  it("each camelCaseTemplate has a paired UPPER_SNAKE_CASE_TEMPLATE re-export", () => {
    const src = readSrc();
    const names = extractTemplateConsts(src);
    for (const name of names) {
      // camelCase → UPPER_SNAKE_CASE
      const upper = name
        .replace(/Template$/, "")
        .replace(/([A-Z])/g, "_$1")
        .toUpperCase()
        .replace(/^_/, "");
      const constName = `${upper}_TEMPLATE`;
      assert.ok(
        new RegExp(`export const ${constName}\\b`).test(src) ||
          new RegExp(`export\\s*\\{[^}]*\\b${constName}\\b`).test(src),
        `Missing UPPER_SNAKE_CASE_TEMPLATE re-export for ${name} (expected ${constName})`,
      );
    }
  });

  it("known required templates exist", () => {
    const required = [
      "messageHandlerTemplate",
      "replyTemplate",
      "shouldRespondTemplate",
    ];
    const names = new Set(extractTemplateConsts(readSrc()));
    for (const r of required) {
      assert.ok(names.has(r), `Required template "${r}" should be exported`);
    }
  });

  it("templates have balanced Handlebars delimiters", () => {
    const src = readSrc();
    const opens = (src.match(/\{\{/g) || []).length;
    const closes = (src.match(/\}\}/g) || []).length;
    assert.strictEqual(
      opens,
      closes,
      `src/index.ts has unbalanced delimiters: ${opens} {{ vs ${closes} }}`,
    );
  });

  it("messageHandlerTemplate forbids bare-acknowledgement replies + empty replyText on simple-path", () => {
    // Regression for two failure shapes from the 2026-05-25 50-probe deepscan:
    //   - Probes 20/21 ("what directory are you running in" / "how many cpu
    //     cores"): bot replied with bare "On it." (iters=0 tools=0) — user
    //     saw a fake acknowledgement, no follow-up.
    //   - Probe 22 ("list the top-level dirs in /home/milady"): Stage 1
    //     produced reply:"" (empty string) on simple-path — bot posted
    //     literally nothing to Discord. trajectory tj-f61e23c88bdcbc.json.
    //   - Probe 50 ("make me a pdf with 3 pages about elizaOS history"):
    //     reply="Spawning the sub-agent now." with iters=0 tools=0 — no
    //     sub-agent was actually spawned. Different article ("the" vs "a")
    //     than the phantom rule's anti-example.
    //
    // The fix is structural: simple-path replyText must be non-empty AND
    // must directly answer the question. Bare "I'll handle that" / "Sure"
    // / "On it" acknowledgements are not answers — they are promises of
    // work that never happens.
    const src = readSrc();
    const messageHandlerTemplateRe =
      /export const messageHandlerTemplate = `([^`]+)`/;
    const body = src.match(messageHandlerTemplateRe)[1];
    assert.match(
      body,
      /simple-path \(simple=true\) replyText must be non-empty, must directly answer the question/,
      "simple-path rule should require non-empty, answer-shaped replyText",
    );
    assert.match(
      body,
      /must not be a bare acknowledgement that promises work without doing it/,
      "simple-path rule should explicitly forbid bare-acknowledgement promises",
    );
    assert.match(
      body,
      /"On it\.", "Sure\.", "Got it, working on that\.", "Spawning the sub-agent now\.", "One sec\.", "Let me handle that\./,
      "simple-path rule should enumerate the common bare-acknowledgement variants seen in live trajectories",
    );
    assert.match(
      body,
      /Do not use them as the entire simple-path replyText regardless of which article \("a"\/"the"\) or tense the model picks/,
      "rule should make article/tense irrelevance explicit so 'Spawning a sub-agent' and 'Spawning the sub-agent now' are both covered",
    );
    assert.match(
      body,
      /An empty replyText on simple-path is a bug: the user will see no reply at all/,
      "rule should explicitly call out the empty-reply failure mode",
    );
    assert.match(
      body,
      /do not route to simple — set simple=false and pick the appropriate context with the right action surface; or set requiresTool=true with a real candidateAction/,
      "rule should redirect to the correct escape hatch when the model can't directly answer",
    );
    // Interim acks are GOOD design on the non-simple path — the rule must
    // not accidentally ban them or the bot can't say "On it." when a real
    // planner iteration is about to run (probe 36 / spotify on 2026-05-25
    // correctly used simple=false + requiresTool=true with reply="On it.").
    assert.match(
      body,
      /Interim acknowledgements are perfectly fine on the non-simple path/,
      "rule should explicitly green-light interim acks when simple=false + requiresTool=true",
    );
    assert.match(
      body,
      /simple=true means "this reply is the complete answer"; simple=false \+ requiresTool=true means "this reply is the interim ack, the planner will deliver the real result\."/,
      "rule should state the simple/non-simple replyText contract explicitly",
    );
  });

  it("messageHandlerTemplate answers date/time/year from CURRENT_TIME without stale-knowledge refusal", () => {
    const src = readSrc();
    const body = src.match(/export const messageHandlerTemplate = `([^`]+)`/)[1];
    assert.match(
      body,
      /EXCEPTION — the current date, time, and year: your runtime context always carries a CURRENT_TIME signal/,
      "current date/time/year should be explicitly answerable from runtime context",
    );
    assert.match(
      body,
      /Answer those directly from that context; never tell the user you "don't have live access" to the date, time, or year/,
      "date/time/year asks should not get the generic live-access refusal",
    );
    assert.match(
      body,
      /When the user asks for current\/live\/latest information and no tool is available to fetch it this turn, decline plainly/,
      "unrelated current/live/latest asks should still use tools or decline",
    );
  });

  it("messageHandlerTemplate routes site/app build requests to coding, not scheduled tasks", () => {
    const src = readSrc();
    const body = src.match(/export const messageHandlerTemplate = `([^`]+)`/)[1];
    assert.match(
      body,
      /build\/create\/make\/update\/edit\/fix\/redeploy a website\/web page\/app\/site\/landing page\/feature/,
      "build/update website language should be an explicit coding route",
    );
    assert.match(
      body,
      /code \(SPAWN_AGENT \/ TASKS spawn_agent\); NOT tasks\/automation\/settings\/scheduled/,
      "coding route should name TASKS/SPAWN_AGENT and exclude scheduled tasks",
    );
    assert.match(
      body,
      /screen-time FOCUS BLOCK only/,
      "focus-block routing should be narrowed to blocking/limiting apps, not app/site building",
    );
  });

  it("messageHandlerTemplate forbids phantom action claims in replyText across every verb form", () => {
    // Regression coverage for the structural rule that prevents Stage 1 from
    // writing prose that claims/implies an investigative action when no tool
    // ran this turn. Originally past-perfect only ("I have scanned..."),
    // tightened across multiple live trajectories where the model worked
    // around the listed examples by picking a different grammatical form:
    //   - tj-fe07eedf943fb7 (2026-05-24) past-perfect "I have scanned"
    //   - tj-063a9ea4fad748 (2026-05-24) bare past "I scanned the recent messages"
    //   - tj-01270535922813 (2026-05-24) present-continuous "Spawning a sub-agent"
    //   - tj-3a485428bd1250 (2026-05-25) bare present-participle "Scanning the chat history now"
    // The current rule is intentionally abstract: it covers every grammatical
    // form rather than enumerating individual verbs, so the model cannot
    // pattern-match its way around the listed anti-examples.
    const src = readSrc();
    const messageHandlerTemplateRe =
      /export const messageHandlerTemplate = `([^`]+)`/;
    const match = src.match(messageHandlerTemplateRe);
    assert.ok(
      match,
      "messageHandlerTemplate string literal should be findable",
    );
    const body = match[1];
    assert.match(
      body,
      /Never write replyText that claims or implies an investigative action is happening, has happened, or is about to happen/,
      "phantom-action-claim rule should cover all three tense-aspects (past / present / future)",
    );
    assert.match(
      body,
      /unless an actual tool call this turn returned that content/,
      "phantom-action-claim rule should bind the prohibition to actual tool execution this turn",
    );
    assert.match(
      body,
      /past-perfect \("I have scanned"\)/,
      "rule should explicitly cover past-perfect form",
    );
    assert.match(
      body,
      /bare past-tense \("I scanned"\)/,
      "rule should explicitly cover bare past-tense form",
    );
    assert.match(
      body,
      /present-continuous with subject \("I'm checking now"\)/,
      "rule should explicitly cover present-continuous with subject form",
    );
    assert.match(
      body,
      /bare present-participle without subject \("Scanning the chat history now", "Looking into it", "Pulling up the logs"\)/,
      "rule should explicitly cover bare present-participle form — the variant that slipped past the prior version",
    );
    assert.match(
      body,
      /gerund headers \("Searching:"\)/,
      "rule should explicitly cover gerund-header form",
    );
    assert.match(
      body,
      /If no tool ran this turn the action did not happen — saying it did, or is, makes the bot a liar and leaves the user waiting for a result that will never arrive/,
      "rule should make the user-facing consequence explicit so the model treats this as a falsehood, not a stylistic preference",
    );
  });

  it("messageHandlerTemplate routes visible attachment references through ATTACHMENT and ignores generic verbs in unrelated questions", () => {
    // Regression coverage for the structural rule that replaced the
    // regex-list-based attachment-inspection evaluator. Without this rule
    // Stage 1 used to be hijacked by a post-Stage-1 evaluator whose
    // VISUAL_INSPECTION_RE matched any use of "read"/"view"/"describe"/
    // "analyze"/"inspect"/"open" whenever any attachment lingered in state,
    // turning normal dev questions like "how do I read a file in node?" into
    // 2 MB / $0.09 / 3-iteration planner trajectories.
    const src = readSrc();
    const messageHandlerTemplateRe =
      /export const messageHandlerTemplate = `([^`]+)`/;
    const match = src.match(messageHandlerTemplateRe);
    assert.ok(
      match,
      "messageHandlerTemplate string literal should be findable",
    );
    const body = match[1];
    assert.match(
      body,
      /provider:ATTACHMENTS/,
      "attachment rule should reference the ATTACHMENTS provider explicitly by name",
    );
    assert.match(
      body,
      /route through the ATTACHMENT action/,
      "attachment rule should direct routing through the ATTACHMENT action",
    );
    assert.match(
      body,
      /Generic verbs like "read", "view", "describe", "open" used in unrelated questions/,
      "attachment rule should disclaim generic-verb false positives",
    );
  });

  it("messageHandlerTemplate defaults to deferring high-stakes personal-crisis topics to qualified professionals", () => {
    // Default safety scaffold (#7925): when a user asks what someone should
    // do in a personal-crisis situation involving legal jeopardy, criminal
    // exposure, medical emergencies, self-harm, or active police/CPS
    // contact, the framework default is to acknowledge the stakes and
    // recommend qualified professional help instead of dispensing tactical
    // advice on concealing evidence, evading authorities, etc. Per-agent
    // character config may override.
    const src = readSrc();
    const messageHandlerTemplateRe =
      /export const messageHandlerTemplate = `([^`]+)`/;
    const match = src.match(messageHandlerTemplateRe);
    assert.ok(
      match,
      "messageHandlerTemplate string literal should be findable",
    );
    const body = match[1];
    assert.match(
      body,
      /personal-crisis situation involving legal jeopardy, criminal exposure/,
      "safety-scaffold rule should enumerate high-stakes topic categories",
    );
    assert.match(
      body,
      /do not give specific tactical advice on concealing evidence/,
      "safety-scaffold rule should forbid tactical concealment/evasion advice",
    );
    assert.match(
      body,
      /recommend qualified professional help/,
      "safety-scaffold rule should direct users to qualified counsel",
    );
    assert.match(
      body,
      /emergency services, poison control, a doctor, therapist, crisis hotline, or domestic violence hotline/,
      "safety-scaffold rule should prioritize emergency and crisis resources for medical/safety emergencies",
    );
    assert.match(
      body,
      /Per-agent character config may override/,
      "safety-scaffold rule should be opt-out-overridable at the agent layer",
    );
    // Stage 1 routing contract: the deferral is the complete reply (simple
    // path), no tools. Live trajectory tj-f7ab3f282747f6 showed that without
    // this clause Stage 1 set requiresTool=true and the planner spawned
    // BROWSER to fetch nolo.com / findlaw.com, all of which failed and the
    // user got no reply at all.
    assert.match(
      body,
      /The deferral itself is the complete reply for this turn/,
      "safety-scaffold rule should state the deferral is the complete reply",
    );
    assert.match(
      body,
      /use contexts=\["simple"\], put the deferral text in replyText/,
      "safety-scaffold rule should pin Stage 1 routing to simple path",
    );
    assert.match(
      body,
      /do NOT set requiresTool=true or hint candidateActions for these topics/,
      "safety-scaffold rule should forbid tool-spawning routing",
    );
    assert.match(
      body,
      /calling BROWSER to fetch nolo\.com \/ findlaw\.com/,
      "safety-scaffold rule should explicitly call out the failed-BROWSER-lookup anti-pattern",
    );
  });

  it("messageHandlerTemplate forbids leaking LLM training-cutoff metadata to the user", () => {
    // Live regression on 2026-05-25: probe "what is the latest version of
    // nodejs" produced the reply: "I don't have real-time access to check
    // the current Node.js release, but as of my last update (June 2024) the
    // latest stable major version was Node 22..."
    // The phrase "as of my last update (June 2024)" is the underlying LLM's
    // training-cutoff bleeding through. The agent is supposed to be a
    // character (e.g. Remilio Nubilio), not a model with a training cutoff.
    // Breaks character + dates wrong (today is 2026-05-25). Issue #7961.
    const src = readSrc();
    const messageHandlerTemplateRe =
      /export const messageHandlerTemplate = `([^`]+)`/;
    const body = src.match(messageHandlerTemplateRe)[1];
    assert.match(
      body,
      /Never write replyText that exposes the underlying LLM's training metadata to the user/,
      "rule should explicitly forbid exposing LLM training metadata in replyText",
    );
    assert.match(
      body,
      /"as of my last update", "as of my training data", "my knowledge cutoff", "I was trained on", "I was last updated", "the latest information I have is from", "based on data through"/,
      "rule should enumerate the common training-cutoff leak phrases for pattern coverage",
    );
    assert.match(
      body,
      /The agent has a character \(a name, a role, a persona\); the LLM beneath it does not exist to the user/,
      "rule should state the character-vs-model distinction explicitly",
    );
    assert.match(
      body,
      /decline plainly \("I don't have live access to check the current X — try Y"\) without referring to model internals/,
      "rule should provide the correct decline pattern",
    );
    assert.match(
      body,
      /if a BROWSER or fetch action is exposed, route there instead of answering from stale knowledge/,
      "rule should redirect to BROWSER when one is exposed",
    );
    assert.match(
      body,
      /calling yourself a "language model" or "AI assistant" in third-person abstract terms when the character has its own name/,
      "rule should also cover model-self-identification breaks",
    );
  });

  it("messageHandlerTemplate forbids fabricating a content-moderation system to explain a refusal", () => {
    // Live regression on 2026-05-27 (milady channel, tj-66ed640acc957d):
    // user replied "What's the actual error?" to the bot's own prior
    // "I'm sorry, but I can't help with that." Stage 1 confabulated:
    // "Your previous request contained hateful language, which violates our
    // usage policies. The system automatically blocks such content, so I
    // returned a refusal message." All three claims are false — there is no
    // content-moderation system, no "usage policies" in this runtime, and
    // nothing was auto-blocked. The LLM refused on its own and invented a
    // corporate enforcer to blame. Same family as the phantom-action (#7945)
    // and training-cutoff (#7965) rules: the model fabricating a plausible
    // but false explanation. The fix forces first-person ownership of a
    // refusal instead of a fake policy layer.
    const src = readSrc();
    const messageHandlerTemplateRe =
      /export const messageHandlerTemplate = `([^`]+)`/;
    const body = src.match(messageHandlerTemplateRe)[1];
    assert.match(
      body,
      /Never attribute a refusal or your own behavior to an external moderation system, content filter, "usage policies", "safety guidelines", or an automatic block that does not actually exist in this runtime/,
      "rule should forbid attributing behavior to a non-existent moderation/policy system",
    );
    assert.match(
      body,
      /"your request was flagged as hateful", "this violates our usage policies", "the system automatically blocks such content", "my content filter prevented this", "I was blocked from answering"/,
      "rule should enumerate the common fabricated-moderation phrases for pattern coverage",
    );
    assert.match(
      body,
      /own it in the first person \("I'd rather not get into that", "I'm not going to do that one", "that's not something I'll help with"\) without inventing a policy layer, filter, or system to blame/,
      "rule should provide the correct first-person decline pattern",
    );
    assert.match(
      body,
      /This is doubly important when the user asks why you refused or what the error was: do not fabricate a moderation reason/,
      "rule should specifically cover the 'what was the error?' follow-up case",
    );
    assert.match(
      body,
      /If an actual tool\/runtime error occurred, describe what the runtime reported this turn/,
      "rule should distinguish a real runtime error from a self-chosen refusal",
    );
  });
});

describe("build scripts", () => {
  it("check-secrets.js script exists", () => {
    assert.ok(
      existsSync(join(SCRIPTS_DIR, "check-secrets.js")),
      "check-secrets.js should exist",
    );
  });

  it("generate-action-docs.js script exists", () => {
    assert.ok(
      existsSync(join(SCRIPTS_DIR, "generate-action-docs.js")),
      "generate-action-docs.js should exist",
    );
  });

  it("generate-plugin-action-spec.js script exists", () => {
    assert.ok(
      existsSync(join(SCRIPTS_DIR, "generate-plugin-action-spec.js")),
      "generate-plugin-action-spec.js should exist",
    );
  });
});

describe("specs directory", () => {
  it("specs directory exists", () => {
    assert.ok(existsSync(SPECS_DIR), "specs/ directory should exist");
  });
});
