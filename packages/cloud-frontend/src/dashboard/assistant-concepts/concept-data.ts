export type AssistantDirection = {
  id: string;
  name: string;
  thesis: string;
  textPolicy: string;
  voicePolicy: string;
  controls: string;
  attachmentPattern: string;
  appPattern: string;
  suggestionPattern: string;
};

export type AssistantLook = {
  id: string;
  name: string;
  visualSystem: string;
  palette: string;
  avatarStyle: string;
  motion: string;
};

export type AssistantConcept = {
  id: string;
  directionId: string;
  lookId: string;
  direction: string;
  look: string;
  title: string;
  shortPitch: string;
  pitch: string;
  voiceBehavior: string;
  transcriptBehavior: string;
  controls: string;
  attachments: string;
  appLoading: string;
  suggestions: string;
  bestFor: string;
  risks: string;
};

export type ResearchFinding = {
  source: string;
  url: string;
  finding: string;
};

export const researchFindings: ResearchFinding[] = [
  {
    source: "OpenAI Voice FAQ",
    url: "https://help.openai.com/en/articles/8400625-voice-mode-faq",
    finding:
      "Voice can run inside the main chat or in a separate orb-style mode, with distinct affordances for live voice, dictation, video, mute, and ending a session.",
  },
  {
    source: "OpenAI release notes",
    url: "https://help.openai.com/en/articles/6825453-chatgpt-release-notes",
    finding:
      "Recent ChatGPT voice updates emphasize inline voice, real-time visible answers, preserved chat context, visual cards, richer uploads, and compact tool menus.",
  },
  {
    source: "Claude Help Center",
    url: "https://support.claude.com/en/articles/11101966-use-voice-mode",
    finding:
      "Claude supports switching text and voice in the same conversation, hands-free and push-to-talk modes, full saved transcripts, voice choices, and barge-in by speaking again.",
  },
  {
    source: "Android Gemini Live",
    url: "https://www.android.com/articles/gemini-on-android/",
    finding:
      "Gemini Live treats camera and screen sharing as first-class live context, with real-time feedback, interruption, pause, stop sharing, and camera/screen switching.",
  },
  {
    source: "Gemini Live Help",
    url: "https://support.google.com/gemini/answer/15274899",
    finding:
      "Gemini saves Live transcripts when activity is enabled and lets users exit Live to review the conversation, reinforcing the transcript as both memory and audit trail.",
  },
];

