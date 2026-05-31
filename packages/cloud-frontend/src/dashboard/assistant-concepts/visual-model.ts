import type { AssistantConcept } from "./concept-data";

export type LayoutDensity = "sparse" | "balanced" | "dense";
export type PrimarySurface =
  | "thread"
  | "stage"
  | "console"
  | "canvas"
  | "timeline"
  | "pipeline"
  | "inbox";
export type SourceKind =
  | "voice"
  | "text"
  | "file"
  | "camera"
  | "screen"
  | "app";
export type ControlModel =
  | "composer"
  | "orb"
  | "toolbar"
  | "chips"
  | "gamepad"
  | "pipeline";
export type AppPlacement =
  | "inline"
  | "side-pane"
  | "floating"
  | "sheet"
  | "grid"
  | "full-screen";
export type TranscriptPlacement =
  | "inline"
  | "rail"
  | "hidden-drawer"
  | "caption-strip"
  | "artifact-bound";
export type AvatarShape =
  | "orb"
  | "portrait"
  | "device"
  | "scope"
  | "capsule"
  | "presence";

export type DirectionVisualRecipe = {
  id: AssistantConcept["directionId"];
  layoutDensity: LayoutDensity;
  primarySurface: PrimarySurface;
  sourceMix: SourceKind[];
  controlModel: ControlModel;
  appPlacement: AppPlacement;
  transcriptPlacement: TranscriptPlacement;
  avatarShape: AvatarShape;
  heroLabel: string;
  appLabel: string;
  transcriptLabel: string;
  suggestionLabels: string[];
};

export type LookVisualSkin = {
  id: AssistantConcept["lookId"];
  name: string;
  frameClass: string;
  panelClass: string;
  quietPanelClass: string;
  accentClass: string;
  avatarClass: string;
  lineClass: string;
  imageBackdrop: string;
  imageAccent: string;
  imageSecondary: string;
};

export type ConceptVisualModel = DirectionVisualRecipe &
  LookVisualSkin & {
    imageUrl: string;
    imagePrompt: string;
  };

