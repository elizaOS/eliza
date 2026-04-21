import { client } from "@elizaos/app-core/api";
import {
  EmptyWidgetState,
  WidgetSection,
} from "@elizaos/app-core/components/chat/widgets/shared";
import type {
  ChatSidebarWidgetDefinition,
  ChatSidebarWidgetProps,
} from "@elizaos/app-core/components/chat/widgets/types";
import { useApp } from "@elizaos/app-core/state";
import type {
  LifeOpsDiscordDmPreview,
  LifeOpsGmailMessageSummary,
  LifeOpsGmailTriageFeed,
  LifeOpsGoogleCapability,
  LifeOpsGoogleConnectorStatus,
} from "@elizaos/shared/contracts/lifeops";
import { Button } from "@elizaos/ui";
import {
  Inbox,
  MessageCircleMore,
  Send,
  SquareArrowOutUpRight,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useDiscordConnector } from "../../../../hooks/useDiscordConnector.js";
import { useGoogleLifeOpsConnector } from "../../../../hooks/useGoogleLifeOpsConnector.js";

const INBOX_REFRESH_INTERVAL_MS = 15_000;
const GMAIL_MESSAGE_LIMIT = 3;
const DISCORD_PREVIEW_LIMIT = 3;

function capabilitySet(
  status: LifeOpsGoogleConnectorStatus | null,
): Set<LifeOpsGoogleCapability> {
  return new Set(status?.grantedCapabilities ?? []);
}