export const assistantDirections: AssistantDirection[] = [
  {
    id: "inline-thread",
    name: "Inline Thread Voice",
    thesis:
      "Voice lives inside the normal chat instead of taking over the app.",
    textPolicy:
      "Text is always visible, with live voice fragments folded into the current turn.",
    voicePolicy:
      "Hands-free by default; speaking again interrupts the assistant.",
    controls: "Composer button changes from voice to send when text exists.",
    attachmentPattern:
      "Attachment chips remain above the composer during voice.",
    appPattern: "Apps render as inline result cards inside the thread.",
    suggestionPattern:
      "Suggestions appear as small chips under the active assistant turn.",
  },
  {
    id: "ambient-avatar",
    name: "Ambient Avatar Room",
    thesis:
      "The avatar is the primary presence; chat recedes until it matters.",
    textPolicy:
      "Transcript hides behind a side rail and expands on hover or scroll.",
    voicePolicy:
      "Always-ready wake state with visible privacy and mute feedback.",
    controls:
      "One large hold/tap orb handles talk, mute, interrupt, and send states.",
    attachmentPattern: "Dropped files orbit the avatar until referenced.",
    appPattern: "Apps load as floating panels around the avatar.",
    suggestionPattern:
      "The avatar offers context-aware prompts as quiet stage captions.",
  },
  {
    id: "command-center",
    name: "Command Center",
    thesis: "A dense operator console for power users running tools and apps.",
    textPolicy: "Transcript stays persistent with collapsible tool logs.",
    voicePolicy: "Push-to-talk is favored for noisy, high-stakes work.",
    controls: "Compact icon toolbar with keyboard-visible command palette.",
    attachmentPattern: "Files pin into a context shelf with status and scope.",
    appPattern: "Apps launch into resizable panes with run history.",
    suggestionPattern:
      "Suggestions rank by confidence and show expected action.",
  },
  {
    id: "daily-companion",
    name: "Daily Companion",
    thesis:
      "A warm home screen for planning, reminders, and recurring check-ins.",
    textPolicy:
      "Only the useful summary is prominent; raw transcript is tucked away.",
    voicePolicy:
      "Short natural turns with gentle confirmation for commitments.",
    controls: "A small mode switch toggles listen, quiet, and type states.",
    attachmentPattern: "Photos and notes become timeline memories.",
    appPattern:
      "Calendar, tasks, weather, and home apps appear as glance tiles.",
    suggestionPattern:
      "Suggested next steps are timed to the day and current routine.",
  },
  {
    id: "workspace-copilot",
    name: "Workspace Copilot",
    thesis: "Voice and chat sit beside documents, meetings, and project apps.",
    textPolicy: "Transcript anchors to the artifact being discussed.",
    voicePolicy:
      "Barge-in and correction are visible as branches, not lost events.",
    controls: "Primary button starts voice unless a draft or selection exists.",
    attachmentPattern: "Uploads are grouped by project and referenced inline.",
    appPattern: "Apps load as document-aware workspaces with citations.",
    suggestionPattern: "Suggestions are next edits, follow-ups, and handoffs.",
  },
  {
    id: "zero-button",
    name: "Zero Button Flow",
    thesis:
      "The assistant suggests the next available action instead of showing chrome.",
    textPolicy:
      "Transcript appears only after an interaction crosses a confidence threshold.",
    voicePolicy: "Listening is inferred from focus, wake phrase, or proximity.",
    controls: "No fixed buttons; actions appear as reversible intent chips.",
    attachmentPattern: "Drag, paste, and share sheet are the main inputs.",
    appPattern: "Apps are suggested when intent is detected, then confirmed.",
    suggestionPattern: "Suggestions replace navigation and toolbar controls.",
  },
  {
    id: "privacy-first",
    name: "Privacy First",
    thesis:
      "The interface makes listening, storage, and sharing impossible to miss.",
    textPolicy: "Transcript has explicit save, redact, and forget affordances.",
    voicePolicy:
      "Strong mic state, local/offline badge, and push-to-talk preference.",
    controls: "Mute is always visible and never shares a state with send.",
    attachmentPattern:
      "Attachments show retention, destination, and permission scope.",
    appPattern:
      "Apps must request visible scoped access before loading context.",
    suggestionPattern: "Suggestions explain why they need data before acting.",
  },
  {
    id: "live-context",
    name: "Live Context Lens",
    thesis:
      "Camera, screen share, and files are peer inputs to voice and text.",
    textPolicy: "Transcript is interleaved with what the assistant saw.",
    voicePolicy: "Voice stays active while visual context changes.",
    controls: "Camera, screen, and mic are a segmented live-source control.",
    attachmentPattern:
      "Sources show live badges, paused badges, and snapshots.",
    appPattern: "Apps open from recognized objects, screens, and documents.",
    suggestionPattern: "Suggestions point at visible context with annotations.",
  },
  {
    id: "focus-capsule",
    name: "Focus Capsule",
    thesis:
      "A compact assistant window floats over other work without becoming a tab.",
    textPolicy: "Only the current turn and last decision are visible.",
    voicePolicy:
      "Voice uses short audible states for listen, think, and reply.",
    controls: "The capsule edge hosts a single adaptive action button.",
    attachmentPattern: "Attachments are tiny badges that expand into a drawer.",
    appPattern:
      "Apps open as detachable cards that snap back into the capsule.",
    suggestionPattern: "Suggestions are one-line nudges that time out.",
  },
  {
    id: "meeting-studio",
    name: "Meeting Studio",
    thesis:
      "The assistant handles capture, recap, and action extraction during live talk.",
    textPolicy:
      "Live captions are prominent; final transcript is structured later.",
    voicePolicy:
      "Ambient listening can pause, mark, and resume with a clear ledger.",
    controls: "Record, mute, mark, and ask are grouped by meeting state.",
    attachmentPattern:
      "Slides, docs, and screenshots are attached to transcript moments.",
    appPattern: "Apps load as recap, CRM, ticket, or calendar handoff cards.",
    suggestionPattern:
      "Suggestions identify decisions, owners, and unanswered questions.",
  },
  {
    id: "gamepad",
    name: "Gamepad Assistant",
    thesis: "Controls are thumb-friendly for TV, car, and couch contexts.",
    textPolicy: "Text is large, sparse, and scrolls in short cards.",
    voicePolicy: "Voice is the main input with explicit noisy-room fallback.",
    controls: "Directional selection plus a hold-to-talk center action.",
    attachmentPattern: "Attachments are cast, scan, or nearby-device handoffs.",
    appPattern: "Apps launch full-screen with voice overlays.",
    suggestionPattern: "Suggestions map to directional buttons.",
  },
  {
    id: "developer-shell",
    name: "Developer Shell",
    thesis:
      "Chat, voice, terminal, logs, and app previews share one command surface.",
    textPolicy: "Transcript supports code blocks, diffs, logs, and replay.",
    voicePolicy:
      "Voice can dictate commands but requires visible confirmation for runs.",
    controls: "Send/voice/run are context-sensitive around the active draft.",
    attachmentPattern:
      "Repos, logs, images, and traces pin into a debugging shelf.",
    appPattern: "Apps load as preview panes with inspectable state.",
    suggestionPattern:
      "Suggestions are tests, patches, repro steps, and rollbacks.",
  },
  {
    id: "creative-studio",
    name: "Creative Studio",
    thesis:
      "The assistant is a co-director for image, audio, video, and layout work.",
    textPolicy: "Transcript condenses into creative decisions and variants.",
    voicePolicy:
      "Voice stays conversational while media renders in the background.",
    controls: "A single create/refine button changes based on selection.",
    attachmentPattern: "Attachments appear on a moodboard canvas.",
    appPattern: "Apps load as generators, editors, and comparison boards.",
    suggestionPattern:
      "Suggestions are aesthetic directions and variant prompts.",
  },
  {
    id: "task-pipeline",
    name: "Task Pipeline",
    thesis:
      "Every assistant turn becomes a visible state machine from request to result.",
    textPolicy: "Chat is secondary to task status, evidence, and handoff.",
    voicePolicy: "Voice confirms task boundaries and asks only when blocked.",
    controls: "Primary action advances, pauses, or cancels the current task.",
    attachmentPattern: "Attachments bind to pipeline steps.",
    appPattern: "Apps are loaders, executors, reviewers, and delivery targets.",
    suggestionPattern: "Suggestions are next safe pipeline transitions.",
  },
  {
    id: "split-brain",
    name: "Split Brain",
    thesis:
      "Separate quick voice from deep text without losing shared context.",
    textPolicy: "Voice notes summarize into the main thread after each burst.",
    voicePolicy:
      "A lightweight side channel accepts interruptions while text runs.",
    controls: "Voice pill sits beside a full composer and model selector.",
    attachmentPattern:
      "Attachments choose quick context or deep context scope.",
    appPattern: "Apps can attach to the quick channel or main workspace.",
    suggestionPattern:
      "Suggestions help decide whether to speak, type, or attach.",
  },
  {
    id: "inbox-home",
    name: "Inbox Home",
    thesis:
      "The assistant starts from what is waiting: messages, apps, approvals, alerts.",
    textPolicy: "Transcript appears as needed under each inbox item.",
    voicePolicy:
      "Voice triages items and reads only summaries unless expanded.",
    controls: "Approve, snooze, reply, and ask share a compact action row.",
    attachmentPattern:
      "Incoming attachments are grouped by sender and urgency.",
    appPattern: "Apps open as item-specific detail sheets.",
    suggestionPattern: "Suggestions are triage actions and drafted replies.",
  },
  {
    id: "learn-mode",
    name: "Learn Mode",
    thesis:
      "The assistant teaches with voice, text, diagrams, and checks for understanding.",
    textPolicy: "Transcript is structured as lesson notes, not raw chat.",
    voicePolicy: "Voice asks short checks and adapts pace visibly.",
    controls: "Replay, slower, example, quiz, and next live near the response.",
    attachmentPattern:
      "Attachments become study material with generated outlines.",
    appPattern: "Apps load as whiteboards, flashcards, sims, and exercises.",
    suggestionPattern:
      "Suggestions are questions the learner may be about to ask.",
  },
  {
    id: "concierge-market",
    name: "Concierge Market",
    thesis:
      "Assistant responses can load mini apps for booking, buying, comparing, or installing.",
    textPolicy: "Chat explains options while app cards handle decisions.",
    voicePolicy: "Voice is persuasive but pauses before irreversible actions.",
    controls: "Primary button becomes compare, book, buy, install, or send.",
    attachmentPattern:
      "Receipts, photos, and preferences become shopping context.",
    appPattern:
      "Apps load from a verified app tray with permissions and pricing.",
    suggestionPattern: "Suggestions are ranked choices with tradeoffs.",
  },
  {
    id: "minimal-log",
    name: "Minimal Log",
    thesis:
      "The home screen is almost empty until the assistant has useful state to show.",
    textPolicy:
      "Only important turns survive; filler transcript is hidden by default.",
    voicePolicy: "Listening uses subtle animation and a clear mute lock.",
    controls: "One composer, one source menu, one history drawer.",
    attachmentPattern: "Attachments show only count and type until opened.",
    appPattern:
      "Apps load as temporary overlays that disappear after completion.",
    suggestionPattern: "Suggestions are rare and high-confidence.",
  },
  {
    id: "shared-room",
    name: "Shared Room",
    thesis:
      "A multi-person home assistant with roles, permissions, and visible handoff.",
    textPolicy:
      "Transcript labels speaker, device, room, and permission state.",
    voicePolicy: "Voice identifies who is speaking before acting.",
    controls:
      "Household controls distinguish ask, announce, private, and broadcast.",
    attachmentPattern:
      "Attachments inherit room, person, and retention policy.",
    appPattern: "Apps load with role-aware controls and shared cursors.",
    suggestionPattern: "Suggestions adapt by speaker and group context.",
  },
];