const directionRecipes = {
  "inline-thread": {
    id: "inline-thread",
    layoutDensity: "balanced",
    primarySurface: "thread",
    sourceMix: ["voice", "text", "file", "app"],
    controlModel: "composer",
    appPlacement: "inline",
    transcriptPlacement: "inline",
    avatarShape: "presence",
    heroLabel: "Live thread",
    appLabel: "Weather card",
    transcriptLabel: "Transcript streams in the latest reply",
    suggestionLabels: ["Attach last file", "Continue by voice", "Load app"],
  },
  "ambient-avatar": {
    id: "ambient-avatar",
    layoutDensity: "sparse",
    primarySurface: "stage",
    sourceMix: ["voice", "file", "camera", "app"],
    controlModel: "orb",
    appPlacement: "floating",
    transcriptPlacement: "rail",
    avatarShape: "orb",
    heroLabel: "Avatar stage",
    appLabel: "Floating app",
    transcriptLabel: "Side rail transcript",
    suggestionLabels: ["Dim text", "Show context", "Quiet mode"],
  },
  "command-center": {
    id: "command-center",
    layoutDensity: "dense",
    primarySurface: "console",
    sourceMix: ["voice", "text", "file", "screen", "app"],
    controlModel: "toolbar",
    appPlacement: "side-pane",
    transcriptPlacement: "rail",
    avatarShape: "scope",
    heroLabel: "Operations console",
    appLabel: "Tool pane",
    transcriptLabel: "Command log",
    suggestionLabels: ["Run", "Inspect", "Escalate"],
  },
  "daily-companion": {
    id: "daily-companion",
    layoutDensity: "balanced",
    primarySurface: "timeline",
    sourceMix: ["voice", "text", "app"],
    controlModel: "chips",
    appPlacement: "grid",
    transcriptPlacement: "hidden-drawer",
    avatarShape: "portrait",
    heroLabel: "Daily plan",
    appLabel: "Agenda tile",
    transcriptLabel: "Summary first",
    suggestionLabels: ["Morning recap", "Plan route", "Check in"],
  },
  "workspace-copilot": {
    id: "workspace-copilot",
    layoutDensity: "balanced",
    primarySurface: "canvas",
    sourceMix: ["voice", "text", "file", "screen", "app"],
    controlModel: "composer",
    appPlacement: "side-pane",
    transcriptPlacement: "artifact-bound",
    avatarShape: "presence",
    heroLabel: "Document canvas",
    appLabel: "Artifact pane",
    transcriptLabel: "Anchored to selection",
    suggestionLabels: ["Edit section", "Cite source", "Summarize"],
  },
  "zero-button": {
    id: "zero-button",
    layoutDensity: "sparse",
    primarySurface: "stage",
    sourceMix: ["voice", "text", "screen", "app"],
    controlModel: "chips",
    appPlacement: "sheet",
    transcriptPlacement: "hidden-drawer",
    avatarShape: "presence",
    heroLabel: "Intent surface",
    appLabel: "Suggested sheet",
    transcriptLabel: "Appears only when useful",
    suggestionLabels: ["This screen", "Make reminder", "Use voice"],
  },
  "privacy-first": {
    id: "privacy-first",
    layoutDensity: "dense",
    primarySurface: "console",
    sourceMix: ["voice", "file", "camera", "screen", "app"],
    controlModel: "toolbar",
    appPlacement: "side-pane",
    transcriptPlacement: "inline",
    avatarShape: "device",
    heroLabel: "Privacy ledger",
    appLabel: "Scoped grant",
    transcriptLabel: "Save / redact / forget",
    suggestionLabels: ["Revoke mic", "Session only", "Redact"],
  },
  "live-context": {
    id: "live-context",
    layoutDensity: "dense",
    primarySurface: "canvas",
    sourceMix: ["voice", "camera", "screen", "file", "app"],
    controlModel: "toolbar",
    appPlacement: "grid",
    transcriptPlacement: "caption-strip",
    avatarShape: "scope",
    heroLabel: "Live sources",
    appLabel: "Vision app",
    transcriptLabel: "Captioned with source markers",
    suggestionLabels: ["Annotate", "Pause camera", "Use screen"],
  },
  "focus-capsule": {
    id: "focus-capsule",
    layoutDensity: "sparse",
    primarySurface: "stage",
    sourceMix: ["voice", "text", "file", "app"],
    controlModel: "orb",
    appPlacement: "floating",
    transcriptPlacement: "hidden-drawer",
    avatarShape: "capsule",
    heroLabel: "Floating capsule",
    appLabel: "Snap card",
    transcriptLabel: "Current turn only",
    suggestionLabels: ["Pin", "Expand", "Dismiss"],
  },
  "meeting-studio": {
    id: "meeting-studio",
    layoutDensity: "dense",
    primarySurface: "timeline",
    sourceMix: ["voice", "text", "file", "screen", "app"],
    controlModel: "toolbar",
    appPlacement: "inline",
    transcriptPlacement: "caption-strip",
    avatarShape: "scope",
    heroLabel: "Live meeting",
    appLabel: "Action extractor",
    transcriptLabel: "Speaker captions",
    suggestionLabels: ["Mark decision", "Assign owner", "Pause"],
  },
  gamepad: {
    id: "gamepad",
    layoutDensity: "sparse",
    primarySurface: "stage",
    sourceMix: ["voice", "app", "screen"],
    controlModel: "gamepad",
    appPlacement: "full-screen",
    transcriptPlacement: "caption-strip",
    avatarShape: "device",
    heroLabel: "10-foot assistant",
    appLabel: "Full-screen card",
    transcriptLabel: "Large captions",
    suggestionLabels: ["Left", "Select", "Right"],
  },
  "developer-shell": {
    id: "developer-shell",
    layoutDensity: "dense",
    primarySurface: "console",
    sourceMix: ["voice", "text", "file", "screen", "app"],
    controlModel: "toolbar",
    appPlacement: "side-pane",
    transcriptPlacement: "rail",
    avatarShape: "scope",
    heroLabel: "Terminal split",
    appLabel: "Preview pane",
    transcriptLabel: "Logs and diffs",
    suggestionLabels: ["Test", "Patch", "Rollback"],
  },
  "creative-studio": {
    id: "creative-studio",
    layoutDensity: "balanced",
    primarySurface: "canvas",
    sourceMix: ["voice", "text", "file", "camera", "app"],
    controlModel: "chips",
    appPlacement: "grid",
    transcriptPlacement: "artifact-bound",
    avatarShape: "portrait",
    heroLabel: "Moodboard canvas",
    appLabel: "Variant queue",
    transcriptLabel: "Creative decisions",
    suggestionLabels: ["Refine", "Compare", "Render"],
  },
  "task-pipeline": {
    id: "task-pipeline",
    layoutDensity: "dense",
    primarySurface: "pipeline",
    sourceMix: ["voice", "text", "file", "app"],
    controlModel: "pipeline",
    appPlacement: "inline",
    transcriptPlacement: "rail",
    avatarShape: "presence",
    heroLabel: "Task pipeline",
    appLabel: "Runner step",
    transcriptLabel: "Evidence log",
    suggestionLabels: ["Advance", "Pause", "Review"],
  },
  "split-brain": {
    id: "split-brain",
    layoutDensity: "balanced",
    primarySurface: "thread",
    sourceMix: ["voice", "text", "file", "app"],
    controlModel: "composer",
    appPlacement: "side-pane",
    transcriptPlacement: "rail",
    avatarShape: "capsule",
    heroLabel: "Quick voice + deep text",
    appLabel: "Shared context",
    transcriptLabel: "Voice side channel",
    suggestionLabels: ["Speak", "Type deep", "Attach scope"],
  },
  "inbox-home": {
    id: "inbox-home",
    layoutDensity: "balanced",
    primarySurface: "inbox",
    sourceMix: ["voice", "text", "file", "app"],
    controlModel: "chips",
    appPlacement: "sheet",
    transcriptPlacement: "inline",
    avatarShape: "presence",
    heroLabel: "Triage inbox",
    appLabel: "Approval sheet",
    transcriptLabel: "Under each item",
    suggestionLabels: ["Approve", "Snooze", "Reply"],
  },
  "learn-mode": {
    id: "learn-mode",
    layoutDensity: "balanced",
    primarySurface: "canvas",
    sourceMix: ["voice", "text", "file", "app"],
    controlModel: "chips",
    appPlacement: "grid",
    transcriptPlacement: "artifact-bound",
    avatarShape: "portrait",
    heroLabel: "Lesson board",
    appLabel: "Quiz card",
    transcriptLabel: "Lesson notes",
    suggestionLabels: ["Example", "Quiz", "Slower"],
  },
  "concierge-market": {
    id: "concierge-market",
    layoutDensity: "balanced",
    primarySurface: "inbox",
    sourceMix: ["voice", "text", "file", "app"],
    controlModel: "composer",
    appPlacement: "grid",
    transcriptPlacement: "inline",
    avatarShape: "device",
    heroLabel: "Concierge compare",
    appLabel: "Booking card",
    transcriptLabel: "Tradeoffs inline",
    suggestionLabels: ["Compare", "Book", "Install"],
  },
  "minimal-log": {
    id: "minimal-log",
    layoutDensity: "sparse",
    primarySurface: "thread",
    sourceMix: ["voice", "text", "file"],
    controlModel: "composer",
    appPlacement: "floating",
    transcriptPlacement: "hidden-drawer",
    avatarShape: "presence",
    heroLabel: "Minimal current state",
    appLabel: "Temporary overlay",
    transcriptLabel: "Important turns only",
    suggestionLabels: ["History", "Source", "Continue"],
  },
  "shared-room": {
    id: "shared-room",
    layoutDensity: "dense",
    primarySurface: "stage",
    sourceMix: ["voice", "text", "camera", "screen", "app"],
    controlModel: "toolbar",
    appPlacement: "grid",
    transcriptPlacement: "caption-strip",
    avatarShape: "device",
    heroLabel: "Shared room",
    appLabel: "Household app",
    transcriptLabel: "Speaker and room labels",
    suggestionLabels: ["Private", "Broadcast", "Hand off"],
  },
} satisfies Record<string, DirectionVisualRecipe>;

