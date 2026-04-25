export type LifeOpsHabitCategory =
  | "browser"
  | "communication"
  | "social"
  | "system"
  | "video"
  | "work"
  | "other";

export type LifeOpsHabitSurface = "app" | "website";

export type LifeOpsHabitDevice =
  | "browser"
  | "computer"
  | "phone"
  | "tablet"
  | "unknown";

export type LifeOpsSocialService =
  | "x"
  | "youtube"
  | "discord"
  | "reddit"
  | "instagram"
  | "tiktok"
  | "facebook"
  | "linkedin"
  | "twitch"
  | "slack"
  | "google_chat"
  | "telegram"
  | "signal"
  | "whatsapp";

export interface LifeOpsScreenTimeClassification {
  category: LifeOpsHabitCategory;
  device: LifeOpsHabitDevice;
  service: LifeOpsSocialService | null;
  serviceLabel: string | null;
  browser: string | null;
}

interface ScreenTimeTarget {
  source: LifeOpsHabitSurface;
  identifier: string;
  displayName: string;
  metadata?: Record<string, unknown>;
}

interface SocialRule {
  service: LifeOpsSocialService;
  label: string;
  category: LifeOpsHabitCategory;
  patterns: string[];
}

const SOCIAL_RULES: SocialRule[] = [
  {
    service: "youtube",
    label: "YouTube",
    category: "video",
    patterns: ["youtube", "youtu.be", "com.google.android.youtube"],
  },
  {
    service: "x",
    label: "X",
    category: "social",
    patterns: ["x.com", "twitter.com", "tweetie", "twitter"],
  },
  {
    service: "discord",
    label: "Discord",
    category: "communication",
    patterns: ["discord"],
  },
  {
    service: "reddit",
    label: "Reddit",
    category: "social",
    patterns: ["reddit"],
  },
  {
    service: "instagram",
    label: "Instagram",
    category: "social",
    patterns: ["instagram"],
  },
  {
    service: "tiktok",
    label: "TikTok",
    category: "video",
    patterns: ["tiktok"],
  },
  {
    service: "facebook",
    label: "Facebook",
    category: "social",
    patterns: ["facebook", "messenger"],
  },
  {
    service: "linkedin",
    label: "LinkedIn",
    category: "social",
    patterns: ["linkedin"],
  },
  {
    service: "twitch",
    label: "Twitch",
    category: "video",
    patterns: ["twitch"],
  },
  {
    service: "slack",
    label: "Slack",
    category: "communication",
    patterns: ["slack"],
  },
  {
    service: "google_chat",
    label: "Google Chat",
    category: "communication",
    patterns: ["chat.google.com", "google chat"],
  },
  {
    service: "telegram",
    label: "Telegram",
    category: "communication",
    patterns: ["telegram"],
  },
  {
    service: "signal",
    label: "Signal",
    category: "communication",
    patterns: ["signal"],
  },
  {
    service: "whatsapp",
    label: "WhatsApp",
    category: "communication",
    patterns: ["whatsapp"],
  },
];

const BROWSER_PATTERNS = [
  "chrome",
  "safari",
  "firefox",
  "arc",
  "brave",
  "edge",
];
const WORK_PATTERNS = [
  "cursor",
  "code",
  "github",
  "linear",
  "notion",
  "figma",
  "slack",
  "zoom",
  "calendar",
  "docs.google.com",
  "sheets.google.com",
];
const SYSTEM_PATTERNS = ["finder", "system settings", "activity monitor"];

function normalize(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value : "";
}

function targetHaystack(target: ScreenTimeTarget): string {
  return [
    target.identifier,
    target.displayName,
    metadataString(target.metadata, "url"),
    metadataString(target.metadata, "browser"),
    metadataString(target.metadata, "platform"),
    metadataString(target.metadata, "packageName"),
  ]
    .map(normalize)
    .filter(Boolean)
    .join(" ");
}

function matchSocialRule(haystack: string): SocialRule | null {
  for (const rule of SOCIAL_RULES) {
    if (rule.patterns.some((pattern) => haystack.includes(pattern))) {
      return rule;
    }
  }
  return null;
}

function classifyDevice(target: ScreenTimeTarget): LifeOpsHabitDevice {
  const platform = normalize(metadataString(target.metadata, "platform"));
  if (platform.includes("android") || platform.includes("ios")) {
    return platform.includes("ipad") ? "tablet" : "phone";
  }
  if (target.source === "website") {
    return "browser";
  }
  if (target.source === "app") {
    return "computer";
  }
  return "unknown";
}

function classifyBrowser(
  target: ScreenTimeTarget,
  haystack: string,
): string | null {
  const browser = metadataString(target.metadata, "browser").trim();
  if (browser.length > 0) {
    return browser;
  }
  if (haystack.includes("chrome")) return "Chrome";
  if (haystack.includes("safari")) return "Safari";
  if (haystack.includes("firefox")) return "Firefox";
  if (haystack.includes("arc")) return "Arc";
  if (haystack.includes("brave")) return "Brave";
  if (haystack.includes("edge")) return "Edge";
  return null;
}

export function classifyScreenTimeTarget(
  target: ScreenTimeTarget,
): LifeOpsScreenTimeClassification {
  const haystack = targetHaystack(target);
  const rule = matchSocialRule(haystack);
  const browser = classifyBrowser(target, haystack);
  if (rule) {
    return {
      category: rule.category,
      device: classifyDevice(target),
      service: rule.service,
      serviceLabel: rule.label,
      browser,
    };
  }
  if (BROWSER_PATTERNS.some((pattern) => haystack.includes(pattern))) {
    return {
      category: "browser",
      device: classifyDevice(target),
      service: null,
      serviceLabel: null,
      browser,
    };
  }
  if (SYSTEM_PATTERNS.some((pattern) => haystack.includes(pattern))) {
    return {
      category: "system",
      device: classifyDevice(target),
      service: null,
      serviceLabel: null,
      browser,
    };
  }
  if (WORK_PATTERNS.some((pattern) => haystack.includes(pattern))) {
    return {
      category: "work",
      device: classifyDevice(target),
      service: null,
      serviceLabel: null,
      browser,
    };
  }
  return {
    category: "other",
    device: classifyDevice(target),
    service: null,
    serviceLabel: null,
    browser,
  };
}

export function isSocialCategory(category: LifeOpsHabitCategory): boolean {
  return (
    category === "social" ||
    category === "video" ||
    category === "communication"
  );
}