function GmailRow({
  message,
  onReply,
}: {
  message: LifeOpsGmailMessageSummary;
  onReply: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-0.5 py-0.5">
      <span className="min-w-0 flex-1 truncate text-2xs text-txt">
        {message.subject}
      </span>
      {message.likelyReplyNeeded ? (
        <button
          type="button"
          onClick={onReply}
          className="shrink-0 rounded p-0.5 text-accent hover:bg-bg-accent/30"
          aria-label="Reply"
          // TODO(stream-e): prefill composer with
          // `Reply to "${message.subject}" from ${message.from}: `
        >
          <Send className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

function DiscordRow({
  preview,
  onClick,
}: {
  preview: LifeOpsDiscordDmPreview;
  onClick: () => void;
}) {
  const snippet = preview.snippet?.trim() ?? "";
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-0.5 py-0.5 text-left hover:bg-bg-accent/30"
    >
      <span
        className={`shrink-0 inline-block h-1.5 w-1.5 rounded-full ${preview.unread ? "bg-accent" : "bg-muted/30"}`}
      />
      <span className="min-w-0 flex-1 truncate text-2xs text-txt">
        {preview.label}
      </span>
      {snippet.length > 0 ? (
        <span className="min-w-0 max-w-[50%] truncate text-3xs text-muted">
          {snippet}
        </span>
      ) : null}
    </button>
  );
}

export function LifeOpsInboxWidget(_props: ChatSidebarWidgetProps) {
  const { setTab, t } = useApp();

  const ownerConnector = useGoogleLifeOpsConnector({
    pollWhileDisconnected: false,
    side: "owner",
    pollIntervalMs: INBOX_REFRESH_INTERVAL_MS,
  });
  const agentConnector = useGoogleLifeOpsConnector({
    pollWhileDisconnected: false,
    side: "agent",
    pollIntervalMs: INBOX_REFRESH_INTERVAL_MS,
  });
  const discordConnector = useDiscordConnector({ side: "owner" });

  const googleStatus = useMemo(() => {
    const candidates = [ownerConnector.status, agentConnector.status].filter(
      (s): s is LifeOpsGoogleConnectorStatus => s?.connected === true,
    );
    return candidates.find((s) => s.preferredByAgent) ?? candidates[0] ?? null;
  }, [ownerConnector.status, agentConnector.status]);

  const [gmailFeed, setGmailFeed] = useState<LifeOpsGmailTriageFeed | null>(
    null,
  );
  const [feedError, setFeedError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!googleStatus?.connected) {
        setGmailFeed(null);
        setFeedError(null);
        return;
      }
      const caps = capabilitySet(googleStatus);
      if (!caps.has("google.gmail.triage")) {
        setGmailFeed(null);
        return;
      }
      try {
        const result = await client.getLifeOpsGmailTriage({
          mode: googleStatus.mode,
          side: googleStatus.side,
          maxResults: GMAIL_MESSAGE_LIMIT,
        });
        if (!active) return;
        setGmailFeed(result);
        setFeedError(null);
      } catch (cause) {
        if (!active) return;
        setFeedError(
          cause instanceof Error && cause.message.trim().length > 0
            ? cause.message.trim()
            : t("lifeopsoverview.googleFeedsFailed", {
                defaultValue: "Google widget feeds failed to refresh.",
              }),
        );
      }
    })();
    return () => {
      active = false;
    };
  }, [googleStatus, t]);

  const capabilities = useMemo(
    () => capabilitySet(googleStatus),
    [googleStatus],
  );
  const hasGmail =
    googleStatus?.connected === true && capabilities.has("google.gmail.triage");

  const discordPreviews = discordConnector.status?.dmInbox?.previews ?? [];
  const hasDiscord =
    discordConnector.status?.connected === true && discordPreviews.length > 0;

  if (!hasGmail && !hasDiscord) return null;

  const gmailMessages = (gmailFeed?.messages ?? []).slice(
    0,
    GMAIL_MESSAGE_LIMIT,
  );
  const discordSorted = [...discordPreviews]
    .sort((a, b) => Number(b.unread) - Number(a.unread))
    .slice(0, DISCORD_PREVIEW_LIMIT);

  const totalCount = gmailMessages.length + discordSorted.length;

  return (
    <WidgetSection
      title={t("lifeopswidget.inbox.title", { defaultValue: "LifeOps" })}
      icon={<Inbox className="h-4 w-4" />}
      action={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            window.location.hash = "#lifeops/inbox";
            setTab("lifeops");
          }}
          aria-label={t("lifeopswidget.openView", {
            defaultValue: "Open LifeOps view",
          })}
          className="h-6 w-6 p-0"
        >
          <SquareArrowOutUpRight className="h-3.5 w-3.5" />
        </Button>
      }
      testId="chat-widget-lifeops-inbox"
    >
      {feedError ? (
        <div className="px-0.5 text-3xs text-danger">{feedError}</div>
      ) : totalCount === 0 ? (
        <EmptyWidgetState
          icon={<Inbox className="h-8 w-8" />}
          title={t("lifeopsoverview.noPriorityMail", {
            defaultValue: "No priority mail",
          })}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {hasGmail && gmailMessages.length > 0 ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 px-0.5">
                <span className="text-muted">
                  <Inbox className="h-3 w-3" />
                </span>
              </div>
              {gmailMessages.map((message) => (
                <GmailRow
                  key={message.id}
                  message={message}
                  onReply={() => {
                    window.location.hash = `#lifeops/inbox/${message.id}`;
                    setTab("lifeops");
                  }}
                />
              ))}
            </div>
          ) : null}

          {hasDiscord && discordSorted.length > 0 ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 px-0.5">
                <span className="text-muted">
                  <MessageCircleMore className="h-3 w-3" />
                </span>
              </div>
              {discordSorted.map((preview) => (
                <DiscordRow
                  key={`${preview.channelId ?? preview.label}`}
                  preview={preview}
                  onClick={() => {
                    window.location.hash = `#lifeops/inbox/discord/${preview.channelId ?? ""}`;
                    setTab("lifeops");
                  }}
                />
              ))}
            </div>
          ) : null}
        </div>
      )}
    </WidgetSection>
  );
}

export const LIFEOPS_INBOX_WIDGET: ChatSidebarWidgetDefinition = {
  id: "lifeops.inbox",
  pluginId: "lifeops",
  order: 86,
  defaultEnabled: true,
  Component: LifeOpsInboxWidget,
};
