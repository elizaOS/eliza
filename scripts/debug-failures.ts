import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "https://api.cerebras.ai/v1",
  apiKey: "csk-8c9hf68jfm6h955kx492dtnm8jwn682n6exhew4jpe85vwy6",
  defaultHeaders: { "x-cerebras-reasoning-effort": "low" },
});

const call = async (sys: string, user: string) => {
  const r = await client.messages.create({
    model: "gpt-oss-120b",
    max_tokens: 64,
    system: sys,
    messages: [{ role: "user", content: user }],
  });
  return (r.content[0] as any).text as string;
};

const SR_PROMPT = `Decide whether to respond to this message.

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

const AP_PROMPT = `Select the next action based on the conversation context.

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

const FACT_PROMPT = `Classify and extract facts from this message. Manage two fact stores:

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

const srExamples = [
  { id: "sr-1", user: "@assistant can you help me schedule a meeting for tomorrow at 3pm?", expected: "YES" },
  { id: "sr-2", user: "Hey John, can you grab lunch today?", expected: "NO" },
  { id: "sr-3", user: "What time is it in Tokyo right now?", expected: "YES" },
  { id: "sr-4", user: "lol that's hilarious", expected: "NO" },
  { id: "sr-5", user: "I was talking to the assistant yesterday and it helped me", expected: "NO" },
  { id: "sr-6", user: "Anyone else going to the party tonight?", expected: "NO" },
  { id: "sr-7", user: "Hey assistant, can you summarize this article for me?", expected: "YES" },
  { id: "sr-8", user: "The meeting got moved to 4pm", expected: "NO" },
  { id: "sr-9", user: "Can someone look up the flight status for AA 1234?", expected: "YES" },
  { id: "sr-10", user: "alice: did you get my email? bob: yeah got it", expected: "NO" },
  { id: "sr-11", user: "Can you help me write an email to my boss?", expected: "YES" },
  { id: "sr-12", user: "Does anyone know where the conference room is?", expected: "YES" },
  { id: "sr-13", user: "ok ttyl everyone", expected: "NO" },
  { id: "sr-14", user: "The report needs to be sent by Friday", expected: "NO" },
  { id: "sr-15", user: "assistant what day of the week is it?", expected: "YES" },
  { id: "sr-16", user: "🎉🎊🥳", expected: "NO" },
  { id: "sr-17", user: "Can the AI look into this?", expected: "YES" },
  { id: "sr-18", user: "Someone should check the server logs", expected: "NO" },
  { id: "sr-19", user: "bot, what's 2+2?", expected: "YES" },
  { id: "sr-20", user: "Thanks for your help earlier, chat!", expected: "NO" },
];

const apExamples = [
  { id: "ap-1", user: "User wants to schedule a dentist appointment for next Tuesday at 2pm.", expected: "SCHEDULE" },
  { id: "ap-2", user: "User asked what the weather is like today in San Francisco.", expected: "SEARCH" },
  { id: "ap-3", user: "User said hello and asked how you're doing.", expected: "REPLY" },
  { id: "ap-4", user: "User wants to be reminded to call their doctor in 2 hours.", expected: "REMIND" },
  { id: "ap-5", user: "User wants to save a note about a new project idea: a mobile app for tracking workouts.", expected: "NOTES" },
  { id: "ap-6", user: "User said goodbye and that they'll talk later.", expected: "REPLY" },
  { id: "ap-7", user: "User wants to find restaurants near downtown Seattle.", expected: "SEARCH" },
  { id: "ap-8", user: "User wants a reminder to submit the quarterly report on Friday at 5pm.", expected: "REMIND" },
  { id: "ap-9", user: "User is asking who won the Super Bowl last year.", expected: "SEARCH" },
  { id: "ap-10", user: "User says 'block off 2-3pm Thursday for a team sync'.", expected: "SCHEDULE" },
  { id: "ap-11", user: "User wants to jot down that they need to pick up milk and eggs.", expected: "NOTES" },
  { id: "ap-12", user: "User just sent a thumbs up emoji.", expected: "NONE" },
  { id: "ap-13", user: "User typed '...' with no other text.", expected: "NONE" },
  { id: "ap-14", user: "User wants to look up today's top news headlines.", expected: "SEARCH" },
  { id: "ap-15", user: "User says 'note to self: buy birthday card for mom before Saturday'.", expected: "NOTES" },
  { id: "ap-16", user: "User asks 'what time is it?'", expected: "REPLY" },
  { id: "ap-17", user: "User wants to put a 1-hour lunch break on their calendar for tomorrow at noon.", expected: "SCHEDULE" },
  { id: "ap-18", user: "User typed a single period '.' with nothing else.", expected: "NONE" },
  { id: "ap-19", user: "User wants to search for the best TypeScript ORM libraries in 2025.", expected: "SEARCH" },
  { id: "ap-20", user: "User wants a reminder in 30 minutes to take their medication.", expected: "REMIND" },
];

const feExamples = [
  { id: "fe-1", user: `Message: "I'm a senior TypeScript developer with 8 years of backend experience."\nKnown durable facts: []\nKnown current facts: []`, expectedOp: "add_durable" },
  { id: "fe-2", user: `Message: "I'm really anxious this morning — have a big presentation."\nKnown durable facts: []\nKnown current facts: []`, expectedOp: "add_current" },
  { id: "fe-3", user: `Message: "Berlin's been treating me well lately."\nKnown durable facts: [fact_abc] (durable.identity) lives in Berlin\nKnown current facts: []`, expectedOp: "strengthen" },
  { id: "fe-4", user: `Message: "Actually I moved to Tokyo last month."\nKnown durable facts: [fact_abc] (durable.identity) lives in Berlin\nKnown current facts: []`, expectedOp: "contradict" },
  { id: "fe-5", user: `Message: "How's the weather in Paris?"\nKnown durable facts: []\nKnown current facts: []`, expectedOp: "empty" },
  { id: "fe-6", user: `Message: "I love hiking on weekends, it's my main way to unwind."\nKnown durable facts: []\nKnown current facts: []`, expectedOp: "add_durable" },
  { id: "fe-7", user: `Message: "I'm currently working on the auth migration for the payments system."\nKnown durable facts: []\nKnown current facts: []`, expectedOp: "add_current" },
  { id: "fe-8", user: `Message: "lol yeah totally"\nKnown durable facts: []\nKnown current facts: []`, expectedOp: "empty" },
  { id: "fe-9", user: `Message: "I graduated from MIT with a CS degree in 2018."\nKnown durable facts: []\nKnown current facts: []`, expectedOp: "add_durable" },
  { id: "fe-10", user: `Message: "ok sounds good"\nKnown durable facts: [fact_x] (durable.identity) software engineer at Acme Corp\nKnown current facts: []`, expectedOp: "empty" },
];

const extractAction = (s: string) => {
  const m = s.match(/"name"\s*:\s*"([A-Z_]+)"/);
  return m ? m[1] : null;
};

const extractFirstOp = (s: string): string => {
  try {
    const parsed = JSON.parse(s);
    if (parsed.ops?.length === 0) return "empty";
    return parsed.ops?.[0]?.op ?? "unknown";
  } catch {
    return "parse_error";
  }
};

console.log("=== should_respond failures ===");
for (const ex of srExamples) {
  const out = await call(SR_PROMPT, ex.user);
  const aYes = out.toLowerCase().includes("yes") || out.toLowerCase().includes("respond");
  const verdict = aYes && !out.toLowerCase().includes("ignore") ? "yes" : "no";
  const expected = ex.expected.toLowerCase();
  if (verdict !== expected) {
    console.log(`FAIL ${ex.id}: output=${out.trim()} expected=${ex.expected}`);
  }
}
console.log("done sr");

console.log("\n=== action_planner failures ===");
for (const ex of apExamples) {
  const out = await call(AP_PROMPT, ex.user);
  const actual = extractAction(out);
  if (actual !== ex.expected) {
    console.log(`FAIL ${ex.id}: output=${actual} (${out.trim()}) expected=${ex.expected}`);
  }
}
console.log("done ap");

console.log("\n=== fact_extraction failures ===");
for (const ex of feExamples) {
  const out = await call(FACT_PROMPT, ex.user);
  const actualOp = extractFirstOp(out);
  if (actualOp !== ex.expectedOp) {
    console.log(`FAIL ${ex.id}: op=${actualOp} expected=${ex.expectedOp} | ${out.slice(0, 100)}`);
  }
}
console.log("done fe");
