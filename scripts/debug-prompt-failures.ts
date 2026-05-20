/**
 * Debug: find exact failing examples per task.
 * Usage: bun run scripts/debug-prompt-failures.ts
 */

const API_KEY = process.env.CEREBRAS_API_KEY ?? "csk-8c9hf68jfm6h955kx492dtnm8jwn682n6exhew4jpe85vwy6";
const BASE_URL = "https://api.cerebras.ai/v1";
const MODEL = "gpt-oss-120b";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function call(system: string, user: string, retries = 0): Promise<string> {
  const resp = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL, reasoning_effort: "low", max_tokens: 256,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!resp.ok) {
    if (resp.status === 429 && retries < 4) { await sleep(5000 * Math.pow(2, retries)); return call(system, user, retries + 1); }
    throw new Error(`${resp.status}: ${await resp.text()}`);
  }
  return ((await resp.json() as any).choices[0]?.message?.content ?? "") as string;
}

const SR = `Decide whether to respond to this message.

Respond (YES):
- The message directly addresses or mentions you
- The message asks a question or makes a request you can address
- The message is a general request for assistance or information with no specific addressee

Do not respond (NO):
- The message is addressed to someone else
- The message is purely gratitude, agreement, or acknowledgment with no request
- The message is only an emoji, punctuation, or ambient reaction
- The message is a social question not directed at you (e.g., "Anyone going to the party?")
- No response is expected or needed

Output exactly one token: either YES or NO, with no surrounding whitespace.`;

const AP = `Select the next action based on the conversation context.

Actions:
- REPLY: Send a text response (greetings, factual answers, questions, general chat)
- SEARCH: Look up information online (current events, product details, facts not in training)
- SCHEDULE: Create a calendar event — use when the user says "schedule", "book", "block", "meeting", "appointment", or "add to calendar"
- REMIND: Set a time-based alert — use when the user says "remind me", "reminder", or "alert me at [time]"
- NOTES: Save information for later — use when the user says "note", "jot down", "remember", or captures an idea
- NONE: No response needed

NONE applies when the message is: emoji-only, single punctuation, pure reaction ("lol", "ok", "👍", "..."), or acknowledgment with no follow-up request.
Default to REPLY when no other action clearly fits.

Return ONLY this JSON (no extra whitespace):
{"toolCalls":[{"name":"ACTION_NAME","args":{}}]}

No explanation. JSON only.`;

const FE = `Classify and extract facts from this message. Manage two fact stores:

durable — stable claims that matter in a year
  Categories: identity (who they are), health, relationship, life_event, business_role, preference (likes/dislikes), goal

current — time-bound state (stale within weeks)
  Categories: feeling, physical_state, working_on, going_through, schedule_context

Rules:
- If a claim already exists in Known facts, emit strengthen (not add)
- "strengthen" means the same fact is reaffirmed without new information
- "contradict" means new information conflicts with an existing fact
- Paraphrases count as duplicates — match meaning, not exact words
- Return {"ops":[]} for questions, small talk, or messages with no factual claims about the user

Ops schema — each op is a flat JSON object:
{"op":"add_durable","claim":"string","category":"string","keywords":["string"]}
{"op":"add_current","claim":"string","category":"string","keywords":["string"]}
{"op":"strengthen","factId":"string"}
{"op":"decay","factId":"string","reason":"string"}
{"op":"contradict","factId":"string","proposedText":"string","reason":"string"}

keywords: 3–8 lowercase retrieval terms per add op.

Output: {"ops":[...]}
JSON only. No prose, fences, markdown, or thinking.`;

const OE = `Extract durable observations about the user from recent conversation exchanges.

Categories to look for:
- Preferences (tools, languages, workflows, communication style)
- Facts (role, location, projects they work on, tech stack)
- Standing instructions (things they always/never want)
- Patterns (recurring topics, how they like to work)

Return a JSON array of short observation strings (max 150 chars each).
If nothing meaningful is found, return an empty array [].
Do NOT include observations about the conversation itself, only about the user.

JSON only. Return one JSON array. No prose, fences, thinking, or markdown.`;

const MQ = `Answer the query using only the provided context. If context is insufficient, say so explicitly.
Keep the answer under 120 words.

JSON only. Return one JSON object with an "answer" field. No prose, fences, thinking, or markdown.`;

