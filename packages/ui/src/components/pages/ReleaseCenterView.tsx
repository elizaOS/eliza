/**
 * The Release Center view: surfaces the agent runtime and application update
 * state — current versions and update status — plus a configurable
 * release-notes link. State flows through the app store's update snapshots.
 */
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useAgentElement } from "../../agent-surface/useAgentElement";
import { useBranding } from "../../config/branding-react.hooks";
import {
  type ApplicationUpdateSnapshot,
  getApplicationUpdateSnapshot,
  mapAgentUpdateStatusToSnapshot,
} from "../../platform/app-update-policy";
import { useAppSelectorShallow } from "../../state/app-store";
import { openExternalUrl } from "../../utils/openExternalUrl";
import {
  normalizeReleaseNotesUrl,
  summarizeError,
} from "../release-center/shared.helpers";
import type { AppReleaseStatus } from "../release-center/types";
import { SettingsInputRow } from "../settings/settings-agent-rows";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../settings/settings-layout";
import { Button } from "../ui/button";

export function ReleaseCenterView() {
  const { appUrl } = useBranding();
  const defaultReleaseNotesUrl = `${appUrl}/releases/`;
  const { loadUpdateStatus, t, updateLoading, updateStatus } =
    useAppSelectorShallow((s) => ({
      loadUpdateStatus: s.loadUpdateStatus,
      t: s.t,
      updateLoading: s.updateLoading,
      updateStatus: s.updateStatus,
    }));

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [applicationUpdate, setApplicationUpdate] =
    useState<ApplicationUpdateSnapshot | null>(null);
  const [releaseNotesUrl, setReleaseNotesUrl] = useState(
    defaultReleaseNotesUrl,
  );
  useEffect(() => {
    void loadUpdateStatus();
  }, [loadUpdateStatus]);

  useEffect(() => {
    void getApplicationUpdateSnapshot().then(setApplicationUpdate);
  }, []);

  const runAction = useCallback(
    async <T,>(
      id: string,
      action: () => Promise<T>,
      successMessage?: string,
    ): Promise<T | null> => {
      setBusyAction(id);
      setActionError(null);
      setActionMessage(null);
      try {
        const result = await action();
        if (successMessage) setActionMessage(successMessage);
        return result;
      } catch (error) {
        setActionError(summarizeError(error));
        return null;
      } finally {
        setBusyAction(null);
      }
    },
    [],
  );

  const refreshReleaseState = async () => {
    await loadUpdateStatus(true);
  };

  const openReleaseNotesWindow = async () => {
    await openExternalUrl(releaseNotesUrl);
  };

  const appStatus = updateStatus as AppReleaseStatus | null | undefined;
  const agentUpdate = mapAgentUpdateStatusToSnapshot(updateStatus ?? null);
  const appVersion =
    applicationUpdate?.version ??
    t("common.unknown", { defaultValue: "Unknown" });
  const lastCheckAt = appStatus?.lastCheckAt;
  const lastChecked = lastCheckAt
    ? new Date(lastCheckAt).toLocaleString("en-US")
    : t("releasecenter.NotYet", { defaultValue: "Not yet" });
  const canAutoUpdate = applicationUpdate?.canAutoUpdate ?? false;

  const versionRows: Array<{ label: string; value: ReactNode }> = [
    {
      label: t("releasecenterview.App", { defaultValue: "App" }),
      value: appVersion,
    },
    ...(applicationUpdate?.build
      ? [
          {
            label: t("releasecenterview.Build", { defaultValue: "Build" }),
            value: applicationUpdate.build,
          },
        ]
      : []),
    ...(applicationUpdate
      ? [
          {
            label: t("releasecenterview.Distribution", {
              defaultValue: "Distribution",
            }),
            value: applicationUpdate.statusLabel,
          },
        ]
      : []),
    ...(applicationUpdate
      ? [
          {
            label: t("releasecenterview.AutoUpdates", {
              defaultValue: "Auto updates",
            }),
            value: canAutoUpdate
              ? t("common.enabled", { defaultValue: "Enabled" })
              : t("common.disabled", { defaultValue: "Disabled" }),
          },
        ]
      : []),
    ...(agentUpdate
      ? [
          {
            label: t("releasecenterview.Agent", {
              defaultValue: "Agent",
            }),
            value: agentUpdate.currentVersion,
          },
          {
            label: t("releasecenterview.AgentLatest", {
              defaultValue: "Agent latest",
            }),
            value:
              agentUpdate.latestVersion ??
              t("releasecenterview.Current", { defaultValue: "Current" }),
          },
          {
            label: t("releasecenterview.AgentAuthority", {
              defaultValue: "Agent authority",
            }),
            value: agentUpdate.authorityLabel,
          },
          {
            label: t("releasecenterview.AgentChannel", {
              defaultValue: "Agent channel",
            }),
            value: agentUpdate.channel,
          },
          {
            label: t("releasecenterview.AgentLastChecked", {
              defaultValue: "Agent last checked",
            }),
            value: lastChecked,
          },
          {
            label: t("releasecenterview.AgentStatus", {
              defaultValue: "Agent status",
            }),
            value: (
              <span className="inline-flex items-center gap-1.5">
                {agentUpdate.status === "error" ||
                agentUpdate.status === "update-available" ? (
                  <AlertTriangle className="size-3.5 text-warn" aria-hidden />
                ) : (
                  <CheckCircle2 className="size-3.5 text-ok" aria-hidden />
                )}
                {agentUpdate.statusLabel}
              </span>
            ),
          },
        ]
      : []),
  ];

  const refreshReleaseStateAction = () =>
    void runAction(
      "refresh",
      refreshReleaseState,
      t("releasecenterview.ReleaseStatusRefreshed", {
        defaultValue: "Release status refreshed.",
      }),
    );
  const openReleaseNotesAction = () =>
    void runAction(
      "open-release-notes",
      openReleaseNotesWindow,
      t("releasecenterview.ReleaseNotesOpened", {
        defaultValue: "Release notes opened.",
      }),
    );
  const resetReleaseNotesUrlAction = () =>
    void runAction(
      "reset-release-url",
      async () => {
        setReleaseNotesUrl(normalizeReleaseNotesUrl(defaultReleaseNotesUrl));
      },
      t("releasecenterview.ReleaseNotesReset", {
        defaultValue: "Release notes URL reset.",
      }),
    );
  const resetUrlLabel = t("releasecenter.ResetUrl", {
    defaultValue: "Reset URL",
  });
  // Surface only a live update error here; the per-channel prose `detail`
  // strings are explanatory copy, not functional state.
  const releaseDetail = agentUpdate?.error ?? null;

  const refreshAgent = useAgentElement<HTMLButtonElement>({
    id: "updates-refresh",
    role: "button",
    label: t("common.refresh"),
    group: "release-actions",
    description: "Refresh the release and update status",
    onActivate: refreshReleaseStateAction,
  });
  const openReleaseNotesAgent = useAgentElement<HTMLButtonElement>({
    id: "updates-open-release-notes",
    role: "button",
    label: t("common.open", { defaultValue: "Open" }),
    group: "release-notes",
    description: "Open the release notes URL",
    onActivate: openReleaseNotesAction,
  });
  const resetReleaseNotesUrlAgent = useAgentElement<HTMLButtonElement>({
    id: "updates-reset-release-url",
    role: "button",
    label: resetUrlLabel,
    group: "release-notes",
    description: "Reset the release notes URL to its default",
    onActivate: resetReleaseNotesUrlAction,
  });

  return (
    <SettingsStack>
      {actionError && (
        <div
          role="alert"
          className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {actionError}
        </div>
      )}
      {actionMessage && (
        <div
          role="status"
          className="rounded-sm border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok"
        >
          {actionMessage}
        </div>
      )}

      <SettingsGroup
        title={t("releasecenterview.Versions", { defaultValue: "Versions" })}
        footer={releaseDetail || undefined}
      >
        {versionRows.map((row) => (
          <SettingsRow
            key={row.label}
            label={row.label}
            control={
              <span className="break-all text-right text-sm font-medium text-txt">
                {row.value}
              </span>
            }
          />
        ))}
      </SettingsGroup>

      <SettingsGroup bare>
        <div className="flex flex-wrap gap-2">
          <Button
            ref={refreshAgent.ref}
            size="icon-sm"
            variant="outline"
            disabled={busyAction === "refresh" || updateLoading}
            aria-label={t("common.refresh")}
            title={t("common.refresh")}
            onClick={refreshReleaseStateAction}
            {...refreshAgent.agentProps}
          >
            <RefreshCw
              className={`size-4 ${busyAction === "refresh" || updateLoading ? "animate-spin" : ""}`}
              aria-hidden
            />
          </Button>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title={t("releasecenterview.ReleaseNotes", {
          defaultValue: "Release Notes",
        })}
      >
        <SettingsInputRow
          agentId="updates-release-notes-url"
          label={t("releasecenterview.ReleaseNotesUrl", {
            defaultValue: "Release notes URL",
          })}
          type="url"
          value={releaseNotesUrl}
          onValueChange={setReleaseNotesUrl}
        />
        <SettingsRow
          label={t("releasecenterview.ReleaseNotes", {
            defaultValue: "Release Notes",
          })}
          stacked
        >
          <div className="flex flex-wrap gap-2">
            <Button
              ref={openReleaseNotesAgent.ref}
              size="compact"
              variant="outline"
              disabled={busyAction === "open-release-notes"}
              onClick={openReleaseNotesAction}
              {...openReleaseNotesAgent.agentProps}
            >
              <ExternalLink className="size-3.5" aria-hidden />
              {t("common.open", { defaultValue: "Open" })}
            </Button>
            <Button
              ref={resetReleaseNotesUrlAgent.ref}
              size="icon-sm"
              variant="ghostMuted"
              aria-label={resetUrlLabel}
              title={resetUrlLabel}
              onClick={resetReleaseNotesUrlAction}
              {...resetReleaseNotesUrlAgent.agentProps}
            >
              <RotateCcw className="size-4" aria-hidden />
            </Button>
          </div>
        </SettingsRow>
      </SettingsGroup>
    </SettingsStack>
  );
}
