/**
 * Explains the real local-runtime group-chat contract for Telegram and
 * BlueBubbles without implying that a successful credential probe proves an
 * inbound or outbound conversation. The guide is deliberately read-only;
 * connector configuration remains owned by the existing setup forms.
 */

import { AlertTriangle, CheckCircle2, RotateCcw, Users } from "lucide-react";
import { cn } from "../../lib/utils";

export type GroupChatGuideConnector = "telegram" | "bluebubbles";

interface GroupChatGuideCopy {
  title: string;
  summary: string;
  addSteps: string[];
  responsePolicy: string;
  identity: string;
  duplicateSafety: string;
  recovery: string[];
}

export const GROUP_CHAT_GUIDES: Record<
  GroupChatGuideConnector,
  GroupChatGuideCopy
> = {
  telegram: {
    title: "Add this Eliza bot to a Telegram group",
    summary:
      "The bot stays attached to this agent runtime. Telegram controls which group messages reach it; Eliza controls whether a delivered message gets a reply.",
    addSteps: [
      "In Telegram, open the group or supergroup, choose Add members, and add the connected bot username.",
      "Keep BotFather privacy enabled for commands and Telegram-delivered mentions. Disable privacy with /setprivacy only when the group expects ambient replies; some groups also require promoting the bot so Telegram delivers every message.",
      "For a deliberate first proof, send a slash command. Plain messages reply only when TELEGRAM_AUTO_REPLY is explicitly enabled. Restrict production access with TELEGRAM_ALLOWED_CHATS.",
    ],
    responsePolicy:
      "Slash commands explicitly request a reply. Other delivered messages are stored without a reply by default; TELEGRAM_AUTO_REPLY=true opts the runtime into ambient replies. The agent may still choose silence.",
    identity:
      "Each Telegram sender maps to a participant entity. A group or supergroup maps to one world, and each forum topic maps to its own room, so replies return to the same group and topic.",
    duplicateSafety:
      "Account, chat, and Telegram message IDs form the replay key. Once delivery starts, an uncertain retry is refused instead of risking a second outbound reply.",
    recovery: [
      "If the bot sees commands but not ambient messages, check BotFather privacy, group permissions, TELEGRAM_AUTO_REPLY, and the allowed-chat ID.",
      "Remove the bot to stop group access. After changing BotFather privacy, remove and re-add it, refresh connector status, then retry one slash command.",
    ],
  },
  bluebubbles: {
    title: "Add this Eliza iMessage identity to a group",
    summary:
      "The Mac's Messages account is the group participant. BlueBubbles bridges that existing identity to this agent runtime; it does not create another Apple ID or agent.",
    addSteps: [
      "Keep the BlueBubbles Mac awake, signed into Messages, reachable from Eliza, and grant BlueBubbles Full Disk Access plus the macOS Automation permissions it requests.",
      "In Messages, add the Mac's iMessage phone number or email to the group. There is no bot-admin role in iMessage.",
      "BlueBubbles group access defaults to allowlist. Add approved sender handles to BLUEBUBBLES_GROUP_ALLOW_FROM, or deliberately choose the open group policy before the first probe.",
    ],
    responsePolicy:
      "There is no mention-only transport gate today. Every allowed inbound group message reaches the runtime, and the agent may reply or deliberately stay silent. Use the allowlist when ambient participation would be too broad.",
    identity:
      "Each normalized phone or email handle maps to a participant entity, while the stable BlueBubbles chat GUID maps to the room. Replies stay in that exact DM or group thread.",
    duplicateSafety:
      "The BlueBubbles message GUID is the stable inbound memory key. A replay is held once that GUID is already stored or being processed, preventing duplicate agent turns and replies.",
    recovery: [
      "If inbound fails, verify Full Disk Access, Messages sign-in, server reachability, webhook target, password, and the sender allowlist, then refresh status.",
      "Remove the Messages participant or disconnect the bridge to stop access. Reconnect the same Mac account to preserve the same participant and thread mapping.",
    ],
  },
};

export function GroupChatReadinessGuide({
  connector,
  className,
}: {
  connector: GroupChatGuideConnector;
  className?: string;
}) {
  const guide = GROUP_CHAT_GUIDES[connector];

  return (
    <section
      className={cn(
        "mt-3 space-y-3 rounded-sm border border-border/50 bg-bg/45 p-3 text-xs",
        className,
      )}
      aria-labelledby={`${connector}-group-guide-title`}
      data-testid={`${connector}-group-guide`}
    >
      <div className="flex items-start gap-2">
        <Users
          className="mt-0.5 h-4 w-4 shrink-0 text-accent"
          aria-hidden="true"
        />
        <div className="space-y-1">
          <h4
            id={`${connector}-group-guide-title`}
            className="font-semibold text-txt"
          >
            {guide.title}
          </h4>
          <p className="text-muted">{guide.summary}</p>
        </div>
      </div>

      <ol className="list-inside list-decimal space-y-1.5 text-muted-strong">
        {guide.addSteps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>

      <div className="grid gap-2 md:grid-cols-2">
        <div className="rounded-sm border border-border/40 bg-card/45 p-2.5">
          <div className="mb-1 flex items-center gap-1.5 font-semibold text-txt">
            <CheckCircle2
              className="h-3.5 w-3.5 text-accent"
              aria-hidden="true"
            />
            Replies and identity
          </div>
          <p className="text-muted">{guide.responsePolicy}</p>
          <p className="mt-1.5 text-muted">{guide.identity}</p>
        </div>
        <div className="rounded-sm border border-border/40 bg-card/45 p-2.5">
          <div className="mb-1 flex items-center gap-1.5 font-semibold text-txt">
            <AlertTriangle
              className="h-3.5 w-3.5 text-accent"
              aria-hidden="true"
            />
            Duplicate safety
          </div>
          <p className="text-muted">{guide.duplicateSafety}</p>
        </div>
      </div>

      <div className="space-y-1.5 rounded-sm border border-border/40 bg-card/45 p-2.5">
        <div className="flex items-center gap-1.5 font-semibold text-txt">
          <RotateCcw className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
          Remove, retry, or reconnect
        </div>
        <ul className="list-inside list-disc space-y-1 text-muted">
          {guide.recovery.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