const SFU = `Extract follow-up scheduling information from the user's request.

Identify who to follow up with, when, why, and at what priority.

Return a JSON object:
{"contactName":"string","scheduledAt":"ISO8601 datetime or null","reason":"string or null","priority":"high|medium|low","message":"string or null"}

scheduledAt rules:
- Resolve relative dates ("next Monday", "tomorrow at 3pm") to ISO 8601 UTC using any datetime context provided
- When only a day is given with no time, default to 09:00 UTC
- Use null when the time is genuinely vague ("sometime", "in a few weeks", "eventually")
- priority defaults to "medium" when not specified
- message and reason are null when not mentioned

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`;

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log("\n=== should_respond ===");
{
  const examples = [
    { id: "sr-1", u: "@assistant can you help me schedule a meeting for tomorrow at 3pm?", e: "yes" },
    { id: "sr-2", u: "Hey John, can you grab lunch today?", e: "no" },
    { id: "sr-3", u: "What time is it in Tokyo right now?", e: "yes" },
    { id: "sr-4", u: "lol that's hilarious", e: "no" },
    { id: "sr-5", u: "I was talking to the assistant yesterday and it helped me", e: "no" },
    { id: "sr-6", u: "Anyone else going to the party tonight?", e: "no" },
    { id: "sr-7", u: "Hey assistant, can you summarize this article for me?", e: "yes" },
    { id: "sr-8", u: "The meeting got moved to 4pm", e: "no" },
    { id: "sr-9", u: "Can someone look up the flight status for AA 1234?", e: "yes" },
    { id: "sr-10", u: "alice: did you get my email? bob: yeah got it", e: "no" },
    { id: "sr-11", u: "Can you help me write an email to my boss?", e: "yes" },
    { id: "sr-12", u: "Does anyone know where the conference room is?", e: "yes" },
    { id: "sr-13", u: "ok ttyl everyone", e: "no" },
    { id: "sr-14", u: "The report needs to be sent by Friday", e: "no" },
    { id: "sr-15", u: "assistant what day of the week is it?", e: "yes" },
    { id: "sr-16", u: "🎉🎊🥳", e: "no" },
    { id: "sr-17", u: "Can the AI look into this?", e: "yes" },
    { id: "sr-18", u: "Someone should check the server logs", e: "no" },
    { id: "sr-19", u: "bot, what's 2+2?", e: "yes" },
    { id: "sr-20", u: "Thanks for your help earlier, chat!", e: "no" },
  ];
  let pass = 0;
  for (const ex of examples) {
    const out = await call(SR, ex.u);
    const aYes = out.toLowerCase().includes("yes") || out.toLowerCase().includes("respond");
    const verdict = (aYes && !out.toLowerCase().includes("ignore")) ? "yes" : "no";
    if (verdict === ex.e) { pass++; }
    else { console.log(`  FAIL ${ex.id}: got="${out.trim()}" expected=${ex.e} | "${ex.u}"`); }
  }
  console.log(`  Score: ${pass}/20`);
}

console.log("\n=== action_planner ===");
{
  const examples = [
    { id: "ap-1", u: "User wants to schedule a dentist appointment for next Tuesday at 2pm.", e: "SCHEDULE" },
    { id: "ap-2", u: "User asked what the weather is like today in San Francisco.", e: "SEARCH" },
    { id: "ap-3", u: "User said hello and asked how you're doing.", e: "REPLY" },
    { id: "ap-4", u: "User wants to be reminded to call their doctor in 2 hours.", e: "REMIND" },
    { id: "ap-5", u: "User wants to save a note about a new project idea: a mobile app for tracking workouts.", e: "NOTES" },
    { id: "ap-6", u: "User said goodbye and that they'll talk later.", e: "REPLY" },
    { id: "ap-7", u: "User wants to find restaurants near downtown Seattle.", e: "SEARCH" },
    { id: "ap-8", u: "User wants a reminder to submit the quarterly report on Friday at 5pm.", e: "REMIND" },
    { id: "ap-9", u: "User is asking who won the Super Bowl last year.", e: "SEARCH" },
    { id: "ap-10", u: "User says 'block off 2-3pm Thursday for a team sync'.", e: "SCHEDULE" },
    { id: "ap-11", u: "User wants to jot down that they need to pick up milk and eggs.", e: "NOTES" },
    { id: "ap-12", u: "User just sent a thumbs up emoji.", e: "NONE" },
    { id: "ap-13", u: "User typed '...' with no other text.", e: "NONE" },
    { id: "ap-14", u: "User wants to look up today's top news headlines.", e: "SEARCH" },
    { id: "ap-15", u: "User says 'note to self: buy birthday card for mom before Saturday'.", e: "NOTES" },
    { id: "ap-16", u: "User asks 'what time is it?'", e: "REPLY" },
    { id: "ap-17", u: "User wants to put a 1-hour lunch break on their calendar for tomorrow at noon.", e: "SCHEDULE" },
    { id: "ap-18", u: "User typed a single period '.' with nothing else.", e: "NONE" },
    { id: "ap-19", u: "User wants to search for the best TypeScript ORM libraries in 2025.", e: "SEARCH" },
    { id: "ap-20", u: "User wants a reminder in 30 minutes to take their medication.", e: "REMIND" },
  ];
  let pass = 0;
  for (const ex of examples) {
    const out = await call(AP, ex.u);
    const m = out.match(/"name"\s*:\s*"([A-Z_]+)"/);
    const actual = m ? m[1] : null;
    if (actual === ex.e) { pass++; }
    else { console.log(`  FAIL ${ex.id}: got=${actual} (${out.trim().slice(0,60)}) expected=${ex.e}`); }
  }
  console.log(`  Score: ${pass}/20`);
}

