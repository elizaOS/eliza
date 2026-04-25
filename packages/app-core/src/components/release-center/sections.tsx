import { Button, Input } from "@elizaos/ui";
import { createElement } from "react";
import { useBranding } from "../../config/branding";
import { useApp } from "../../state";
import { formatDateTime } from "../../utils/format";
import { DefinitionRow, partitionDescription, StatusPill } from "./shared";
import type {
  AppReleaseStatus,
  DesktopBuildInfo,
  DesktopReleaseNotesWindowInfo,
  DesktopSessionSnapshot,
  DesktopUpdaterSnapshot,
  WebGpuBrowserStatus,
  WgpuTagElement,
} from "./types";
import { SESSION_PARTITIONS } from "./types";

function tr(
  t: (key: string, options?: Record<string, unknown>) => string,
  key: string,
  defaultValue: string,
  options?: Record<string, unknown>,
) {
  return t(key, { defaultValue, ...options });
}

export function ReleaseStatusSection({
  busyAction,
  nativeUpdater,
  updateLoading,
  updateStatus,
  onApplyUpdate,
  onCheckForUpdates,
  onDetach,
  onRefresh,
}: {
  busyAction: string | null;
  nativeUpdater: DesktopUpdaterSnapshot | null;
  updateLoading: boolean;
  updateStatus: AppReleaseStatus | null | undefined;
  onApplyUpdate: () => void;
  onCheckForUpdates: () => void;
  onDetach: () => void;
  onRefresh: () => void;
}) {
  const { t } = useApp();
  const appReleaseTone = updateStatus?.updateAvailable ? "warning" : "good";
  const autoUpdateDisabled =
    nativeUpdater != null && !nativeUpdater.canAutoUpdate;
  const nativeReleaseTone = nativeUpdater?.updateReady
    ? "good"
    : nativeUpdater?.updateAvailable
      ? "warning"
      : "neutral";
  const loadingLabel = tr(t, "common.loading", "loading");
  const currentLabel = tr(t, "releasecenterview.Current", "Current");

  return (
    <section className="rounded-2xl border border-border bg-bg-accent p-4">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusPill
          label={tr(t, "releasecenter.AppVersionPill", "App: {{version}}", {
            version: updateStatus?.currentVersion ?? loadingLabel,
          })}
          tone={appReleaseTone}
        />
        <StatusPill
          label={tr(
            t,
            "releasecenter.DesktopVersionPill",
            "Desktop: {{version}}",
            {
              version: nativeUpdater?.currentVersion ?? loadingLabel,
            },
          )}
          tone={nativeReleaseTone}
        />
        {nativeUpdater?.channel ? (
          <StatusPill
            label={tr(t, "releasecenter.ChannelPill", "Channel: {{channel}}", {
              channel: nativeUpdater.channel,
            })}
            tone="neutral"
          />
        ) : null}
      </div>

      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-txt">
            {tr(t, "releasecenter.ReleaseStatus", "Release Status")}
          </h3>
          <p className="mt-1 text-xs text-muted">
            {tr(
              t,
              "releasecenter.ReleaseStatusDescription",
              "Compare backend release metadata with the native Electrobun updater state.",
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busyAction === "refresh" || updateLoading}
            onClick={onRefresh}
          >
            {tr(t, "common.refresh", "Refresh")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busyAction === "detach-release"}
            onClick={onDetach}
          >
            {tr(
              t,
              "releasecenter.OpenDetachedReleaseCenter",
              "Open Detached Release Center",
            )}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-border bg-bg p-3">
          <div className="text-xs font-semibold text-txt">
            {tr(t, "releasecenter.AppReleaseService", "App Release Service")}
          </div>
          <DefinitionRow
            label={tr(t, "releasecenter.CurrentVersion", "Current version")}
            value={updateStatus?.currentVersion}
          />
          <DefinitionRow
            label={tr(t, "releasecenter.LatestVersion", "Latest version")}
            value={updateStatus?.latestVersion ?? currentLabel}
          />
          <DefinitionRow
            label={tr(t, "releasecenterview.Channel", "Channel")}
            value={updateStatus?.channel}
          />
          <DefinitionRow
            label={tr(t, "releasecenter.LastChecked", "Last checked")}
            value={
              updateStatus?.lastCheckAt
                ? new Date(updateStatus.lastCheckAt).toLocaleString()
                : tr(t, "releasecenter.NotYet", "Not yet")
            }
          />
        </div>

        <div className="rounded-xl border border-border bg-bg p-3">
          <div className="mb-3 text-xs font-semibold text-txt">
            {tr(
              t,
              "releasecenter.NativeElectrobunUpdater",
              "Native Electrobun Updater",
            )}
          </div>
          <DefinitionRow
            label={tr(t, "releasecenter.CurrentVersion", "Current version")}
            value={nativeUpdater?.currentVersion}
          />
          <DefinitionRow
            label={tr(t, "releasecenter.LatestVersion", "Latest version")}
            value={nativeUpdater?.latestVersion ?? currentLabel}
          />
          <DefinitionRow
            label={tr(t, "releasecenter.AppBundle", "App bundle")}
            value={
              nativeUpdater?.appBundlePath ?? tr(t, "common.unknown", "Unknown")
            }
          />
          <DefinitionRow
            label={tr(t, "releasecenter.LastStatus", "Last status")}
            value={
              nativeUpdater?.lastStatus?.message ??
              tr(t, "releasecenterview.Idle", "Idle")
            }
          />
          <DefinitionRow
            label={tr(t, "releasecenter.StatusTime", "Status time")}
            value={formatDateTime(nativeUpdater?.lastStatus?.timestamp, {
              fallback: tr(t, "releasecenter.NotYet", "Not yet"),
            })}
          />
          {autoUpdateDisabled && nativeUpdater?.autoUpdateDisabledReason ? (
            <div className="mt-3 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
              {nativeUpdater.autoUpdateDisabledReason}
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busyAction === "check-updates" || autoUpdateDisabled}
              onClick={onCheckForUpdates}
            >
              {tr(
                t,
                "releasecenter.CheckDownloadUpdate",
                "Check / Download Update",
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                busyAction === "apply-update" ||
                autoUpdateDisabled ||
                !nativeUpdater?.updateReady
              }
              onClick={onApplyUpdate}
            >
              {tr(
                t,
                "releasecenter.ApplyDownloadedUpdate",
                "Apply Downloaded Update",
              )}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

export function ReleaseNotesSection({
  busyAction,
  nativeUpdater,
  releaseNotesUrl,
  releaseNotesWindow,
  onOpenWindow,
  onReleaseNotesUrlChange,
  onResetUrl,
}: {
  busyAction: string | null;
  nativeUpdater: DesktopUpdaterSnapshot | null;
  releaseNotesUrl: string;
  releaseNotesWindow: DesktopReleaseNotesWindowInfo | null;
  onOpenWindow: () => void;
  onReleaseNotesUrlChange: (value: string) => void;
  onResetUrl: () => void;
}) {
  const { t } = useApp();
  const { appUrl } = useBranding();
  const defaultReleaseNotesUrl = `${appUrl}/releases/`;

  return (
    <section className="rounded-2xl border border-border bg-bg-accent p-4">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-txt">
          {tr(
            t,
            "releasecenter.ReleaseNotesBrowserView",
            "Release Notes BrowserView",
          )}
        </h3>
        <p className="mt-1 text-xs text-muted">
          {tr(
            t,
            "releasecenter.ReleaseNotesBrowserViewDescription",
            "Opens release notes in a dedicated sandboxed BrowserView on its own persistent session.",
          )}
        </p>
      </div>

      <div className="space-y-3">
        <Input
          value={releaseNotesUrl}
          onChange={(event) => onReleaseNotesUrlChange(event.target.value)}
          placeholder={defaultReleaseNotesUrl}
          className="font-mono text-xs"
        />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busyAction === "open-release-notes"}
            onClick={onOpenWindow}
          >
            {tr(
              t,
              "releasecenter.OpenBrowserViewWindow",
              "Open BrowserView Window",
            )}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busyAction === "reset-release-url"}
            onClick={onResetUrl}
          >
            {tr(t, "releasecenter.ResetUrl", "Reset URL")}
          </Button>
        </div>

        {releaseNotesWindow ? (
          <div className="rounded-xl border border-border bg-bg p-3 text-xs text-txt">
            <DefinitionRow
              label={tr(t, "releasecenter.WindowId", "Window ID")}
              value={releaseNotesWindow.windowId}
            />
            <DefinitionRow
              label={tr(t, "releasecenter.BrowserViewId", "BrowserView ID")}
              value={releaseNotesWindow.webviewId}
            />
            <DefinitionRow
              label={tr(t, "appsview.URL", "URL")}
              value={releaseNotesWindow.url}
            />
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-bg p-3 text-xs text-muted">
            {tr(t, "releasecenter.UsingUpdaterUrl", "Using updater URL:")}{" "}
            {nativeUpdater?.baseUrl ?? defaultReleaseNotesUrl}
          </div>
        )}
      </div>
    </section>
  );
}

export function BuildRuntimeSection({
  buildInfo,
  busyAction,
  dockVisible,
  nativeUpdater,
  onToggleDock,
}: {
  buildInfo: DesktopBuildInfo | null;
  busyAction: string | null;
  dockVisible: boolean;
  nativeUpdater: DesktopUpdaterSnapshot | null;
  onToggleDock: () => void;
}) {
  const { t } = useApp();
  const { appUrl } = useBranding();
  const defaultReleaseNotesUrl = `${appUrl}/releases/`;

  return (
    <section className="rounded-2xl border border-border bg-bg-accent p-4">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-txt">
          {tr(
            t,
            "releasecenter.BuildConfigAndShellRuntime",
            "BuildConfig and Shell Runtime",
          )}
        </h3>
        <p className="mt-1 text-xs text-muted">
          {tr(
            t,
            "releasecenter.BuildConfigAndShellRuntimeDescription",
            "Native runtime metadata sourced directly from Electrobun BuildConfig and shell APIs.",
          )}
        </p>
      </div>

      <div className="rounded-xl border border-border bg-bg p-3">
        <DefinitionRow
          label={tr(t, "releasecenter.Platform", "Platform")}
          value={buildInfo?.platform}
        />
        <DefinitionRow
          label={tr(t, "releasecenter.Architecture", "Architecture")}
          value={buildInfo?.arch}
        />
        <DefinitionRow
          label={tr(t, "releasecenter.DefaultRenderer", "Default renderer")}
          value={buildInfo?.defaultRenderer}
        />
        <DefinitionRow
          label={tr(
            t,
            "releasecenter.AvailableRenderers",
            "Available renderers",
          )}
          value={buildInfo?.availableRenderers.join(", ")}
        />
        <DefinitionRow
          label={tr(t, "releasecenter.BunVersion", "Bun version")}
          value={buildInfo?.bunVersion}
        />
        <DefinitionRow
          label={tr(t, "releasecenter.CefVersion", "CEF version")}
          value={buildInfo?.cefVersion}
        />
        <DefinitionRow
          label={tr(t, "releasecenter.UpdaterBaseUrl", "Updater base URL")}
          value={nativeUpdater?.baseUrl ?? defaultReleaseNotesUrl}
        />
        <DefinitionRow
          label={tr(t, "releasecenter.DockIconVisible", "Dock icon visible")}
          value={
            buildInfo?.platform === "darwin"
              ? String(dockVisible)
              : tr(t, "releasecenter.MacOsOnly", "macOS only")
          }
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={
              busyAction === "toggle-dock" || buildInfo?.platform !== "darwin"
            }
            onClick={onToggleDock}
          >
            {dockVisible
              ? tr(t, "releasecenter.HideDockIcon", "Hide Dock Icon")
              : tr(t, "releasecenter.ShowDockIcon", "Show Dock Icon")}
          </Button>
        </div>
      </div>
    </section>
  );
}

export function SessionControlsSection({
  busyAction,
  sessionSnapshots,
  onClearCookies,
  onClearSession,
}: {
  busyAction: string | null;
  sessionSnapshots: Record<string, DesktopSessionSnapshot | undefined>;
  onClearCookies: (partition: string) => void;
  onClearSession: (partition: string) => void;
}) {
  const { t } = useApp();
  return (
    <section className="rounded-2xl border border-border bg-bg-accent p-4">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-txt">
          {tr(
            t,
            "releasecenter.SessionAndCookieControls",
            "Session and Cookie Controls",
          )}
        </h3>
        <p className="mt-1 text-xs text-muted">
          {tr(
            t,
            "releasecenter.SessionAndCookieControlsDescription",
            "Explicit Session APIs for inspecting and clearing renderer storage.",
          )}
        </p>
      </div>

      <div className="space-y-3">
        {SESSION_PARTITIONS.map(({ label, partition }) => {
          const snapshot = sessionSnapshots[partition];
          return (
            <div
              key={partition}
              className="rounded-xl border border-border bg-bg p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold text-txt">{label}</div>
                  <div className="mt-1 text-xs-tight text-muted">
                    {partitionDescription(partition, t)}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyAction === `clear-cookies:${partition}`}
                    onClick={() => onClearCookies(partition)}
                  >
                    {tr(t, "releasecenter.ClearCookies", "Clear Cookies")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyAction === `clear-session:${partition}`}
                    onClick={() => onClearSession(partition)}
                  >
                    {tr(t, "releasecenter.ClearStorage", "Clear Storage")}
                  </Button>
                </div>
              </div>

              <div className="mt-3">
                <DefinitionRow
                  label={tr(t, "releasecenter.Partition", "Partition")}
                  value={snapshot?.partition ?? partition}
                />
                <DefinitionRow
                  label={tr(t, "releasecenter.Persistent", "Persistent")}
                  value={snapshot ? String(snapshot.persistent) : undefined}
                />
                <DefinitionRow
                  label={tr(t, "releasecenter.CookieCount", "Cookie count")}
                  value={snapshot?.cookieCount}
                />
              </div>

              {snapshot?.cookies.length ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {snapshot.cookies.slice(0, 8).map((cookie) => (
                    <span
                      key={`${partition}:${cookie.name}:${cookie.domain ?? ""}`}
                      className="inline-flex items-center rounded-full border border-border bg-bg-accent px-2 py-1 text-xs-tight text-txt"
                    >
                      {cookie.name}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="mt-3 text-xs-tight text-muted">
                  {tr(
                    t,
                    "releasecenter.NoCookiesStoredForThisPartition",
                    "No cookies stored for this partition.",
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function WgpuSurfaceSection({
  webGpuStatus,
  wgpuHidden,
  wgpuPassthrough,
  wgpuReady,
  wgpuRef,
  wgpuTagAvailable,
  wgpuTransparent,
  onRunTest,
  onToggleHidden,
  onTogglePassthrough,
  onToggleTransparent,
}: {
  webGpuStatus: WebGpuBrowserStatus | null;
  wgpuHidden: boolean;
  wgpuPassthrough: boolean;
  wgpuReady: boolean;
  wgpuRef: { current: WgpuTagElement | null };
  wgpuTagAvailable: boolean;
  wgpuTransparent: boolean;
  onRunTest: () => void;
  onToggleHidden: () => void;
  onTogglePassthrough: () => void;
  onToggleTransparent: () => void;
}) {
  const { t } = useApp();
  return (
    <section className="rounded-2xl border border-border bg-bg-accent p-4">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-txt">
          {tr(t, "releasecenter.BrowserWgpuSurface", "Browser WGPU Surface")}
        </h3>
        <p className="mt-1 text-xs text-muted">
          {tr(
            t,
            "releasecenter.BrowserWgpuSurfaceDescription",
            "Inline <electrobun-wgpu> preview plus browser WebGPU compatibility status from the active desktop renderer.",
          )}
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3">
          {wgpuTagAvailable ? (
            <div className="overflow-hidden rounded-2xl border border-border bg-black/5">
              {createElement("electrobun-wgpu", {
                ref: (node: WgpuTagElement | null) => {
                  wgpuRef.current = node;
                },
                className: "block h-56 w-full",
              })}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-border px-4 py-12 text-center text-sm text-muted">
              {tr(
                t,
                "releasecenter.WgpuCustomElementUnavailable",
                "The WGPU custom element is not available in this renderer.",
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!wgpuTagAvailable} onClick={onRunTest}>
              {tr(t, "releasecenter.RunTest", "Run Test")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!wgpuTagAvailable}
              onClick={onToggleTransparent}
            >
              {wgpuTransparent
                ? tr(t, "releasecenter.Opaque", "Opaque")
                : tr(t, "releasecenter.Transparent", "Transparent")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!wgpuTagAvailable}
              onClick={onTogglePassthrough}
            >
              {wgpuPassthrough
                ? tr(t, "releasecenter.PassthroughOff", "Passthrough Off")
                : tr(t, "releasecenter.PassthroughOn", "Passthrough On")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!wgpuTagAvailable}
              onClick={onToggleHidden}
            >
              {wgpuHidden
                ? tr(t, "releasecenter.ShowSurface", "Show Surface")
                : tr(t, "releasecenter.HideSurface", "Hide Surface")}
            </Button>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-bg p-3">
          <div className="mb-3 text-xs font-semibold text-txt">
            {tr(
              t,
              "releasecenter.BrowserWebgpuStatus",
              "Browser WebGPU Status",
            )}
          </div>
          <p className="mb-3 text-xs text-muted">
            {tr(
              t,
              "releasecenter.BrowserWebgpuStatusDescription",
              "This reports whether the desktop webview is expected to expose WebGPU for the WGPU preview above. It is not overall app health: companion and avatar already fall back to WebGL when WebGPU is missing.",
            )}
          </p>
          <DefinitionRow
            label={tr(
              t,
              "releasecenter.InlineSurfaceReady",
              "Inline surface ready",
            )}
            value={String(wgpuReady)}
          />
          <DefinitionRow
            label={tr(t, "releasecenter.RendererSupport", "Renderer support")}
            value={
              webGpuStatus?.available
                ? tr(t, "releasecenter.Available", "Available")
                : tr(t, "releasecenter.NotAvailable", "Not available")
            }
          />
          <DefinitionRow
            label={tr(t, "releasecenter.RendererType", "Renderer type")}
            value={webGpuStatus?.renderer}
          />
          <DefinitionRow
            label={tr(t, "releasecenter.ChromeBeta", "Chrome Beta")}
            value={
              webGpuStatus?.chromeBetaPath ??
              tr(t, "releasecenter.NotDetected", "Not detected")
            }
          />
          <div className="mt-3 rounded-lg border border-border bg-bg-accent px-3 py-2 text-xs text-muted">
            {webGpuStatus?.reason ??
              tr(
                t,
                "releasecenter.WaitingForDesktopRendererStatus",
                "Waiting for desktop renderer status.",
              )}
          </div>
          {webGpuStatus?.downloadUrl ? (
            <div className="mt-3 text-xs">
              <a
                className="text-accent underline-offset-2 hover:underline"
                href={webGpuStatus.downloadUrl}
                target="_blank"
                rel="noreferrer"
              >
                {tr(
                  t,
                  "releasecenter.DownloadChromeBetaFallback",
                  "Download Chrome Beta fallback",
                )}
              </a>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