export const assistantLooks: AssistantLook[] = [
  {
    id: "mono-glass",
    name: "Mono Glass",
    visualSystem:
      "Translucent panels, dense typography, and restrained controls.",
    palette: "Black, white, graphite, and a precise orange accent.",
    avatarStyle: "A soft monochrome lightform with thin waveform rings.",
    motion:
      "Slow breathing motion; sharp state changes for privacy and errors.",
  },
  {
    id: "warm-hardware",
    name: "Warm Hardware",
    visualSystem: "Physical controls, engraved dividers, and tactile surfaces.",
    palette:
      "Charcoal, warm gray, ivory text, safety orange, and signal green.",
    avatarStyle: "A small device-like face with LEDs and material highlights.",
    motion: "Mechanical snaps, LED sweeps, and clear press states.",
  },
  {
    id: "editorial-calm",
    name: "Editorial Calm",
    visualSystem:
      "Reading-first hierarchy with generous whitespace and crisp captions.",
    palette: "Ink, paper white, muted olive, orange marks, and soft gray.",
    avatarStyle:
      "A portrait medallion that reacts with expression and posture.",
    motion: "Page-like reveals, transcript fades, and deliberate turn markers.",
  },
  {
    id: "signal-console",
    name: "Signal Console",
    visualSystem:
      "Operational dashboard with telemetry strips and compact panes.",
    palette: "Near black, white, amber, green, and red status accents.",
    avatarStyle: "A signal scope that merges waveform, spectrum, and intent.",
    motion: "Live meters, scan lines, and discrete task-state transitions.",
  },
  {
    id: "soft-sci-fi",
    name: "Soft Sci-Fi",
    visualSystem:
      "Immersive depth, luminous borders, and spatial source layers.",
    palette:
      "Black, pearl, orange glow, pale green, and muted violet sparingly.",
    avatarStyle:
      "A dimensional orb/face hybrid that reacts to source confidence.",
    motion:
      "Fluid source morphs, gentle parallax, and visible interrupt ripples.",
  },
];

