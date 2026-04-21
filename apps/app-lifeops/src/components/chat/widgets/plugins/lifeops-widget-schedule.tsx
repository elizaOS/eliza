import {
  EmptyWidgetState,
  WidgetSection,
} from "@elizaos/app-core/components/chat/widgets/shared";
import type {
  ChatSidebarWidgetDefinition,
  ChatSidebarWidgetProps,
} from "@elizaos/app-core/components/chat/widgets/types";
import { useApp } from "@elizaos/app-core/state";
import type { LifeOpsScheduleInsight } from "@elizaos/shared/contracts/lifeops";
import { Button } from "@elizaos/ui";
import { Moon, SquareArrowOutUpRight } from "lucide-react";
import { formatMinutesDuration } from "../../../../utils/format-duration.js";
import { useLifeOpsOverviewData } from "./shared/use-lifeops-overview-data.js";

function formatAbsoluteTime(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(parsed));
}

function ScheduleLine({ schedule }: { schedule: LifeOpsScheduleInsight }) {
  const { t } = useApp();
  const { relativeTime } = schedule;

  const sleepTime = schedule.currentSleepStartedAt
    ? formatAbsoluteTime(schedule.currentSleepStartedAt)
    : null;
  const wakeTime = schedule.lastSleepEndedAt
    ? formatAbsoluteTime(schedule.lastSleepEndedAt)
    : null;
  const bedtimeTime = relativeTime.bedtimeTargetAt
    ? formatAbsoluteTime(relativeTime.bedtimeTargetAt)
    : null;

  const sleepLabel = schedule.isProbablySleeping
    ? sleepTime
      ? t("lifeopswidget.schedule.asleepSince", {
          defaultValue: "Asleep since {{time}}",
          time: sleepTime,
        })
      : t("lifeopswidget.schedule.asleep", { defaultValue: "Asleep" })
    : wakeTime
      ? t("lifeopswidget.schedule.wokeAt", {
          defaultValue: "Woke {{time}}",
          time: wakeTime,
        })
      : t("lifeopswidget.schedule.awake", { defaultValue: "Awake" });

  const bedLabel = bedtimeTime
    ? relativeTime.minutesUntilBedtimeTarget !== null
      ? t("lifeopswidget.schedule.bedtimeAt", {
          defaultValue: "Bedtime {{time}} ({{remaining}})",
          time: bedtimeTime,
          remaining: formatMinutesDuration(
            relativeTime.minutesUntilBedtimeTarget,
          ),
        })
      : t("lifeopswidget.schedule.bedtimeWas", {
          defaultValue: "Bedtime was {{time}}",
          time: bedtimeTime,
        })
    : null;

  return (
    <div className="rounded-lg border border-border/50 bg-bg/70 p-2">
      <div className="text-xs font-semibold text-txt">{sleepLabel}</div>
      {bedLabel ? (
        <div className="mt-0.5 text-xs text-muted">{bedLabel}</div>
      ) : null}
    </div>
  );
}

export function LifeOpsScheduleWidget(_props: ChatSidebarWidgetProps) {
  const { setTab, t } = useApp();
  const { overview, loading, lifeOpsEnabled } = useLifeOpsOverviewData();

  if (!lifeOpsEnabled) return null;

  const schedule = overview?.schedule ?? null;

  return (
    <WidgetSection
      title={t("lifeopswidget.schedule.title", { defaultValue: "LifeOps" })}
      icon={<Moon className="h-4 w-4" />}
      action={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            window.location.hash = "#lifeops/dashboard";
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
      testId="chat-widget-lifeops-schedule"
    >
      {schedule ? (
        <ScheduleLine schedule={schedule} />
      ) : (
        <EmptyWidgetState
          icon={<Moon className="h-8 w-8" />}
          title={
            loading
              ? t("lifeopswidget.refreshing", {
                  defaultValue: "Refreshing…",
                })
              : t("lifeopswidget.schedule.empty", {
                  defaultValue: "No schedule data",
                })
          }
        />
      )}
    </WidgetSection>
  );
}

export const LIFEOPS_SCHEDULE_WIDGET: ChatSidebarWidgetDefinition = {
  id: "lifeops.schedule",
  pluginId: "lifeops",
  order: 80,
  defaultEnabled: true,
  Component: LifeOpsScheduleWidget,
};
