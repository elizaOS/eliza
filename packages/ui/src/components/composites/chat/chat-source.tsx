import {
  Hash,
  MessageCircleMore,
  MessageSquareText,
  MessagesSquare,
  Phone,
  Send,
  Shield,
  TerminalSquare,
} from "lucide-react";
import type * as React from "react";

import { cn } from "../../../lib/utils";

type SourceIconProps = {
  className?: string;
};

export type ChatSourceMeta = {
  badgeClassName: string;
  borderClassName: string;
  iconClassName: string;
  Icon: React.ComponentType<SourceIconProps>;
  label: string;
};

function DiscordIcon({ className }: SourceIconProps) {
  return (
    <svg
      aria-hidden="true"
      className={cn("h-4 w-4", className)}
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.947 2.418-2.157 2.418z" />
    </svg>
  );
}

const SOURCE_META: Record<string, ChatSourceMeta> = {
  eliza: {
    badgeClassName: "border-accent/30 bg-accent/10 text-accent",
    borderClassName: "border-accent/60",
    iconClassName: "text-accent",
    Icon: TerminalSquare,
    label: "Terminal",
  },
  app: {
    badgeClassName: "border-accent/30 bg-accent/10 text-accent",
    borderClassName: "border-accent/60",
    iconClassName: "text-accent",
    Icon: TerminalSquare,
    label: "Terminal",
  },
  discord: {
    badgeClassName: "border-[#5865F2]/30 bg-[#5865F2]/10 text-[#c7cdff]",
    borderClassName: "border-[#5865F2]/60",
    iconClassName: "text-[#8ea1ff]",
    Icon: DiscordIcon,
    label: "Discord",
  },
  "discord-local": {
    badgeClassName: "border-[#5865F2]/30 bg-[#5865F2]/10 text-[#c7cdff]",
    borderClassName: "border-[#5865F2]/60",
    iconClassName: "text-[#8ea1ff]",
    Icon: DiscordIcon,
    label: "Discord",
  },
  bluebubbles: {
    badgeClassName: "border-[#34c759]/30 bg-[#34c759]/10 text-[#b6f2c7]",
    borderClassName: "border-[#34c759]/60",
    iconClassName: "text-[#34c759]",
    Icon: MessageCircleMore,
    label: "iMessage",
  },
  imessage: {
    badgeClassName: "border-[#34c759]/30 bg-[#34c759]/10 text-[#b6f2c7]",
    borderClassName: "border-[#34c759]/60",
    iconClassName: "text-[#34c759]",
    Icon: MessageCircleMore,
    label: "iMessage",
  },
  signal: {
    badgeClassName: "border-[#3A76F0]/30 bg-[#3A76F0]/10 text-[#bed2ff]",
    borderClassName: "border-[#3A76F0]/60",
    iconClassName: "text-[#73a0ff]",
    Icon: Shield,
    label: "Signal",
  },
  slack: {
    badgeClassName: "border-[#4A154B]/30 bg-[#4A154B]/10 text-[#dfb9df]",
    borderClassName: "border-[#4A154B]/60",
    iconClassName: "text-[#c78bc8]",
    Icon: Hash,
    label: "Slack",
  },
  sms: {
    badgeClassName: "border-[#8E8E93]/30 bg-[#8E8E93]/10 text-[#d7d7da]",
    borderClassName: "border-[#8E8E93]/60",
    iconClassName: "text-[#c8c8cc]",
    Icon: MessageSquareText,
    label: "SMS",
  },
  telegram: {
    badgeClassName: "border-[#229ED9]/30 bg-[#229ED9]/10 text-[#b3e6ff]",
    borderClassName: "border-[#229ED9]/60",
    iconClassName: "text-[#63c5ff]",
    Icon: Send,
    label: "Telegram",
  },
  "telegram-account": {
    badgeClassName: "border-[#229ED9]/30 bg-[#229ED9]/10 text-[#b3e6ff]",
    borderClassName: "border-[#229ED9]/60",
    iconClassName: "text-[#63c5ff]",
    Icon: Send,
    label: "Telegram",
  },
  wechat: {
    badgeClassName: "border-[#07C160]/30 bg-[#07C160]/10 text-[#acf0c8]",
    borderClassName: "border-[#07C160]/60",
    iconClassName: "text-[#4ed58f]",
    Icon: MessagesSquare,
    label: "WeChat",
  },
  whatsapp: {
    badgeClassName: "border-[#25D366]/30 bg-[#25D366]/10 text-[#b3f1c6]",
    borderClassName: "border-[#25D366]/60",
    iconClassName: "text-[#4fdf85]",
    Icon: Phone,
    label: "WhatsApp",
  },
};

export function registerChatSourceMetaEntries(
  entries: Record<string, ChatSourceMeta>,
): void {
  for (const [source, meta] of Object.entries(entries)) {
    SOURCE_META[source.trim().toLowerCase()] = meta;
  }
}

function toTitleCase(source: string): string {
  return source
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getChatSourceMeta(source: string): ChatSourceMeta {
  const normalized = source.trim().toLowerCase();
  const known = SOURCE_META[normalized];
  if (known) return known;
  return {
    badgeClassName: "border-accent/25 bg-accent/8 text-muted-strong",
    borderClassName: "border-accent/40",
    iconClassName: "text-accent/85",
    Icon: MessageSquareText,
    label: toTitleCase(source),
  };
}

export function ChatSourceIcon({
  source,
  className,
  decorative = false,
}: {
  className?: string;
  decorative?: boolean;
  source: string;
}) {
  const meta = getChatSourceMeta(source);
  const Icon = meta.Icon;

  return (
    <span
      data-testid="chat-source-icon"
      data-source={source.trim().toLowerCase()}
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        meta.iconClassName,
      )}
      {...(decorative
        ? { "aria-hidden": true }
        : { "aria-label": meta.label, role: "img", title: meta.label })}
    >
      <Icon className={className} />
    </span>
  );
}