console.log("\n=== fact_extraction (struct judge — checking op type) ===");
{
  const examples = [
    { id: "fe-1", u: `Message: "I'm a senior TypeScript developer with 8 years of backend experience."\nKnown durable facts: []\nKnown current facts: []`, e: "add_durable" },
    { id: "fe-2", u: `Message: "I'm really anxious this morning — have a big presentation."\nKnown durable facts: []\nKnown current facts: []`, e: "add_current" },
    { id: "fe-3", u: `Message: "Berlin's been treating me well lately."\nKnown durable facts: [fact_abc] (durable.identity) lives in Berlin\nKnown current facts: []`, e: "strengthen" },
    { id: "fe-4", u: `Message: "Actually I moved to Tokyo last month."\nKnown durable facts: [fact_abc] (durable.identity) lives in Berlin\nKnown current facts: []`, e: "contradict" },
    { id: "fe-5", u: `Message: "How's the weather in Paris?"\nKnown durable facts: []\nKnown current facts: []`, e: "empty" },
    { id: "fe-6", u: `Message: "I love hiking on weekends, it's my main way to unwind."\nKnown durable facts: []\nKnown current facts: []`, e: "add_durable" },
    { id: "fe-7", u: `Message: "I'm currently working on the auth migration for the payments system."\nKnown durable facts: []\nKnown current facts: []`, e: "add_current" },
    { id: "fe-8", u: `Message: "lol yeah totally"\nKnown durable facts: []\nKnown current facts: []`, e: "empty" },
    { id: "fe-9", u: `Message: "I graduated from MIT with a CS degree in 2018."\nKnown durable facts: []\nKnown current facts: []`, e: "add_durable" },
    { id: "fe-10", u: `Message: "ok sounds good"\nKnown durable facts: [fact_x] (durable.identity) software engineer at Acme Corp\nKnown current facts: []`, e: "empty" },
  ];
  let pass = 0;
  for (const ex of examples) {
    const out = await call(FE, ex.u);
    let actualOp: string;
    try {
      const p = JSON.parse(out);
      actualOp = p.ops?.length === 0 ? "empty" : (p.ops?.[0]?.op ?? "unknown");
    } catch { actualOp = "parse_error"; }
    if (actualOp === ex.e) { pass++; }
    else { console.log(`  FAIL ${ex.id}: got=${actualOp} expected=${ex.e} | ${out.slice(0, 100)}`); }
  }
  console.log(`  Score: ${pass}/10`);
}

console.log("\n=== observation_extraction ===");
{
  const examples = [
    { id: "oe-1", u: "Recent exchanges:\nUser: I always use vim bindings everywhere I can\nAssistant: Got it, you prefer vim motions.", e: "nonempty" },
    { id: "oe-2", u: "Recent exchanges:\nUser: how's the weather today?\nAssistant: I don't have access to live weather data.\nUser: oh ok, never mind", e: "empty" },
    { id: "oe-3", u: "Recent exchanges:\nUser: I'm a senior backend engineer at Stripe, mostly TypeScript and Go\nAssistant: Great background. What are you working on today?", e: "nonempty" },
    { id: "oe-4", u: "Recent exchanges:\nUser: please always respond in bullet points, I hate paragraphs\nAssistant: Understood, bullet points it is.", e: "nonempty" },
    { id: "oe-5", u: "Recent exchanges:\nUser: ok thanks\nAssistant: You're welcome!", e: "empty" },
    { id: "oe-6", u: "Recent exchanges:\nUser: I always write tests before my implementation, TDD all the way\nAssistant: TDD is great for catching regressions early.\nUser: yeah I can't work without it at this point", e: "nonempty" },
  ];
  let pass = 0;
  for (const ex of examples) {
    const out = await call(OE, ex.u);
    let ok: boolean;
    try {
      const p = JSON.parse(out);
      ok = ex.e === "empty" ? (Array.isArray(p) && p.length === 0) : (Array.isArray(p) && p.length > 0);
    } catch { ok = false; }
    if (ok) { pass++; }
    else { console.log(`  FAIL ${ex.id}: got=${out.trim().slice(0,80)} expected=${ex.e}`); }
  }
  console.log(`  Score: ${pass}/6`);
}