const lookSkins = {
  "mono-glass": {
    id: "mono-glass",
    name: "Mono Glass",
    frameClass: "bg-[#050505] text-white",
    panelClass: "border-white/15 bg-white/[0.055]",
    quietPanelClass: "border-white/10 bg-white/[0.025]",
    accentClass: "bg-[#FF8A00] text-black",
    avatarClass: "border-white/20 bg-white/[0.08]",
    lineClass: "bg-white/18",
    imageBackdrop: "#050505",
    imageAccent: "#ff8a00",
    imageSecondary: "#ffffff",
  },
  "warm-hardware": {
    id: "warm-hardware",
    name: "Warm Hardware",
    frameClass: "bg-[#171513] text-[#F4EFE7]",
    panelClass: "border-[#F4EFE7]/14 bg-[#241F19]",
    quietPanelClass: "border-[#F4EFE7]/10 bg-[#100E0C]",
    accentClass: "bg-[#FF8A00] text-black",
    avatarClass: "border-[#F4EFE7]/18 bg-[#2F281F]",
    lineClass: "bg-[#F4EFE7]/20",
    imageBackdrop: "#171513",
    imageAccent: "#ff8a00",
    imageSecondary: "#f4efe7",
  },
  "editorial-calm": {
    id: "editorial-calm",
    name: "Editorial Calm",
    frameClass: "bg-[#F4F1EA] text-[#111111]",
    panelClass: "border-black/12 bg-white/70",
    quietPanelClass: "border-black/10 bg-[#E8E2D6]",
    accentClass: "bg-[#FF8A00] text-black",
    avatarClass: "border-black/20 bg-[#EFE8DB]",
    lineClass: "bg-black/18",
    imageBackdrop: "#f4f1ea",
    imageAccent: "#ff8a00",
    imageSecondary: "#111111",
  },
  "signal-console": {
    id: "signal-console",
    name: "Signal Console",
    frameClass: "bg-[#060807] text-white",
    panelClass: "border-[#78D99A]/24 bg-[#07100B]",
    quietPanelClass: "border-white/10 bg-black/45",
    accentClass: "bg-[#FF8A00] text-black",
    avatarClass: "border-[#78D99A]/35 bg-[#0B1A11]",
    lineClass: "bg-[#78D99A]/28",
    imageBackdrop: "#060807",
    imageAccent: "#ff8a00",
    imageSecondary: "#78d99a",
  },
  "soft-sci-fi": {
    id: "soft-sci-fi",
    name: "Soft Sci-Fi",
    frameClass: "bg-[#080607] text-[#F7F2EC]",
    panelClass: "border-[#D8C3FF]/18 bg-white/[0.045]",
    quietPanelClass: "border-white/10 bg-black/35",
    accentClass: "bg-[#FF8A00] text-black",
    avatarClass: "border-[#78D99A]/28 bg-[#160F15]",
    lineClass: "bg-[#D8C3FF]/18",
    imageBackdrop: "#080607",
    imageAccent: "#ff8a00",
    imageSecondary: "#78d99a",
  },
} satisfies Record<string, LookVisualSkin>;

export function getConceptVisual(
  concept: AssistantConcept,
): ConceptVisualModel {
  const recipe =
    directionRecipes[concept.directionId as keyof typeof directionRecipes] ??
    directionRecipes["inline-thread"];
  const skin =
    lookSkins[concept.lookId as keyof typeof lookSkins] ??
    lookSkins["mono-glass"];

  return {
    ...recipe,
    ...skin,
    imageUrl: `/assistant-concepts/generated/${concept.id}.svg`,
    imagePrompt: [
      `Assistant UI concept thumbnail for ${concept.direction}.`,
      `Layout: ${recipe.primarySurface}, controls: ${recipe.controlModel}, transcript: ${recipe.transcriptPlacement}, apps: ${recipe.appPlacement}.`,
      `Visual look: ${skin.name}.`,
      "Required visible elements: avatar/presence, voice state, transcript, attachments, app surface, suggestions.",
      "Palette: black, white, graphite, orange, green, red, amber. No blue or cyan.",
      "Corners: 3px rectangles or full pills/circles only.",
    ].join(" "),
  };
}

export const assistantDirectionVisuals = directionRecipes;
export const assistantLookSkins = lookSkins;
