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
  LifeOpsActiveReminderView,
  LifeOpsReminderChannel,
} from "@elizaos/shared/contracts/lifeops";
import { Badge, Button } from "@elizaos/ui";
import {
  Bell,
  BellRing,
  Cloud,
  Mail,
  MessageCircleMore,
  MessageSquareText,
  Phone,
  Send,
  Smartphone,
  SquareArrowOutUpRight,
} from "lucide-react";
import type { ReactElement } from "react";
import { useLifeOpsOverviewData } from "./shared/use-lifeops-overview-data.js";

const MAX_REMINDERS = 5;

function formatScheduledFor(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  }).format(new Date(parsed));
}

function reminderChannelIcon(
  channel: LifeOpsReminderChannel,
): ReactElement | null {
  switch (channel) {
    case "in_app":
      return <Bell className="h-3 w-3" />;
    case "telegram":
      return <Send className="h-3 w-3" />;
    case "sms":
      return <MessageSquareText className="h-3 w-3" />;
    case "voice":
      return <Phone className="h-3 w-3" />;
    case "discord":
      return <MessageCircleMore className="h-3 w-3" />;
    case "signal":
      return <Mail className="h-3 w-3" />;
    case "whatsapp":
      return <Smartphone className="h-3 w-3" />;
    case "imessage":
      return <Cloud className="h-3 w-3" />;
    default:
      return null;
  }
}

function ReminderRow({ reminder }: { reminder: LifeOpsActiveReminderView }) {
  const channelIcon = reminderChannelIcon(reminder.channel);
  const channelLabel = reminder.channel.replace(/_/g, " ");
  const fireTime = formatScheduledFor(reminder.scheduledFor);

  return (
    <div className="rounded-lg border border-border/50 bg-bg/70 p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-txt">
          {reminder.title}
        </span>
        <Badge
          variant="secondary"
          className="text-[10px]"
          aria-label={channelLabel}
        >
          {channelIcon ?? channelLabel}
        </Badge>
      </div>
      {fireTime ? (
        <div className="mt-1 text-xs text-muted">{fireTime}</div>
      ) : null}
    </div>
  );
}

export function LifeOpsRemindersWidget(_props: ChatSidebarWidgetProps) {
  const { setTab, t } = useApp();
  const { overview, loading, lifeOpsEnabled } = useLifeOpsOverviewData();

  if (!lifeOpsEnabled) return null;

  const reminders = overview?.reminders ?? [];

  return (
    <WidgetSection
      title={t("lifeopswidget.reminders.title", { defaultValue: "LifeOps" })}
      icon={<BellRing className="h-4 w-4" />}
      action={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            window.location.hash = "#lifeops/reminders";
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
      testId="chat-widget-lifeops-reminders"
    >
      {reminders.length > 0 ? (
        <div className="flex flex-col gap-2">
          {reminders.slice(0, MAX_REMINDERS).map((reminder) => (
            <ReminderRow
              key={`${reminder.ownerId}:${reminder.stepIndex}:${reminder.scheduledFor}`}
              reminder={reminder}
            />
          ))}
        </div>
      ) : (
        <EmptyWidgetState
          icon={<BellRing className="h-8 w-8" />}
          title={
            loading
              ? t("lifeopswidget.refreshing", {
                  defaultValue: "Refreshing…",
                })
              : t("lifeopswidget.reminders.empty", {
                  defaultValue: "No active reminders",
                })
          }
        />
      )}
    </WidgetSection>
  );
}

export const LIFEOPS_REMINDERS_WIDGET: ChatSidebarWidgetDefinition = {
  id: "lifeops.reminders",
  pluginId: "lifeops",
  order: 82,
  defaultEnabled: true,
  Component: LifeOpsRemindersWidget,
};
