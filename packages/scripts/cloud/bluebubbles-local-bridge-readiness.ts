export type BlueBubblesSendMethod = "apple-script" | "private-api" | "shortcuts";

export type BlueBubblesServerInfoForReadiness =
  | {
      data?: {
        private_api?: boolean;
        helper_connected?: boolean;
      };
    }
  | { error: string };

export type PendingReplyForReadiness = {
  lastError?: string;
};

export type AppleEventsProbeForReadiness = {
  target: "Finder" | "System Events" | "Messages";
  ok: boolean;
  error?: string;
};

export type ShortcutsDiagnosticsForReadiness = {
  available: boolean;
  shortcuts?: string[];
  error?: string;
};

export type OutboundReadiness = {
  ready: boolean;
  method: BlueBubblesSendMethod;
  reasons: string[];
};

export function recipientFromChatGuid(chatGuid: string): string | null {
  const parts = chatGuid.split(";-;");
  if (parts.length < 2) return null;
  const recipient = parts.slice(1).join(";-;").trim();
  return recipient || null;
}

export function hasServerInfoData(
  serverInfo: BlueBubblesServerInfoForReadiness,
): serverInfo is Exclude<BlueBubblesServerInfoForReadiness, { error: string }> {
  return !("error" in serverInfo) && Boolean(serverInfo.data);
}

export function outboundReadiness(args: {
  method: BlueBubblesSendMethod;
  hasBlueBubblesPassword: boolean;
  serverInfo: BlueBubblesServerInfoForReadiness;
  sipStatus: string;
  pendingReplies: PendingReplyForReadiness[];
  appleEvents?: AppleEventsProbeForReadiness[];
  shortcuts?: ShortcutsDiagnosticsForReadiness;
  shortcutsSendShortcutName: string;
}): OutboundReadiness {
  const reasons: string[] = [];

  if (args.method !== "shortcuts" && !args.hasBlueBubblesPassword) {
    reasons.push("BlueBubbles password is not configured");
  }

  if (args.method !== "shortcuts" && "error" in args.serverInfo) {
    reasons.push(`BlueBubbles server info unavailable: ${args.serverInfo.error}`);
  }

  if (args.method === "private-api") {
    if (!hasServerInfoData(args.serverInfo) || args.serverInfo.data.private_api !== true) {
      reasons.push("BlueBubbles private API is not enabled");
    }
    if (!hasServerInfoData(args.serverInfo) || args.serverInfo.data.helper_connected !== true) {
      reasons.push("BlueBubbles private API helper is not connected");
    }
    if (!args.sipStatus.toLowerCase().includes("disabled")) {
      reasons.push("SIP is not disabled for BlueBubbles private API");
    }
  }

  if (args.method === "apple-script") {
    const messagesProbe = args.appleEvents?.find(
      (probe) => probe.target === "Messages",
    );
    if (messagesProbe && !messagesProbe.ok) {
      reasons.push(`Messages AppleEvents unavailable: ${messagesProbe.error}`);
    }

    const lastError = args.pendingReplies.find((reply) => reply.lastError)?.lastError;
    if (lastError?.toLowerCase().includes("timed out")) {
      reasons.push(`Last AppleScript send failed: ${lastError}`);
    }
  }

  if (args.method === "shortcuts") {
    if (!args.shortcuts?.available) {
      reasons.push(
        `Shortcuts CLI unavailable: ${args.shortcuts?.error ?? "unknown error"}`,
      );
    } else if (!args.shortcuts.shortcuts?.includes(args.shortcutsSendShortcutName)) {
      reasons.push(
        `Shortcut "${args.shortcutsSendShortcutName}" is not installed`,
      );
    }
  }

  return {
    ready: reasons.length === 0,
    method: args.method,
    reasons,
  };
}

export function senderOptions(args: Omit<Parameters<typeof outboundReadiness>[0], "method">): OutboundReadiness[] {
  return (["apple-script", "private-api", "shortcuts"] as const).map((method) =>
    outboundReadiness({ ...args, method }),
  );
}
