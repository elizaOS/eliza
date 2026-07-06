/**
 * Built-in view declarations for the core first-party shell pages.
 *
 * These views are part of the main shell bundle — no `bundlePath` and no
 * `bundleUrl` are needed. They are registered in the view registry so
 * GET /api/views returns them, the agent can discover and navigate to them
 * by name, and they appear in the view manager.
 */

import type { ViewDeclaration } from "@elizaos/core";

export const BUILTIN_VIEWS: ViewDeclaration[] = [
  {
    id: "camera",
    viewKind: "preview",
    label: "Camera",
    description:
      "Live camera preview with photo capture and front/back switching",
    icon: "Camera",
    heroImagePath: "assets/view-heroes/camera.png",
    path: "/camera",
    order: 3,
    tags: ["camera", "photo", "capture", "video", "vision"],
    visibleInManager: true,
    desktopTabEnabled: true,
    platforms: ["android"],
    nativeOs: true,
  },
  {
    id: "chat",
    viewKind: "system",
    label: "Messages",
    description:
      "Conversations with your agent, inbound messages from every connector",
    icon: "MessageSquare",
    heroImagePath: "assets/view-heroes/chat.png",
    path: "/chat",
    order: 1,
    tags: ["messaging", "conversation", "agent"],
    anticipatoryIntent:
      "Offer to pick up the most recent thread or surface anything the user left unfinished, and ask what they want to work on next.",
    visibleInManager: true,
    desktopTabEnabled: true,
    platforms: ["web", "desktop", "ios", "android"],
  },
  {
    id: "character",
    viewKind: "system",
    label: "Character",
    description: "Agent identity, personality, style, and knowledge documents",
    icon: "UserRound",
    heroImagePath: "assets/view-heroes/character.png",
    path: "/character",
    order: 50,
    tags: ["identity", "personality", "character"],
    // CHARACTER/PERSONALITY are the semantic twins of the editor's field
    // writes; the scoped actions below add view-targeted fill/click verbs.
    relatedActions: ["CHARACTER", "PERSONALITY"],
    anticipatoryIntent:
      "Offer to refine the agent's identity, personality, or style from the current character state, and point out the highest-leverage next edit.",
    // The scoped actions below expand into mutating `agent-fill`/`agent-click`
    // interactions, which the route/dispatch gate denies unless the view opts
    // into agent control via the `agent-surface` grant (read-only introspection
    // stays open without it). This is the only built-in view driving the agent
    // surface, so it is the only one that declares the grant.
    surface: { capabilities: ["agent-surface"] },
    // Named actions the agent can invoke ONLY while the Character view is the
    // foreground view (#14155, deferred step 8 of #13591/#14123). Each targets
    // a `useAgentElement` id in the Character editor (`CharacterEditor` /
    // `CharacterEditorPanels`) and expands into the same `agent-fill`/
    // `agent-click` interact sequence the element-level protocol drives — no
    // parallel DOM path. Only ids that are ALWAYS mounted are targeted: the
    // editor renders all three panels (personality/style/examples) up front and
    // toggles visibility with CSS (`hidden`/`display:none`), so `identity-bio`,
    // `style-add-input-all`/`style-add-all`, `example-add-conversation`, and
    // `post-example-add` are registered regardless of the active tab. Row-level
    // ids (`style-rule-remove-<section>-<index>`, `example-message-<c>-<m>`) are
    // index-dependent and only mounted when that row exists, so they are NOT
    // declared here — a blind declaration against them would target an unmounted
    // element and fail loudly (`VIEW_SCOPED_ACTION_ELEMENT_MISSING`).
    scopedActions: [
      {
        name: "VIEW_CHARACTER_FILL_BIO",
        description:
          "Set the agent's bio / about-me text on the Character view's Personality section. Autosaves.",
        similes: [
          "set bio",
          "edit bio",
          "update about me",
          "write the agent's bio",
          "rewrite the character bio",
        ],
        parameters: ["bio"],
        steps: [
          { kind: "agent-fill", target: "identity-bio", value: "{{bio}}" },
        ],
      },
      {
        name: "VIEW_CHARACTER_ADD_STYLE_RULE",
        description:
          "Add a style rule to the agent's writing style on the Character view's Style section. Autosaves.",
        similes: [
          "add style rule",
          "add a writing style rule",
          "add style guideline",
          "append a style rule",
        ],
        parameters: ["rule"],
        steps: [
          {
            kind: "agent-fill",
            target: "style-add-input-all",
            value: "{{rule}}",
          },
          { kind: "agent-click", target: "style-add-all" },
        ],
      },
      {
        name: "VIEW_CHARACTER_ADD_MESSAGE_EXAMPLE",
        description:
          "Add a new chat-example conversation on the Character view's Examples section, ready for turns to be filled in. Autosaves.",
        similes: [
          "add message example",
          "add a chat example",
          "add conversation example",
          "create a new example conversation",
        ],
        steps: [{ kind: "agent-click", target: "example-add-conversation" }],
      },
    ],
    visibleInManager: true,
    desktopTabEnabled: true,
  },
  {
    id: "documents",
    viewKind: "system",
    label: "Knowledge",
    description:
      "The multimedia knowledge hub — documents, images, audio, video, and transcripts, filtered by media type and scope, with a unified reader",
    icon: "FileText",
    heroImagePath: "assets/view-heroes/character.png",
    path: "/character/documents",
    order: 51,
    tags: [
      "documents",
      "knowledge",
      "files",
      "uploads",
      "retrieval",
      "transcripts",
      "audio",
      "video",
      "images",
      "media",
      "attachments",
    ],
    // OWNER_DOCUMENTS is the personal-assistant signature/portal umbrella;
    // DOCUMENT (core documents feature) is the CRUD twin of the view's
    // upload/delete controls (#14369 ratchet mapping).
    relatedActions: ["OWNER_DOCUMENTS", "DOCUMENT"],
    anticipatoryIntent:
      "Offer to triage the newest ingested attachments/documents — summarize, tag, or file them — grounded in the recent-attachment counts.",
    visibleInManager: true,
    desktopTabEnabled: true,
  },
  {
    id: "automations",
    viewKind: "system",
    label: "Automations",
    description: "Scheduled tasks and recurring workflows",
    icon: "Clock3",
    heroImagePath: "assets/view-heroes/automations.png",
    path: "/automations",
    order: 55,
    tags: ["automation", "tasks", "scheduling"],
    // SCHEDULED_TASKS is the umbrella over the one scheduler (workflows are
    // ScheduledTask records); TRIGGER pairs the trigger editor (#14369).
    relatedActions: ["SCHEDULED_TASKS", "TRIGGER"],
    anticipatoryIntent:
      "Offer to create a new scheduled workflow or check on existing automations — flag any recently failed runs — grounded in the live task list.",
    visibleInManager: true,
  },
  {
    id: "plugins-page",
    viewKind: "system",
    label: "Plugins",
    description: "Manage installed plugins, configure credentials",
    icon: "Puzzle",
    heroImagePath: "assets/view-heroes/plugins-page.png",
    path: "/apps/plugins",
    order: 60,
    tags: [
      "plugins",
      "plugin-browser",
      "plugin browser",
      "plugin-manager",
      "plugin manager",
      "configuration",
      "extensions",
    ],
    // PLUGIN is the install/enable/configure twin of the plugin browser's
    // controls (#14369 ratchet mapping); RUNTIME stays per #13589.
    relatedActions: ["RUNTIME", "PLUGIN"],
    anticipatoryIntent:
      "Offer to install, configure, or troubleshoot a plugin — surface the smallest setup gap — grounded in installed-plugin and health state.",
    visibleInManager: true,
  },
  {
    id: "trajectories",
    viewKind: "developer",
    developerOnly: true,
    label: "Trajectories",
    description: "Agent trajectory logs and training data",
    icon: "GitBranch",
    heroImagePath: "assets/view-heroes/trajectories.png",
    path: "/apps/trajectories",
    order: 70,
    tags: ["training", "logs", "trajectories"],
    visibleInManager: true,
  },
  {
    // Folded into the Knowledge hub (#13594): transcript records read in the hub
    // under its Transcripts media-format facet + word-synced reader. This entry
    // stays only as the chrome-minimal LIVE-meeting affordance (#11856) — a
    // deep-link surface, not a separate manager view or launcher tile.
    id: "transcripts",
    viewKind: "system",
    label: "Live meeting",
    description:
      "Join a live meeting and capture its transcript; recorded transcripts read in the Knowledge hub",
    icon: "AudioLines",
    heroImagePath: "assets/view-heroes/transcripts.png",
    path: "/apps/transcripts",
    order: 71,
    tags: ["transcript", "voice", "recording", "audio", "meeting"],
    anticipatoryIntent:
      "Offer to summarize or extract action items from the most recent voice transcripts, grounded in the recent-transcript count.",
    visibleInManager: false,
  },
  {
    id: "memories",
    viewKind: "system",
    developerOnly: false,
    label: "Memories",
    description: "Agent memory viewer and management",
    icon: "Brain",
    heroImagePath: "assets/view-heroes/memories.png",
    path: "/apps/memories",
    order: 72,
    tags: ["memory", "knowledge"],
    // MEMORY (op:create|search|update|delete) is the chat twin of the viewer's
    // browse/prune controls (#14366 closed it; #14369 pins the affinity).
    relatedActions: ["MEMORY"],
    anticipatoryIntent:
      "Offer to search, review, or prune the agent's stored memories, and point to what's worth revisiting.",
    visibleInManager: true,
  },
  {
    id: "database",
    viewKind: "developer",
    developerOnly: true,
    label: "Database",
    description: "Raw database viewer and query interface",
    icon: "Database",
    heroImagePath: "assets/view-heroes/database.png",
    path: "/apps/database",
    order: 80,
    tags: ["database", "data", "debug"],
    visibleInManager: true,
  },
  {
    id: "logs",
    viewKind: "developer",
    developerOnly: true,
    label: "Logs",
    description: "Runtime logs and agent debug output",
    icon: "FileText",
    heroImagePath: "assets/view-heroes/logs.png",
    path: "/apps/logs",
    order: 81,
    tags: ["logs", "debug", "runtime"],
    visibleInManager: true,
  },
  {
    id: "settings",
    viewKind: "system",
    label: "Settings",
    description: "Configuration, plugins, credentials, and preferences",
    icon: "Settings",
    heroImagePath: "assets/view-heroes/settings.png",
    path: "/settings",
    order: 90,
    tags: ["configuration", "preferences", "plugins"],
    // SETTINGS is the consolidated section write action (#14364); RUNTIME
    // stays for the runtime/status affinity the #13589 stub migration pinned.
    relatedActions: ["RUNTIME", "SETTINGS"],
    anticipatoryIntent:
      "Offer to set up the model/provider, voice, or connectors — recommend the smallest concrete configuration step from current settings state.",
    visibleInManager: true,
    desktopTabEnabled: true,
  },
  {
    id: "background",
    viewKind: "preview",
    label: "Background",
    description:
      "Set the app background — pick a shader color, upload an image, or generate one",
    icon: "Image",
    heroImagePath: "assets/view-heroes/background.png",
    path: "/background",
    order: 92,
    tags: ["background", "wallpaper", "color", "theme", "appearance", "image"],
    // BACKGROUND is the one-write-two-triggers exemplar: the view controls and
    // the action drive the same store (#14369 pins the affinity).
    relatedActions: ["BACKGROUND"],
    anticipatoryIntent:
      "Offer to set the app background — pick a shader color, generate an image, or use an upload.",
    visibleInManager: true,
    desktopTabEnabled: true,
    platforms: ["web", "desktop", "ios", "android"],
  },
];