function conceptId(directionId: string, lookId: string) {
  return `${directionId}-${lookId}`;
}

function titleFor(direction: AssistantDirection, look: AssistantLook) {
  return `${direction.name} / ${look.name}`;
}

function bestFor(direction: AssistantDirection) {
  if (direction.id.includes("privacy"))
    return "Trust-sensitive assistants, families, and enterprise tenants.";
  if (direction.id.includes("developer"))
    return "Engineering, local-agent, and debugging workflows.";
  if (direction.id.includes("creative"))
    return "Media generation, visual work, and taste exploration.";
  if (direction.id.includes("meeting"))
    return "Calls, interviews, classrooms, and group capture.";
  if (direction.id.includes("live-context"))
    return "Camera, screen, home, and mobile troubleshooting.";
  if (direction.id.includes("zero"))
    return "Consumer home screens where chrome should disappear.";
  return "General assistant home surfaces that need voice, chat, apps, and attachments together.";
}

function riskFor(direction: AssistantDirection, look: AssistantLook) {
  const risks = [
    direction.textPolicy.includes("hides") ||
    direction.textPolicy.includes("hidden")
      ? "Hidden text may reduce auditability unless transcript recall is obvious."
      : "Persistent text can make the assistant feel less voice-native if hierarchy is too heavy.",
    look.id === "soft-sci-fi"
      ? "Immersive motion must be checked for performance and distraction."
      : "The restrained visual system needs strong empty states to avoid feeling sparse.",
    direction.voicePolicy.includes("Always") ||
    direction.voicePolicy.includes("inferred")
      ? "Always-ready listening needs unmistakable privacy and mute semantics."
      : "Manual voice controls may add friction if they are not adaptive.",
  ];
  return risks.join(" ");
}

export const assistantConcepts: AssistantConcept[] =
  assistantDirections.flatMap((direction) =>
    assistantLooks.map((look) => ({
      id: conceptId(direction.id, look.id),
      directionId: direction.id,
      lookId: look.id,
      direction: direction.name,
      look: look.name,
      title: titleFor(direction, look),
      shortPitch: direction.thesis,
      pitch: `${direction.thesis} The ${look.name.toLowerCase()} treatment uses ${look.visualSystem.toLowerCase()} to make the state model inspectable while keeping the home surface distinct.`,
      voiceBehavior: `${direction.voicePolicy} ${look.motion}`,
      transcriptBehavior: direction.textPolicy,
      controls: direction.controls,
      attachments: direction.attachmentPattern,
      appLoading: direction.appPattern,
      suggestions: direction.suggestionPattern,
      bestFor: bestFor(direction),
      risks: riskFor(direction, look),
    })),
  );

export const assistantConceptCount = assistantConcepts.length;

export const assistantConceptFilterOptions = {
  directions: assistantDirections.map((direction) => direction.name),
  looks: assistantLooks.map((look) => look.name),
  directionIds: assistantDirections.map((direction) => direction.id),
  lookIds: assistantLooks.map((look) => look.id),
};
