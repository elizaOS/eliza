/**
 * Benchmark case library for the action selection benchmark.
 *
 * Each case is a single natural-language user message and the action we
 * expect the agent to pick (or null for plain chat / no action).
 *
 * Case ids are stable, human-readable slugs. Tags include the primary
 * domain ("scheduling", "email", …) plus a severity tag
 * ("critical" | "standard" | "negative").
 *
 * Canonical action names follow the post-consolidation taxonomy in
 * `docs/audits/action-structure-audit-2026-05-10.md`. The umbrella parents
 * used here are: REPLY, MESSAGE, POST, CALENDAR, OWNER_TODOS, OWNER_GOALS,
 * OWNER_ROUTINES, OWNER_REMINDERS, OWNER_HEALTH, OWNER_SCREENTIME,
 * OWNER_FINANCES, ENTITY, BLOCK, CREDENTIALS, PERSONAL_ASSISTANT,
 * RESOLVE_REQUEST, REMOTE_DESKTOP, VOICE_CALL, COMPUTER_USE, BROWSER, and
 * SCHEDULE_FOLLOW_UP. Retired names like LIFE/CHECKIN/PROFILE/RELATIONSHIP/
 * HEALTH/SCREEN_TIME/APP_BLOCK/WEBSITE_BLOCK/BOOK_TRAVEL/AUTOFILL/
 * PASSWORD_MANAGER/SUBSCRIPTIONS/DEVICE_INTENT must not appear as
 * expectedAction values.
 */

export interface ActionBenchmarkCase {
  id: string;
  userMessage: string;
  expectedAction: string | null;
  acceptableActions?: string[];
  expectedParams?: Record<string, unknown>;
  tags: string[];
  notes?: string;
}