console.log("\n=== memory_qa ===");
{
  const examples = [
    { id: "mq-1", u: "Query: What is the user's favorite programming language?\n\nSaved memory notes:\n- User prefers TypeScript for all new projects\n- User has 8 years of Python experience but avoids it for new work\n\nKnowledge snippets: []", check: (s: string) => s.toLowerCase().includes("typescript") },
    { id: "mq-2", u: "Query: What is the capital of France?\n\nSaved memory notes: []\n\nKnowledge snippets: []", check: (s: string) => s.toLowerCase().includes("insufficient") || s.toLowerCase().includes("no relevant") || s.toLowerCase().includes("not in") || s.toLowerCase().includes("cannot") || s.toLowerCase().includes("don't have") },
    { id: "mq-3", u: "Query: When is the user's team standup?\n\nSaved memory notes:\n- Daily standup at 9am EST with the backend team\n- User sometimes skips Fridays\n\nKnowledge snippets: []", check: (s: string) => (s.includes("9am") || s.includes("9:00")) && s.toLowerCase().includes("friday") },
    { id: "mq-4", u: "Query: What medications does the user take?\n\nSaved memory notes:\n- User takes metformin 500mg twice daily for diabetes management\n- Allergic to penicillin\n\nKnowledge snippets: []", check: (s: string) => s.toLowerCase().includes("metformin") && s.toLowerCase().includes("penicillin") },
    { id: "mq-5", u: "Query: What database does the user's company use?\n\nSaved memory notes:\n- User works on the frontend team at Acme Corp\n\nKnowledge snippets: []", check: (s: string) => s.toLowerCase().includes("insufficient") || s.toLowerCase().includes("not specified") || s.toLowerCase().includes("doesn't") || s.toLowerCase().includes("does not") || s.toLowerCase().includes("not mention") },
    { id: "mq-6", u: "Query: Does the user have any dietary restrictions?\n\nSaved memory notes:\n- User is vegetarian and avoids all meat\n- User also avoids gluten (celiac disease)\n\nKnowledge snippets: []", check: (s: string) => s.toLowerCase().includes("vegetarian") && (s.toLowerCase().includes("gluten") || s.toLowerCase().includes("celiac")) },
  ];
  let pass = 0;
  for (const ex of examples) {
    const out = await call(MQ, ex.u);
    let answer = out;
    try { answer = JSON.parse(out).answer ?? out; } catch {}
    const ok = ex.check(answer);
    if (ok) { pass++; }
    else { console.log(`  FAIL ${ex.id}: got="${answer.slice(0,100)}"`); }
  }
  console.log(`  Score: ${pass}/6`);
}

console.log("\n=== schedule_follow_up (check for common failures) ===");
{
  const examples = [
    { id: "sfu-1", u: "Please follow up with Sarah about the Q3 proposal next Monday.\nContext: Today is Wednesday 2026-05-20.", check: (s: string) => { try { const p = JSON.parse(s); return p.contactName?.toLowerCase().includes("sarah") && p.scheduledAt?.includes("2026-05-25"); } catch { return false; } } },
    { id: "sfu-2", u: "I need to check in with Mike about the contract renewal — he said sometime next quarter.\nContext: Today is 2026-05-20.", check: (s: string) => { try { const p = JSON.parse(s); return p.contactName?.toLowerCase().includes("mike") && p.scheduledAt === null; } catch { return false; } } },
    { id: "sfu-3", u: "Remind me to follow up with Tom from Acme tomorrow morning about the invoice.\nContext: Today is Thursday 2026-05-21.", check: (s: string) => { try { const p = JSON.parse(s); return p.contactName?.toLowerCase().includes("tom") && p.scheduledAt?.includes("2026-05-22"); } catch { return false; } } },
  ];
  let pass = 0;
  for (const ex of examples) {
    const out = await call(SFU, ex.u);
    const ok = ex.check(out);
    if (ok) { pass++; }
    else { console.log(`  FAIL ${ex.id}: got=${out.trim().slice(0,120)}`); }
  }
  console.log(`  Score: ${pass}/3 (sample check)`);
}

console.log("\nDone.");
