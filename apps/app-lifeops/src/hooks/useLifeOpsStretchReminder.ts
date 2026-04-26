import { client } from "@elizaos/app-core";
import type {
  LifeOpsActiveReminderView,
  LifeOpsOverview,
  LifeOpsReminderInspection,
} from "@elizaos/shared";
import type {
  LifeOpsScheduleMergedState,
} from "../lifeops/schedule-sync-contracts.js";
import { useCallback, useEffect, useMemo, useState } from "react";

type SeedTemplate = {
  key: string;
  title: string;
  description: string;
};

type SeedTemplatesResponse = {
  needsSeeding: boolean;
  availableTemplates: SeedTemplate[];
};

function formatError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }
  return fallback;
}

function selectStretchReminder(
  reminders: LifeOpsActiveReminderView[],
): LifeOpsActiveReminderView | null {
  return (
    reminders.find((reminder) =>
      reminder.title.toLowerCase().includes("stretch"),
    ) ?? reminders[0] ??
    null
  );
}

function overviewReminders(overview: LifeOpsOverview | null): LifeOpsActiveReminderView[] {
  return [
    ...(overview?.owner.reminders ?? []),
    ...(overview?.agentOps.reminders ?? []),
    ...(overview?.reminders ?? []),
  ];
}

export function useLifeOpsStretchReminder() {
  const [overview, setOverview] = useState<LifeOpsOverview | null>(null);
  const [seedTemplates, setSeedTemplates] =
    useState<SeedTemplatesResponse | null>(null);
  const [schedule, setSchedule] = useState<LifeOpsScheduleMergedState | null>(
    null,
  );
  const [inspection, setInspection] =
    useState<LifeOpsReminderInspection | null>(null);
  const [loading, setLoading] = useState(true);
  const [seedPending, setSeedPending] = useState(false);
  const [inspectionPending, setInspectionPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextOverview, nextSeedTemplates, nextSchedule] =
        await Promise.all([
          client.getLifeOpsOverview(),
          client.getLifeOpsSeedTemplates(),
          client.getLifeOpsScheduleMergedState({
            scope: "effective",
            refresh: false,
          }),
        ]);
      setOverview(nextOverview);
      setSeedTemplates(nextSeedTemplates);
      setSchedule(nextSchedule.mergedState);
      setError(null);
    } catch (cause) {
      setError(formatError(cause, "Stretch reminder data failed to load."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const [nextOverview, nextSeedTemplates, nextSchedule] =
          await Promise.all([
            client.getLifeOpsOverview(),
            client.getLifeOpsSeedTemplates(),
            client.getLifeOpsScheduleMergedState({
              scope: "effective",
              refresh: false,
            }),
          ]);
        if (cancelled) {
          return;
        }
        setOverview(nextOverview);
        setSeedTemplates(nextSeedTemplates);
        setSchedule(nextSchedule.mergedState);
        setError(null);
      } catch (cause) {
        if (cancelled) {
          return;
        }
        setError(formatError(cause, "Stretch reminder data failed to load."));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const stretchReminder = useMemo(
    () => selectStretchReminder(overviewReminders(overview)),
    [overview],
  );
  const stretchTemplate = useMemo(
    () =>
      seedTemplates?.availableTemplates.find(
        (template) => template.key === "stretch",
      ) ?? null,
    [seedTemplates?.availableTemplates],
  );

  const createStretchReminder = useCallback(async () => {
    try {
      setSeedPending(true);
      const next = await client.seedLifeOpsRoutines({
        keys: ["stretch"],
        timezone: schedule?.timezone ?? undefined,
      });
      await refresh();
      return next.createdIds;
    } catch (cause) {
      setError(formatError(cause, "Stretch reminder creation failed."));
      return null;
    } finally {
      setSeedPending(false);
    }
  }, [refresh, schedule?.timezone]);

  const inspectStretchReminder = useCallback(async () => {
    if (!stretchReminder) {
      return null;
    }
    try {
      setInspectionPending(true);
      const nextInspection = await client.inspectLifeOpsReminder(
        stretchReminder.ownerType,
        stretchReminder.ownerId,
      );
      setInspection(nextInspection);
      setError(null);
      return nextInspection;
    } catch (cause) {
      setError(formatError(cause, "Stretch reminder inspection failed."));
      return null;
    } finally {
      setInspectionPending(false);
    }
  }, [stretchReminder]);

  return {
    overview,
    seedTemplates,
    schedule,
    stretchReminder,
    stretchTemplate,
    inspection,
    loading,
    seedPending,
    inspectionPending,
    error,
    refresh,
    createStretchReminder,
    inspectStretchReminder,
  } as const;
}
