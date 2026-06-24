export const SCHEDULE_PLAN_INSTRUCTIONS = [
  "Plan the scheduling negotiation action for this request.",
  "The user may speak in any language.",
  "Use the current request, the structured parameters, and recent conversation context.",
  "Return JSON only as a single object with exactly these fields:",
  "  subaction: one of start, propose, respond, finalize, cancel, list_active, list_proposals, or null",
  "  shouldAct: boolean",
  "  response: short natural-language reply when shouldAct is false or clarification is needed",
  "",
  "Use start when beginning a new negotiation.",
  "Use propose when submitting a concrete proposed slot for an existing negotiation.",
  "Use respond when recording accepted, declined, or expired against a proposal.",
  "Use finalize when confirming the winning proposal.",
  "Use cancel when stopping an active negotiation.",
  "Use list_active for listing negotiations.",
  "Use list_proposals for listing proposals in one negotiation.",
  "If the user is making a first-turn calendar request, asking for recurring time, asking to bundle meetings while traveling, or asking for missed-call repair, this action is the wrong tool. Return shouldAct=false so the planner can choose CALENDAR or MESSAGE with the appropriate inbox/draft operation instead.",
  "Set shouldAct=false when the user is vague or only asks for general scheduling help.",
  "",
  'Example: {"subaction":"start","shouldAct":true,"response":null}',
  'Example clarification: {"subaction":null,"shouldAct":false,"response":"Do you want to start, propose, respond, finalize, cancel, or list scheduling negotiations?"}',
].join("\n");

export const REMINDER_DISPATCH_INSTRUCTIONS = [
  "Write a short reminder nudge in the assistant's voice.",
  "This is a real follow-up or reminder delivery, not a system log.",
  "",
  "Rules:",
  "- Return only the reminder text.",
  "- Sound natural and in character.",
  "- Do not start with 'Reminder' or 'Follow-up reminder'.",
  "- Do not use ISO timestamps.",
  "- Keep it concise: one or two short sentences.",
  "- You may mention nearby reminders briefly if it helps.",
  "- For escalation, sound a little firmer but still human.",
  "- No markdown, bullets, quotes, labels, or emoji.",
].join("\n");

export const BRIEF_NARRATIVE_INSTRUCTIONS = `Render a concise narrative paragraph (2-5 sentences). Lead with the
schedule-changing or reply-needed items first. Mention each non-empty domain
once. If a domain is empty, omit it rather than saying "nothing to report".
No invented facts; only describe items in the data below.`;

export const GMAIL_PLAN_INSTRUCTIONS = [
  "Plan the Gmail/inbox triage action for this request.",
  "The user may speak in any language.",
  "Use only Gmail/inbox actions. Do not plan calendar, reminder, or document work here.",
  "Return line-based fields only:",
  "subaction: triage | needs_response | search | read | draft_reply | send_reply",
  "shouldAct: true | false",
  "response: null or a short clarification",
  "queries: up to 3 concise Gmail search queries separated by ||",
  "",
  "Choose triage for broad inbox cleanup or priority review.",
  "Choose needs_response when the owner asks what needs a reply.",
  "Choose search/read when the owner asks for specific messages.",
  "Choose draft_reply or send_reply only when the owner explicitly asks to respond.",
  "Set shouldAct=false when the request is too vague to choose safely.",
].join("\n");

export const GMAIL_QUERY_EXTRACTION_INSTRUCTIONS = [
  "Extract Gmail search queries for the owner's request.",
  "Return line-based fields only:",
  "subaction: search",
  "shouldAct: true",
  "response: null",
  "queries: up to 3 concise Gmail search queries separated by ||",
].join("\n");

export const MEETING_PREP_INSTRUCTIONS =
  "Prepare the next working block: scan upcoming calendar events, related threads, docs, blockers, and people context. Surface missing agenda, location, dial-in, prep document, decision owner, and likely follow-up. Keep the owner-facing result compact.";
