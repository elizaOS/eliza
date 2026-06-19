export type HealthAssistantIconKey =
  | "activity"
  | "heart"
  | "moon"
  | "timer"
  | "monitor"
  | "shield";

export interface HealthAssistantCommand {
  id: string;
  label: string;
  shortLabel: string;
  iconKey: HealthAssistantIconKey;
  tone: string;
  prompt: string;
  sourcePlugin: "@elizaos/plugin-health";
}

export const HEALTH_ASSISTANT_COMMANDS: readonly HealthAssistantCommand[] = [
  {
    id: "health-status",
    label: "Health sources",
    shortLabel: "Health",
    iconKey: "heart",
    tone: "bg-rose-300",
    sourcePlugin: "@elizaos/plugin-health",
    prompt:
      "Check my health data sources and wearable sync status. Tell me what is connected, stale, or needs re-authentication.",
  },
  {
    id: "sleep-signal",
    label: "Sleep signal",
    shortLabel: "Sleep",
    iconKey: "moon",
    tone: "bg-indigo-300",
    sourcePlugin: "@elizaos/plugin-health",
    prompt:
      "Summarize my latest sleep signal, confidence, trend, and anything that should change tonight. Keep it compact.",
  },
  {
    id: "screen-time",
    label: "Screen time",
    shortLabel: "Screen",
    iconKey: "monitor",
    tone: "bg-cyan-300",
    sourcePlugin: "@elizaos/plugin-health",
    prompt:
      "Summarize my screen-time pattern across apps and websites. Highlight the biggest attention drains and one useful adjustment.",
  },
  {
    id: "focus-block",
    label: "Focus block",
    shortLabel: "Focus",
    iconKey: "shield",
    tone: "bg-emerald-300",
    sourcePlugin: "@elizaos/plugin-health",
    prompt:
      "Use my recent activity and screen-time pattern to suggest a focus block. Include app or website blocks only if they are clearly useful.",
  },
  {
    id: "activity-trend",
    label: "Activity trend",
    shortLabel: "Activity",
    iconKey: "activity",
    tone: "bg-lime-300",
    sourcePlugin: "@elizaos/plugin-health",
    prompt:
      "Show my recent activity trend: steps, active minutes, workouts, and any obvious change from baseline.",
  },
  {
    id: "recovery-window",
    label: "Recovery window",
    shortLabel: "Recover",
    iconKey: "timer",
    tone: "bg-amber-300",
    sourcePlugin: "@elizaos/plugin-health",
    prompt:
      "Check sleep, activity, and screen-time signals for recovery risk. Suggest the smallest schedule adjustment that protects energy.",
  },
];
