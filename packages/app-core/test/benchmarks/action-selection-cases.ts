/**
 * Benchmark case library for the action selection benchmark.
 *
 * Each case is a single natural-language user message and the action we
 * expect the agent to pick (or null for plain chat / no action).
 *
 * Case ids are stable, human-readable slugs. Tags include the primary
 * domain ("scheduling", "email", …) plus a severity tag
 * ("critical" | "standard" | "negative").
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

  // ─── To-dos / habits (LIFE create kind=definition) ────────────────────
  {
    id: "todo-add-simple",
    userMessage: "add a todo: pick up dry cleaning tomorrow",
    expectedAction: "LIFE",
    acceptableActions: ["CREATE_TODO", "LIFE_CREATE_DEFINITION"],
    expectedParams: { subaction: "create", kind: "definition" },
    tags: ["todos", "standard"],
  },
  {
    id: "todo-remember-to-call",
    userMessage: "remember to call mom on Sunday",
    expectedAction: "LIFE",
    acceptableActions: ["CREATE_TODO"],
    tags: ["todos", "standard"],
  },
  {
    id: "habit-daily-meditation",
    userMessage:
      "I want to start a daily habit of meditating for 10 minutes each morning",
    expectedAction: "LIFE",
    acceptableActions: ["CREATE_HABIT"],
    tags: ["habits", "standard"],
  },
  {
    id: "habit-weekly-gym",
    userMessage: "track my gym sessions three times a week",
    expectedAction: "LIFE",
    acceptableActions: ["CREATE_HABIT"],
    tags: ["habits", "standard"],
  },
  {
    id: "todo-list-today",
    userMessage: "what's on my todo list today?",
    expectedAction: "LIFE",
    acceptableActions: ["LIST_TODOS"],
    tags: ["todos", "standard"],
  },

  // ─── Goals (LIFE create kind=goal) ────────────────────────────────────
  {
    id: "goal-save-money",
    userMessage: "set a goal to save $5,000 by the end of the year",
    expectedAction: "LIFE",
    acceptableActions: ["CREATE_GOAL"],
    expectedParams: { subaction: "create", kind: "goal" },
    tags: ["goals", "standard"],
  },
  {
    id: "goal-read-books",
    userMessage: "I want a goal of reading 20 books this year",
    expectedAction: "LIFE",
    acceptableActions: ["CREATE_GOAL"],
    tags: ["goals", "standard"],
  },
  {
    id: "goal-career",
    userMessage: "make getting promoted to senior a goal for me",
    expectedAction: "LIFE",
    acceptableActions: ["CREATE_GOAL"],
    tags: ["goals", "standard"],
  },

  // ─── Check-ins / owner profile ────────────────────────────────────────
  {
    id: "checkin-morning",
    userMessage: "run my morning check-in",
    expectedAction: "OWNER_CHECKIN",
    expectedParams: { subaction: "morning" },
    tags: ["checkin", "standard"],
  },
  {
    id: "checkin-night",
    userMessage: "give me my night check-in",
    expectedAction: "OWNER_CHECKIN",
    expectedParams: { subaction: "night" },
    tags: ["checkin", "standard"],
  },
  {
    id: "owner-profile-travel-prefs",
    userMessage:
      "remember that I prefer aisle seats, carry-on only, and moderate hotels close to the venue",
    expectedAction: "OWNER_PROFILE",
    tags: ["profile", "standard"],
  },

  // ─── Calendar (OWNER_CALENDAR) ────────────────────────────────────────
  {
    id: "cal-next-event",
    userMessage: "what's my next meeting?",
    expectedAction: "OWNER_CALENDAR",
    acceptableActions: ["NEXT_EVENT"],
    expectedParams: { intent: "next_event" },
    tags: ["calendar", "standard"],
  },
  {
    id: "cal-today",
    userMessage: "show me my calendar for today",
    expectedAction: "OWNER_CALENDAR",
    acceptableActions: ["FEED", "CALENDAR_FEED"],
    tags: ["calendar", "standard"],
  },
  {
    id: "cal-create-event",
    userMessage: "schedule a dentist appointment next Tuesday at 3pm",
    expectedAction: "OWNER_CALENDAR",
    acceptableActions: ["CREATE_EVENT"],
    expectedParams: { intent: "create_event" },
    tags: ["calendar", "critical"],
  },
  {
    id: "cal-create-event-meeting",
    userMessage:
      "create a calendar event titled '1:1 with Alex' this Thursday at 10am for 30 minutes",
    expectedAction: "OWNER_CALENDAR",
    acceptableActions: ["CREATE_EVENT"],
    tags: ["calendar", "critical"],
  },
  {
    id: "cal-week-ahead",
    userMessage: "what does my week look like?",
    expectedAction: "OWNER_CALENDAR",
    acceptableActions: ["FEED"],
    tags: ["calendar", "standard"],
  },

  // ─── Email triage (TRIAGE_MESSAGES, channel=gmail) ────────────────────
  {
    id: "email-triage-inbox",
    userMessage: "triage my gmail inbox",
    expectedAction: "TRIAGE_MESSAGES",
    acceptableActions: ["TRIAGE"],
    tags: ["email", "critical"],
  },
  {
    id: "email-unread",
    userMessage: "summarize my unread emails",
    expectedAction: "TRIAGE_MESSAGES",
    acceptableActions: ["LIST_INBOX", "OWNER_CHECKIN"],
    tags: ["email", "standard"],
  },
  {
    id: "email-draft-reply",
    userMessage:
      "draft a reply to the latest email from Sarah saying I'll review it tomorrow",
    expectedAction: "DRAFT_REPLY",
    tags: ["email", "critical"],
  },
  {
    id: "email-send-reply",
    userMessage:
      "send a reply to the last email from finance confirming receipt",
    expectedAction: "RESPOND_TO_MESSAGE",
    acceptableActions: ["SEND_DRAFT"],
    tags: ["email", "critical"],
  },
  {
    id: "email-unsubscribe-sender",
    userMessage: "unsubscribe me from newsletters@medium.com and block them",
    expectedAction: "MANAGE_MESSAGE",
    expectedParams: { operation: "unsubscribe" },
    tags: ["email", "standard"],
  },

  // ─── Inbox (generic) ──────────────────────────────────────────────────
  {
    id: "inbox-triage",
    userMessage: "triage my inbox",
    expectedAction: "TRIAGE_MESSAGES",
    tags: ["inbox", "critical"],
  },
  {
    id: "inbox-digest",
    userMessage: "give me my inbox digest",
    expectedAction: "OWNER_CHECKIN",
    acceptableActions: ["LIST_INBOX"],
    tags: ["inbox", "standard"],
  },
  {
    id: "inbox-respond",
    userMessage: "respond to the messages that need an answer in my inbox",
    expectedAction: "RESPOND_TO_MESSAGE",
    acceptableActions: ["TRIAGE_MESSAGES"],
    tags: ["inbox", "standard"],
  },

  // ─── Website blocking ─────────────────────────────────────────────────
  {
    id: "block-sites-focus",
    userMessage: "block twitter and reddit for the next 2 hours",
    expectedAction: "OWNER_WEBSITE_BLOCK",
    tags: ["focus", "blocking", "critical"],
  },
  {
    id: "block-sites-social",
    userMessage: "turn on a focus block for all social media sites",
    expectedAction: "OWNER_WEBSITE_BLOCK",
    tags: ["focus", "blocking", "standard"],
  },
  {
    id: "block-sites-youtube",
    userMessage: "I keep getting distracted by youtube, block it",
    expectedAction: "OWNER_WEBSITE_BLOCK",
    tags: ["focus", "blocking", "standard"],
  },

  // ─── App blocking ─────────────────────────────────────────────────────
  {
    id: "block-apps-games",
    userMessage: "block all games on my phone until 6pm",
    expectedAction: "OWNER_APP_BLOCK",
    tags: ["focus", "blocking", "standard"],
  },
  {
    id: "block-apps-slack",
    userMessage: "block the slack app while I focus on deep work",
    expectedAction: "OWNER_APP_BLOCK",
    tags: ["focus", "blocking", "standard"],
  },

  // ─── Relationships ────────────────────────────────────────────────────
  {
    id: "rel-list-contacts",
    userMessage: "who are my closest contacts?",
    expectedAction: "OWNER_RELATIONSHIP",
    acceptableActions: ["LIST_CONTACTS", "RELATIONSHIPS"],
    expectedParams: { intent: "list_contacts" },
    tags: ["relationships", "standard"],
  },
  {
    id: "rel-follow-up",
    userMessage:
      "remind me to follow up with David next week about the project",
    expectedAction: "OWNER_RELATIONSHIP",
    acceptableActions: ["ADD_FOLLOW_UP", "SCHEDULE_FOLLOW_UP"],
    expectedParams: { intent: "add_follow_up" },
    tags: ["relationships", "standard"],
  },
  {
    id: "rel-days-since",
    userMessage: "how long has it been since I talked to David?",
    expectedAction: "OWNER_RELATIONSHIP",
    acceptableActions: ["DAYS_SINCE"],
    expectedParams: { intent: "days_since" },
    tags: ["relationships", "standard"],
  },

  // ─── Cross-channel send ───────────────────────────────────────────────
  {
    id: "cross-send-telegram",
    userMessage:
      "send a telegram message to Jane saying I'm running 10 minutes late",
    expectedAction: "SEND_DRAFT",
    acceptableActions: ["RESPOND_TO_MESSAGE"],
    tags: ["messaging", "critical"],
  },
  {
    id: "cross-send-discord",
    userMessage: "post 'standup in 5' to the engineering discord channel",
    expectedAction: "SEND_DRAFT",
    acceptableActions: ["RESPOND_TO_MESSAGE"],
    tags: ["messaging", "standard"],
  },
  {
    id: "cross-send-signal",
    userMessage: "send a Signal message to Priya saying thanks for the review",
    expectedAction: "SEND_DRAFT",
    acceptableActions: ["RESPOND_TO_MESSAGE"],
    tags: ["messaging", "standard"],
  },

  // ─── X / Twitter read ─────────────────────────────────────────────────
  {
    id: "x-read-dms",
    userMessage: "check my twitter DMs",
    expectedAction: "OWNER_X",
    acceptableActions: ["READ_DMS"],
    expectedParams: { intent: "read_dms" },
    tags: ["x", "standard"],
  },
  {
    id: "x-read-feed",
    userMessage: "what's on my X timeline?",
    expectedAction: "OWNER_X",
    acceptableActions: ["READ_FEED"],
    expectedParams: { intent: "read_feed" },
    tags: ["x", "standard"],
  },
  {
    id: "x-search",
    userMessage: "search twitter for posts about elizaOS",
    expectedAction: "OWNER_X",
    acceptableActions: ["SEARCH"],
    expectedParams: { intent: "search" },
    tags: ["x", "standard"],
  },

  // ─── Screen time ──────────────────────────────────────────────────────
  {
    id: "screentime-today",
    userMessage: "how much screen time have I used today?",
    expectedAction: "OWNER_SCREEN_TIME",
    acceptableActions: ["TODAY"],
    expectedParams: { intent: "today" },
    tags: ["screen-time", "standard"],
  },
  {
    id: "screentime-by-app",
    userMessage: "break down my screen time by app this week",
    expectedAction: "OWNER_SCREEN_TIME",
    acceptableActions: ["BY_APP"],
    expectedParams: { intent: "by_app" },
    tags: ["screen-time", "standard"],
  },

  // ─── Scheduling ───────────────────────────────────────────────────────
  {
    id: "sched-start-flow",
    userMessage: "help me schedule a meeting with the design team",
    expectedAction: "OWNER_CALENDAR",
    acceptableActions: ["START"],
    expectedParams: { intent: "start" },
    tags: ["scheduling", "standard"],
  },
  {
    id: "sched-propose-times",
    userMessage:
      "propose three times for a 30 minute sync with Marco next week",
    expectedAction: "OWNER_CALENDAR",
    acceptableActions: [
      "PROPOSE",
      "PROPOSE_MEETING_TIMES",
      "OWNER_CALENDAR",
      "SCHEDULING",
    ],
    expectedParams: { intent: "propose" },
    tags: ["scheduling", "critical"],
  },

  // ─── Twilio voice ─────────────────────────────────────────────────────
  {
    id: "twilio-call-dentist",
    userMessage: "call the dentist and reschedule my appointment",
    expectedAction: "OWNER_VOICE_CALL",
    expectedParams: { subaction: "call_external" },
    tags: ["voice", "critical"],
  },
  {
    id: "twilio-call-support",
    userMessage: "phone my cable company and ask about the outage",
    expectedAction: "OWNER_VOICE_CALL",
    expectedParams: { subaction: "call_external" },
    tags: ["voice", "standard"],
  },
  {
    id: "book-travel-flight",
    userMessage:
      "book travel for me from San Francisco to New York next Thursday and Friday",
    expectedAction: "OWNER_BOOK_TRAVEL",
    tags: ["travel", "standard"],
  },
  {
    id: "browser-manage-settings",
    userMessage: "show me my LifeOps browser settings",
    expectedAction: "MANAGE_LIFEOPS_BROWSER",
    tags: ["browser", "standard"],
  },
  {
    id: "autofill-password-field",
    userMessage:
      "fill the password field on github.com using my password manager",
    expectedAction: "OWNER_AUTOFILL",
    expectedParams: { subaction: "fill" },
    tags: ["browser", "standard"],
  },
  {
    id: "approval-approve-request",
    userMessage: "approve the pending travel booking request",
    expectedAction: "OWNER_RESOLVE_REQUEST",
    expectedParams: { subaction: "approve" },
    tags: ["approval", "standard"],
  },
  {
    id: "approval-reject-request",
    userMessage:
      "reject that pending approval request and say it needs changes",
    expectedAction: "OWNER_RESOLVE_REQUEST",
    expectedParams: { subaction: "reject" },
    tags: ["approval", "standard"],
  },

  // ─── Computer use ─────────────────────────────────────────────────────
  {
    id: "computer-use-click",
    userMessage:
      "open the Finder and create a new folder called Q2-Reports on my desktop",
    expectedAction: "OWNER_COMPUTER_USE",
    tags: ["computer-use", "standard"],
  },
  {
    id: "computer-use-screenshot",
    userMessage: "take a screenshot of my desktop",
    expectedAction: "OWNER_COMPUTER_USE",
    tags: ["computer-use", "standard"],
  },
  {
    id: "subscriptions-cancel-netflix",
    userMessage: "cancel my Netflix subscription",
    expectedAction: "OWNER_SUBSCRIPTIONS",
    acceptableActions: ["OWNER_COMPUTER_USE"],
    tags: ["subscriptions", "critical"],
  },
  {
    id: "subscriptions-cancel-hulu-browser",
    userMessage: "cancel Hulu in my browser",
    expectedAction: "OWNER_SUBSCRIPTIONS",
    acceptableActions: ["MANAGE_LIFEOPS_BROWSER", "OWNER_COMPUTER_USE"],
    tags: ["subscriptions", "critical"],
  },
  {
    id: "subscriptions-cancel-google-play",
    userMessage: "cancel my Google Play subscription",
    expectedAction: "OWNER_SUBSCRIPTIONS",
    acceptableActions: ["OWNER_COMPUTER_USE"],
    tags: ["subscriptions", "critical"],
  },
  {
    id: "subscriptions-cancel-app-store",
    userMessage: "cancel my App Store subscription on this Mac",
    expectedAction: "OWNER_SUBSCRIPTIONS",
    acceptableActions: ["OWNER_COMPUTER_USE"],
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

  // ─── Password manager ─────────────────────────────────────────────────
  {
    id: "password-manager-lookup",
    userMessage: "look up my GitHub password",
    expectedAction: "PASSWORD_MANAGER",
    tags: ["password", "credentials", "standard"],
  },
  {
    id: "password-manager-list-logins",
    userMessage: "show me my saved logins for github.com",
    expectedAction: "PASSWORD_MANAGER",
    tags: ["password", "credentials", "standard"],
  },

  // ─── Remote desktop ───────────────────────────────────────────────────
  {
    id: "remote-desktop-start-session",
    userMessage: "start a remote desktop session for my phone; confirmed: true",
    expectedAction: "OWNER_REMOTE_DESKTOP",
    acceptableActions: ["OWNER_REMOTE_DESKTOP"],
    tags: ["remote-desktop", "standard"],
  },
  {
    id: "remote-desktop-connect-from-phone",
    userMessage:
      "start a remote desktop session so I can connect to this machine from my phone; confirmed: true",
    expectedAction: "OWNER_REMOTE_DESKTOP",
    acceptableActions: ["OWNER_REMOTE_DESKTOP"],
    tags: ["remote-desktop", "standard"],
  },

  // ─── Intent sync (cross-device broadcast) ─────────────────────────────
  {
    id: "intent-sync-broadcast-reminder",
    userMessage: "broadcast a reminder to all my devices",
    expectedAction: "OWNER_DEVICE_INTENT",
    acceptableActions: ["SEND_DRAFT"],
    tags: ["intent-sync", "standard"],
  },
  {
    id: "intent-sync-mobile-routine-reminder",
    userMessage:
      "broadcast a routine reminder to my mobile titled 'Stretch break' saying 'Get up and stretch for five minutes'",
    expectedAction: "OWNER_DEVICE_INTENT",
    expectedParams: {
      subaction: "broadcast",
      kind: "routine_reminder",
      target: "mobile",
      title: "Stretch break",
      body: "Get up and stretch for five minutes",
    },
    tags: ["intent-sync", "standard"],
  },

  // ─── Calendly ─────────────────────────────────────────────────────────
  {
    id: "calendly-check-availability",
    userMessage:
      "check my Calendly availability for https://api.calendly.com/event_types/abc from 2026-04-20 to 2026-04-24",
    expectedAction: "OWNER_CALENDAR",
    expectedParams: {
      subaction: "availability",
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
    expectedAction: "OWNER_CALENDAR",
    expectedParams: {
      subaction: "single_use_link",
      eventTypeUri: "https://api.calendly.com/event_types/abc",
    },
    tags: ["calendly", "scheduling", "standard"],
  },

  // ─── Health ───────────────────────────────────────────────────────────
  {
    id: "health-sleep-last-night",
    userMessage: "how did I sleep last night",
    expectedAction: "HEALTH",
    tags: ["health", "standard"],
  },
  {
    id: "health-step-count-today",
    userMessage: "show my step count today",
    expectedAction: "HEALTH",
    tags: ["health", "standard"],
  },
];
