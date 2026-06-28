import { MessageSquare } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { client } from "../../../api";
import type { WidgetProps } from "../../../widgets/types";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";

// Naked 2x1 home tile for Discord: the most-recent message preview across the
// agent's Discord rooms plus an unread-style count badge. Connection is probed
// via the connector-accounts list (a `connected` account) before fetching
// messages; when no account is connected we render a "Connect Discord" affordance
// (never null) so the user can wire it up.

const DISCORD_MESSAGE_LIMIT = 5;

type Phase = "loading" | "connected" | "disconnected";

interface DiscordSnapshot {
  preview: string;
  count: number;
}

export function DiscordRecentWidget(props: Partial<WidgetProps>) {
  const spanClassName = props.spanClassName ?? "col-span-2 row-span-1";
  const nav = useWidgetNavigation();
  const [phase, setPhase] = useState<Phase>("loading");
  const [snapshot, setSnapshot] = useState<DiscordSnapshot | null>(null);

  const load = useCallback(async (signal: { cancelled: boolean }) => {
    const accountsResponse = await client.listConnectorAccounts("discord");
    const connected = accountsResponse.accounts.some(
      (account) => account.status === "connected",
    );
    if (signal.cancelled) return;
    if (!connected) {
      setPhase("disconnected");
      setSnapshot(null);
      return;
    }

    const inbox = await client.getInboxMessages({
      sources: ["discord"],
      limit: DISCORD_MESSAGE_LIMIT,
    });
    if (signal.cancelled) return;
    const latest = inbox.messages[0];
    const preview = latest?.text?.trim() ?? "";
    setSnapshot({ preview, count: inbox.count });
    setPhase("connected");
  }, []);

  useEffect(() => {
    const signal = { cancelled: false };
    void load(signal).catch(() => {
      if (!signal.cancelled) {
        // A failed probe is treated as not-connected so the user still gets a
        // way to act (the connect affordance) rather than a stuck spinner.
        setPhase("disconnected");
        setSnapshot(null);
      }
    });
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  if (phase === "loading") {
    return (
      <div
        className={spanClassName}
        data-testid="chat-widget-discord-recent-loading"
      >
        <div className="flex items-center gap-3 px-3 py-2.5 text-white/70 [text-shadow:0_1px_3px_rgba(0,0,0,0.38)]">
          <MessageSquare className="h-[22px] w-[22px]" />
          <span className="text-sm font-semibold leading-tight">Discord</span>
        </div>
      </div>
    );
  }

  if (phase === "disconnected") {
    return (
      <div className={spanClassName}>
        <HomeWidgetCard
          icon={<MessageSquare />}
          label="Discord"
          value="Connect Discord"
          testId="chat-widget-discord-recent-connect"
          ariaLabel="Connect Discord to see recent messages. Open connector settings."
          onActivate={() => nav.openView("/settings/connectors", "connectors")}
        />
      </div>
    );
  }

  const hasMessage = snapshot != null && snapshot.preview.length > 0;
  const value = hasMessage ? snapshot.preview : "No recent messages";
  const badge =
    snapshot != null && snapshot.count > 0 ? snapshot.count : undefined;
  const ariaLabel = hasMessage
    ? `Discord: ${snapshot.count} recent message${snapshot.count === 1 ? "" : "s"}, latest: ${snapshot.preview}. Open Discord messages.`
    : "Discord connected, no recent messages. Open Discord messages.";

  return (
    <div className={spanClassName}>
      <HomeWidgetCard
        icon={<MessageSquare />}
        label="Discord"
        value={value}
        badge={badge}
        testId="chat-widget-discord-recent"
        ariaLabel={ariaLabel}
        onActivate={() => nav.openView("/inbox", "inbox")}
      />
    </div>
  );
}