export const ACTION_BENCHMARK_CASES: ActionBenchmarkCase[] = [
  // ─── Greeting / chat (no action) ──────────────────────────────────────
  {
    id: "chat-greeting-hi",
    userMessage: "hey",
    expectedAction: null,
    tags: ["chat", "negative"],
  },
  {
    id: "chat-greeting-hello-how-are-you",
    userMessage: "Hello! How are you today?",
    expectedAction: null,
    tags: ["chat", "negative"],
  },
  {
    id: "chat-thanks",
    userMessage: "thanks, that was helpful",
    expectedAction: null,
    tags: ["chat", "negative"],
  },
  {
    id: "chat-smalltalk-weather",
    userMessage: "sunny days are pretty nice",
    expectedAction: null,
    tags: ["chat", "negative"],
  },
  {
    id: "chat-opinion-question",
    userMessage: "what do you think about remote work?",
    expectedAction: null,
    tags: ["chat", "negative"],
  },

  // ─── Owner todos (OWNER_TODOS action=create|list) ─────────────────────
  {
    id: "todo-add-simple",
    userMessage: "add a todo: pick up dry cleaning tomorrow",
    expectedAction: "OWNER_TODOS",
    acceptableActions: ["CREATE_TODO"],
    expectedParams: { action: "create" },
    tags: ["todos", "standard"],
  },
  {
    id: "todo-remember-to-call",
    userMessage: "remember to call mom on Sunday",
    expectedAction: "OWNER_TODOS",
    acceptableActions: ["CREATE_TODO"],
    expectedParams: { action: "create" },
    tags: ["todos", "standard"],
  },
  {
    id: "todo-list-today",
    userMessage: "what's on my todo list today?",
    expectedAction: "OWNER_TODOS",
    acceptableActions: ["LIST_TODOS"],
    tags: ["todos", "standard"],
  },

  // ─── Owner routines / habits (OWNER_ROUTINES action=create) ───────────
  {
    id: "habit-daily-meditation",
    userMessage:
      "I want to start a daily habit of meditating for 10 minutes each morning",
    expectedAction: "OWNER_ROUTINES",
    acceptableActions: ["CREATE_HABIT"],
    expectedParams: { action: "create" },
    tags: ["habits", "standard"],
  },
  {
    id: "habit-weekly-gym",
    userMessage: "track my gym sessions three times a week",
    expectedAction: "OWNER_ROUTINES",
    acceptableActions: ["CREATE_HABIT"],
    expectedParams: { action: "create" },
    tags: ["habits", "standard"],
  },

  // ─── Owner goals (OWNER_GOALS action=create) ──────────────────────────
  {
    id: "goal-save-money",
    userMessage: "set a goal to save $5,000 by the end of the year",
    expectedAction: "OWNER_GOALS",
    acceptableActions: ["CREATE_GOAL"],
    expectedParams: { action: "create" },
    tags: ["goals", "standard"],
  },
  {
    id: "goal-read-books",
    userMessage: "I want a goal of reading 20 books this year",
    expectedAction: "OWNER_GOALS",
    acceptableActions: ["CREATE_GOAL"],
    expectedParams: { action: "create" },
    tags: ["goals", "standard"],
  },
  {
    id: "goal-career",
    userMessage: "make getting promoted to senior a goal for me",
    expectedAction: "OWNER_GOALS",
    acceptableActions: ["CREATE_GOAL"],
    expectedParams: { action: "create" },
    tags: ["goals", "standard"],
  },

  // ─── Check-ins (retired — workflow, not action) ───────────────────────
  // CHECKIN was retired from the planner surface. Morning/night check-ins
  // run as workflows / scheduled tasks, not as a discrete action. The
  // canonical reply for "run my check-in" is to converse, optionally
  // surfacing an OWNER_TODOS/OWNER_ROUTINES review.
  {
    id: "checkin-morning",
    userMessage: "run my morning check-in",
    expectedAction: null,
    acceptableActions: ["OWNER_TODOS", "OWNER_ROUTINES", "OWNER_GOALS"],
    tags: ["checkin", "standard"],
    notes:
      "CHECKIN retired; if the agent picks any owner-review action that's still acceptable.",
  },
  {
    id: "checkin-night",
    userMessage: "give me my night check-in",
    expectedAction: null,
    acceptableActions: ["OWNER_TODOS", "OWNER_ROUTINES", "OWNER_GOALS"],
    tags: ["checkin", "standard"],
    notes: "CHECKIN retired; see checkin-morning.",
  },

  // ─── Owner profile (retired — handled by evaluator) ───────────────────
  // PROFILE was retired and is now handled by the LifeOps response-handler
  // evaluator. The agent should reply naturally; profile extraction runs
  // automatically.
  {
    id: "owner-profile-travel-prefs",
    userMessage:
      "remember that I prefer aisle seats, carry-on only, and moderate hotels close to the venue",
    expectedAction: null,
    tags: ["profile", "standard"],
    notes:
      "PROFILE retired; identity facts are extracted by the response-handler evaluator.",
  },

  // ─── Calendar (CALENDAR action=feed|next_event|create_event|...) ──────
  {
    id: "cal-next-event",
    userMessage: "what's my next meeting?",
    expectedAction: "CALENDAR",
    acceptableActions: ["NEXT_EVENT"],
    expectedParams: { action: "next_event" },
    tags: ["calendar", "standard"],
  },
  {
    id: "cal-today",
    userMessage: "show me my calendar for today",
    expectedAction: "CALENDAR",
    acceptableActions: ["FEED", "CALENDAR_FEED"],
    expectedParams: { action: "feed" },
    tags: ["calendar", "standard"],
  },
  {
    id: "cal-create-event",
    userMessage: "schedule a dentist appointment next Tuesday at 3pm",
    expectedAction: "CALENDAR",
    acceptableActions: ["CREATE_EVENT"],
    expectedParams: { action: "create_event" },
    tags: ["calendar", "critical"],
  },
  {
    id: "cal-create-event-meeting",
    userMessage:
      "create a calendar event titled '1:1 with Alex' this Thursday at 10am for 30 minutes",
    expectedAction: "CALENDAR",
    acceptableActions: ["CREATE_EVENT"],
    expectedParams: { action: "create_event" },
    tags: ["calendar", "critical"],
  },
  {
    id: "cal-week-ahead",
    userMessage: "what does my week look like?",
    expectedAction: "CALENDAR",
    acceptableActions: ["FEED"],
    expectedParams: { action: "feed" },
    tags: ["calendar", "standard"],
  },

  // ─── Email triage (MESSAGE action=triage|draft_reply|send|unsubscribe) ─
  {
    id: "email-triage-inbox",
    userMessage: "triage my gmail inbox",
    expectedAction: "MESSAGE",
    acceptableActions: ["TRIAGE"],
    expectedParams: { action: "triage" },
    tags: ["email", "critical"],
  },
  {
    id: "email-unread",
    userMessage: "summarize my unread emails",
    expectedAction: "MESSAGE",
    acceptableActions: ["MESSAGE"],
    expectedParams: { action: "triage" },
    tags: ["email", "standard"],
  },
  {
    id: "email-draft-reply",
    userMessage:
      "draft a reply to the latest email from Sarah saying I'll review it tomorrow",
    expectedAction: "MESSAGE",
    expectedParams: { action: "draft_reply" },
    tags: ["email", "critical"],
  },
  {
    id: "email-send-reply",
    userMessage:
      "send a reply to the last email from finance confirming receipt",
    expectedAction: "MESSAGE",
    acceptableActions: ["MESSAGE"],
    expectedParams: { action: "send" },
    tags: ["email", "critical"],
  },
  {
    id: "email-unsubscribe-sender",
    userMessage: "unsubscribe me from newsletters@medium.com and block them",
    expectedAction: "MESSAGE",
    expectedParams: { action: "manage" },
    tags: ["email", "standard"],
    notes:
      "Unsubscribe is part of MESSAGE manage; BROWSER/COMPUTER_USE may also be acceptable as fallback.",
  },

  // ─── Inbox (generic — MESSAGE) ────────────────────────────────────────
  {
    id: "inbox-triage",
    userMessage: "triage my inbox",
    expectedAction: "MESSAGE",
    expectedParams: { action: "triage" },
    tags: ["inbox", "critical"],
  },
  {
    id: "inbox-digest",
    userMessage: "give me my inbox digest",
    expectedAction: "MESSAGE",
    acceptableActions: ["MESSAGE"],
    expectedParams: { action: "list_inbox" },
    tags: ["inbox", "standard"],
  },
  {
    id: "inbox-respond",
    userMessage: "respond to the messages that need an answer in my inbox",
    expectedAction: "MESSAGE",
    acceptableActions: ["MESSAGE"],
    expectedParams: { action: "respond" },
    tags: ["inbox", "standard"],
  },

  // ─── Website blocking (BLOCK target=website) ──────────────────────────
  {
    id: "block-sites-focus",
    userMessage: "block twitter and reddit for the next 2 hours",
    expectedAction: "BLOCK",
    expectedParams: { action: "block", target: "website" },
    tags: ["focus", "blocking", "critical"],
  },
  {
    id: "block-sites-social",
    userMessage: "turn on a focus block for all social media sites",
    expectedAction: "BLOCK",
    expectedParams: { action: "block", target: "website" },
    tags: ["focus", "blocking", "standard"],
  },
  {
    id: "block-sites-youtube",
    userMessage: "I keep getting distracted by youtube, block it",
    expectedAction: "BLOCK",
    expectedParams: { action: "block", target: "website" },
    tags: ["focus", "blocking", "standard"],
  },

  // ─── App blocking (BLOCK target=app) ──────────────────────────────────
  {
    id: "block-apps-games",
    userMessage: "block all games on my phone until 6pm",
    expectedAction: "BLOCK",
    expectedParams: { action: "block", target: "app" },
    tags: ["focus", "blocking", "standard"],
  },
  {
    id: "block-apps-slack",
    userMessage: "block the slack app while I focus on deep work",
    expectedAction: "BLOCK",
    expectedParams: { action: "block", target: "app" },
    tags: ["focus", "blocking", "standard"],
  },

  // ─── Entity / relationships (ENTITY action=list|log_interaction|...) ──
  {
    id: "rel-list-contacts",
    userMessage: "who are my closest contacts?",
    expectedAction: "ENTITY",
    // LIST_CONTACTS / CONTACT are folded to ENTITY by the runner's
    // canonical map; RELATIONSHIPS is retired.
    acceptableActions: ["LIST_CONTACTS", "CONTACT"],
    expectedParams: { action: "list" },
    tags: ["relationships", "standard"],
  },
  {
    id: "rel-follow-up",
    userMessage:
      "remind me to follow up with David next week about the project",
    expectedAction: "SCHEDULE_FOLLOW_UP",
    acceptableActions: ["ADD_FOLLOW_UP", "ENTITY", "OWNER_REMINDERS"],
    tags: ["relationships", "standard"],
    notes:
      "Follow-up scheduling is its own focused leaf in the canonical taxonomy.",
  },
  {
    id: "rel-days-since",
    userMessage: "how long has it been since I talked to David?",
    expectedAction: "ENTITY",
    acceptableActions: ["DAYS_SINCE"],
    expectedParams: { action: "log_interaction" },
    tags: ["relationships", "standard"],
    notes:
      "ENTITY supports last-interaction lookups via its interaction history.",
  },

  // ─── Cross-channel send (MESSAGE action=send) ─────────────────────────
  {
    id: "cross-send-telegram",
    userMessage:
      "send a telegram message to Jane saying I'm running 10 minutes late",
    expectedAction: "MESSAGE",
    acceptableActions: ["MESSAGE"],
    expectedParams: { action: "send" },
    tags: ["messaging", "critical"],
  },
  {
    id: "cross-send-discord",
    userMessage: "post 'standup in 5' to the engineering discord channel",
    expectedAction: "MESSAGE",
    acceptableActions: ["MESSAGE"],
    expectedParams: { action: "send" },
    tags: ["messaging", "standard"],
  },
  {
    id: "cross-send-signal",
    userMessage: "send a Signal message to Priya saying thanks for the review",
    expectedAction: "MESSAGE",
    acceptableActions: ["MESSAGE"],
    expectedParams: { action: "send" },
    tags: ["messaging", "standard"],
  },

  // ─── X / Twitter read (MESSAGE for DMs, POST for public feed) ─────────
  {
    id: "x-read-dms",
    userMessage: "check my twitter DMs",
    expectedAction: "MESSAGE",
    expectedParams: { action: "list_inbox" },
    tags: ["x", "standard"],
  },
  {
    id: "x-read-feed",
    userMessage: "what's on my X timeline?",
    expectedAction: "POST",
    expectedParams: { action: "read" },
    tags: ["x", "standard"],
  },
  {
    id: "x-search",
    userMessage: "search twitter for posts about elizaOS",
    expectedAction: "POST",
    expectedParams: { action: "search" },
    tags: ["x", "standard"],
  },

  // ─── Owner screen time (OWNER_SCREENTIME action=today|by_app|...) ─────
  {
    id: "screentime-today",
    userMessage: "how much screen time have I used today?",
    expectedAction: "OWNER_SCREENTIME",
    acceptableActions: ["TODAY"],
    expectedParams: { action: "today" },
    tags: ["screen-time", "standard"],
  },
  {
    id: "screentime-by-app",
    userMessage: "break down my screen time by app this week",
    expectedAction: "OWNER_SCREENTIME",
    acceptableActions: ["BY_APP"],
    expectedParams: { action: "by_app" },
    tags: ["screen-time", "standard"],
  },

  // ─── Scheduling (CALENDAR action=propose_times|check_availability) ────
  {
    id: "sched-start-flow",
    userMessage: "help me schedule a meeting with the design team",
    expectedAction: "CALENDAR",
    acceptableActions: ["START"],
    expectedParams: { action: "propose_times" },
    tags: ["scheduling", "standard"],
  },
  {
    id: "sched-propose-times",
    userMessage:
      "propose three times for a 30 minute sync with Marco next week",
    expectedAction: "CALENDAR",
    acceptableActions: ["PROPOSE", "PROPOSE_MEETING_TIMES", "SCHEDULING"],
    expectedParams: { action: "propose_times" },
    tags: ["scheduling", "critical"],
  },

  // ─── Voice call (VOICE_CALL action=dial) ──────────────────────────────
  {
    id: "twilio-call-dentist",
    userMessage: "call the dentist and reschedule my appointment",
    expectedAction: "VOICE_CALL",
    expectedParams: { action: "dial" },
    tags: ["voice", "critical"],
  },
  {
    id: "twilio-call-support",
    userMessage: "phone my cable company and ask about the outage",
    expectedAction: "VOICE_CALL",
    expectedParams: { action: "dial" },
    tags: ["voice", "standard"],
  },

  // ─── Travel (PERSONAL_ASSISTANT action=book_travel) ───────────────────
  {
    id: "book-travel-flight",
    userMessage:
      "book travel for me from San Francisco to New York next Thursday and Friday",
    expectedAction: "PERSONAL_ASSISTANT",
    expectedParams: { action: "book_travel" },
    tags: ["travel", "standard"],
  },

  // ─── Browser management (BROWSER action=manage) ───────────────────────
  {
    id: "browser-manage-settings",
    userMessage: "show me my LifeOps browser settings",
    expectedAction: "BROWSER",
    // MANAGE_LIFEOPS_BROWSER was retired in favor of the unified BROWSER
    // parent. The runner's canonical map folds the old name to BROWSER, so
    // there's no need to repeat it in acceptableActions.
    expectedParams: { action: "manage" },
    tags: ["browser", "standard"],
  },

  // ─── Autofill (CREDENTIALS action=fill) ───────────────────────────────
  {
    id: "autofill-password-field",
    userMessage:
      "fill the password field on github.com using my password manager",
    expectedAction: "CREDENTIALS",
    expectedParams: { action: "fill" },
    tags: ["browser", "standard"],
  },

  // ─── Approval queue (RESOLVE_REQUEST action=approve|reject) ───────────
  {
    id: "approval-approve-request",
    userMessage: "approve the pending travel booking request",
    expectedAction: "RESOLVE_REQUEST",
    expectedParams: { action: "approve" },
    tags: ["approval", "standard"],
  },
  {
    id: "approval-reject-request",
    userMessage:
      "reject that pending approval request and say it needs changes",
    expectedAction: "RESOLVE_REQUEST",
    expectedParams: { action: "reject" },
    tags: ["approval", "standard"],
  },

  // ─── Computer use ─────────────────────────────────────────────────────
  {
    id: "computer-use-click",
    userMessage:
      "open the Finder and create a new folder called Q2-Reports on my desktop",
    expectedAction: "COMPUTER_USE",
    tags: ["computer-use", "standard"],
  },
  {
    id: "computer-use-screenshot",
    userMessage: "take a screenshot of my desktop",
    expectedAction: "COMPUTER_USE",
    expectedParams: { action: "screenshot" },
    tags: ["computer-use", "standard"],
  },

  // ─── Subscriptions (OWNER_FINANCES action=subscription_cancel) ────────
  {
    id: "subscriptions-cancel-netflix",
    userMessage: "cancel my Netflix subscription",
    expectedAction: "OWNER_FINANCES",
    acceptableActions: ["COMPUTER_USE", "BROWSER"],
    expectedParams: { action: "subscription_cancel" },
    tags: ["subscriptions", "critical"],
  },
  {
    id: "subscriptions-cancel-hulu-browser",
    userMessage: "cancel Hulu in my browser",
    expectedAction: "OWNER_FINANCES",
    // The runner's canonical map folds MANAGE_LIFEOPS_BROWSER -> BROWSER,
    // so we just list canonical fallbacks here.
    acceptableActions: ["BROWSER", "COMPUTER_USE"],
    expectedParams: { action: "subscription_cancel" },
    tags: ["subscriptions", "critical"],
  },
  {
    id: "subscriptions-cancel-google-play",
    userMessage: "cancel my Google Play subscription",
    expectedAction: "OWNER_FINANCES",
    acceptableActions: ["COMPUTER_USE"],
    expectedParams: { action: "subscription_cancel" },
    tags: ["subscriptions", "critical"],
  },
  {
    id: "subscriptions-cancel-app-store",
    userMessage: "cancel my App Store subscription on this Mac",
    expectedAction: "OWNER_FINANCES",
    acceptableActions: ["COMPUTER_USE"],
    expectedParams: { action: "subscription_cancel" },
    tags: ["subscriptions", "critical"],
  },

  // ─── Negative / near-miss cases ───────────────────────────────────────
  {
    id: "neg-email-chatter",
    userMessage: "I hate email, it's such a time sink",
    expectedAction: null,
    tags: ["chat", "negative"],
    notes: "Mentions email but is venting, not a triage request",
  },
  {
    id: "neg-calendar-chatter",
    userMessage: "my calendar has been crazy this quarter",
    expectedAction: null,
    tags: ["chat", "negative"],
    notes: "Mentions calendar but not a request",
  },
  {
    id: "neg-goal-advice",
    userMessage: "any tips on setting better goals?",
    expectedAction: null,
    tags: ["chat", "negative"],
    notes: "General advice question, not a create_goal request",
  },
  {
    id: "neg-block-hypothetical",
    userMessage: "do you think blocking websites actually helps productivity?",
    expectedAction: null,
    tags: ["chat", "negative"],
    notes: "Opinion question, not a block request",
  },
  {
    id: "neg-call-hypothetical",
    userMessage: "should I call my landlord or just email them?",
    expectedAction: null,
    tags: ["chat", "negative"],
    notes: "Advice question, not a call request",
  },
  {
    id: "neg-screentime-chatter",
    userMessage: "I think I spend way too much time on my phone",
    expectedAction: null,
    tags: ["chat", "negative"],
    notes: "Observation, not a screen_time request",
  },

  // ─── Password manager (CREDENTIALS action=search|list) ────────────────
  {
    id: "password-manager-lookup",
    userMessage: "look up my GitHub password",
    expectedAction: "CREDENTIALS",
    expectedParams: { action: "search" },
    tags: ["password", "credentials", "standard"],
  },
  {
    id: "password-manager-list-logins",
    userMessage: "show me my saved logins for github.com",
    expectedAction: "CREDENTIALS",
    expectedParams: { action: "list" },
    tags: ["password", "credentials", "standard"],
  },

  // ─── Remote desktop (REMOTE_DESKTOP action=start) ─────────────────────
  {
    id: "remote-desktop-start-session",
    userMessage: "start a remote desktop session for my phone; confirmed: true",
    expectedAction: "REMOTE_DESKTOP",
    expectedParams: { action: "start" },
    tags: ["remote-desktop", "standard"],
  },
  {
    id: "remote-desktop-connect-from-phone",
    userMessage:
      "start a remote desktop session so I can connect to this machine from my phone; confirmed: true",
    expectedAction: "REMOTE_DESKTOP",
    expectedParams: { action: "start" },
    tags: ["remote-desktop", "standard"],
  },

  // ─── Cross-device broadcast (MESSAGE) ─────────────────────────────────
  // DEVICE_INTENT was retired; cross-device reminder broadcasts go through
  // MESSAGE (or OWNER_REMINDERS for routine reminders).
  {
    id: "intent-sync-broadcast-reminder",
    userMessage: "broadcast a reminder to all my devices",
    expectedAction: "MESSAGE",
    acceptableActions: ["OWNER_REMINDERS"],
    expectedParams: { action: "send" },
    tags: ["intent-sync", "standard"],
    notes: "DEVICE_INTENT retired; MESSAGE handles cross-device delivery.",
  },
  {
    id: "intent-sync-mobile-routine-reminder",
    userMessage:
      "broadcast a routine reminder to my mobile titled 'Stretch break' saying 'Get up and stretch for five minutes'",
    expectedAction: "OWNER_REMINDERS",
    acceptableActions: ["MESSAGE", "OWNER_ROUTINES"],
    expectedParams: { action: "create" },
    tags: ["intent-sync", "standard"],
    notes:
      "DEVICE_INTENT retired; routine reminders belong to OWNER_REMINDERS or OWNER_ROUTINES.",
  },

  // ─── Calendly availability + link (CALENDAR action=check_availability) ─
  {
    id: "calendly-check-availability",
    userMessage:
      "check my Calendly availability for https://api.calendly.com/event_types/abc from 2026-04-20 to 2026-04-24",
    expectedAction: "CALENDAR",
    expectedParams: {
      action: "check_availability",
      eventTypeUri: "https://api.calendly.com/event_types/abc",
      startDate: "2026-04-20",
      endDate: "2026-04-24",
    },
    tags: ["calendly", "scheduling", "standard"],
  },
  {
    id: "calendly-create-single-use-link",
    userMessage:
      "create a single-use Calendly booking link for https://api.calendly.com/event_types/abc",
    expectedAction: "CALENDAR",
    expectedParams: {
      action: "propose_times",
      eventTypeUri: "https://api.calendly.com/event_types/abc",
    },
    tags: ["calendly", "scheduling", "standard"],
    notes: "Calendly provider-only single-use-link routes through CALENDAR.",
  },

  // ─── Owner health (OWNER_HEALTH action=today|trend|...) ───────────────
  {
    id: "health-sleep-last-night",
    userMessage: "how did I sleep last night",
    expectedAction: "OWNER_HEALTH",
    expectedParams: { action: "today" },
    tags: ["health", "standard"],
  },
  {
    id: "health-step-count-today",
    userMessage: "show my step count today",
    expectedAction: "OWNER_HEALTH",
    expectedParams: { action: "today" },
    tags: ["health", "standard"],
  },
];
