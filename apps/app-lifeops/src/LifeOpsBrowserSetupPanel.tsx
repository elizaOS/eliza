import {
  type CreateLifeOpsBrowserCompanionPairingRequest,
  LIFEOPS_BROWSER_SITE_ACCESS_MODES,
  type LifeOpsBrowserCompanionPairingResponse,
  type LifeOpsBrowserCompanionReleaseManifest,
  type LifeOpsBrowserKind,
  type LifeOpsBrowserSettings,
  type LifeOpsBrowserSiteAccessMode,
  type LifeOpsBrowserTrackingMode,
} from "@elizaos/shared/contracts/lifeops";
import {
  Badge,
  Button,
  Input,
  Label,
  Switch,
  Textarea,
} from "@elizaos/app-core";
import {
  Copy,
  Download,
  FolderOpen,
  Package,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client, type ExtensionStatus } from "@elizaos/app-core";
import {
  invokeDesktopBridgeRequest,
  isElectrobunRuntime,
} from "@elizaos/app-core";
import {
  copyTextToClipboard,
  openExternalUrl,
  resolveLifeOpsBrowserApiBaseUrl,
} from "@elizaos/app-core";

type SettingsDraft = {
  enabled: boolean;
  trackingMode: LifeOpsBrowserTrackingMode;
  allowBrowserControl: boolean;
  requireConfirmationForAccountAffecting: boolean;
  incognitoEnabled: boolean;
  siteAccessMode: LifeOpsBrowserSiteAccessMode;
  grantedOriginsText: string;
  blockedOriginsText: string;
  maxRememberedTabs: string;
  pauseUntilLocal: string;
};

const DEFAULT_PAIRING_PROFILE = {
  profileId: "default",
  profileLabel: "Default",
} as const;
const CHROME_EXTENSIONS_URL = "chrome://extensions/";

function settingsToDraft(settings: LifeOpsBrowserSettings): SettingsDraft {
  return {
    enabled: settings.enabled,
    trackingMode: settings.trackingMode,
    allowBrowserControl: settings.allowBrowserControl,
    requireConfirmationForAccountAffecting:
      settings.requireConfirmationForAccountAffecting,
    incognitoEnabled: settings.incognitoEnabled,
    siteAccessMode: settings.siteAccessMode,
    grantedOriginsText: settings.grantedOrigins.join("\n"),
    blockedOriginsText: settings.blockedOrigins.join("\n"),
    maxRememberedTabs: String(settings.maxRememberedTabs),
    pauseUntilLocal: formatDateTimeLocalValue(settings.pauseUntil),
  };
}

function parseOriginLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim().replace(/\/+$/, ""))
    .filter((entry) => entry.length > 0);
}

function formatDateTimeLocalValue(value: string | null): string {
  if (!value) {
    return "";
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  const date = new Date(parsed);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function parseDateTimeLocalValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = new Date(trimmed);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Pause until must be a valid local date and time");
  }
  return parsed.toISOString();
}

function normalizePairingRequest(
  browser: LifeOpsBrowserKind,
  existing: {
    profileId?: string;
    profileLabel?: string;
    label?: string;
  } | null,
): CreateLifeOpsBrowserCompanionPairingRequest {
  return {
    browser,
    profileId: existing?.profileId || DEFAULT_PAIRING_PROFILE.profileId,
    profileLabel:
      existing?.profileLabel || DEFAULT_PAIRING_PROFILE.profileLabel,
    label:
      existing?.label ||
      `LifeOps Browser ${browser} ${existing?.profileLabel || DEFAULT_PAIRING_PROFILE.profileLabel}`,
  };
}

function pairingPayload(
  response: LifeOpsBrowserCompanionPairingResponse,
): Record<string, string> {
  return {
    apiBaseUrl: resolveLifeOpsBrowserApiBaseUrl(),
    companionId: response.companion.id,
    pairingToken: response.pairingToken,
    browser: response.companion.browser,
    profileId: response.companion.profileId,
    profileLabel: response.companion.profileLabel,
    label: response.companion.label,
  };
}

async function openDesktopPath(
  pathValue: string,
  revealOnly = false,
): Promise<void> {
  await invokeDesktopBridgeRequest<void>({
    rpcMethod: revealOnly ? "desktopShowItemInFolder" : "desktopOpenPath",
    ipcChannel: revealOnly ? "desktop:showItemInFolder" : "desktop:openPath",
    params: { path: pathValue },
  });
}

function formatTimestamp(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(parsed));
}

function permissionSummary(
  permissions:
    | {
        tabs: boolean;
        scripting: boolean;
        activeTab: boolean;
        allOrigins: boolean;
        grantedOrigins: string[];
        incognitoEnabled: boolean;
      }
    | undefined,
): string {
  if (!permissions) {
    return "Permissions unavailable";
  }
  return [
    permissions.allOrigins
      ? "all-sites access"
      : permissions.grantedOrigins.length > 0
        ? `${permissions.grantedOrigins.length} granted site${permissions.grantedOrigins.length === 1 ? "" : "s"}`
        : "current-site access",
    permissions.scripting ? "DOM actions enabled" : "DOM actions unavailable",
    permissions.incognitoEnabled ? "incognito on" : "incognito off",
  ].join(" • ");
}

function mergePackageStatus(
  current: ExtensionStatus | null,
  next: {
    extensionPath: string | null;
    chromeBuildPath: string | null;
    chromePackagePath: string | null;
    safariWebExtensionPath: string | null;
    safariAppPath: string | null;
    safariPackagePath: string | null;
    releaseManifest?: LifeOpsBrowserCompanionReleaseManifest | null;
  },
): ExtensionStatus {
  return {
    relayReachable: current?.relayReachable ?? false,
    relayPort: current?.relayPort ?? 18792,
    extensionPath: next.extensionPath,
    chromeBuildPath: next.chromeBuildPath,
    chromePackagePath: next.chromePackagePath,
    safariWebExtensionPath: next.safariWebExtensionPath,
    safariAppPath: next.safariAppPath,
    safariPackagePath: next.safariPackagePath,
    releaseManifest: next.releaseManifest ?? null,
  };
}

function releaseTargetForBrowser(
  browser: LifeOpsBrowserKind,
  releaseManifest: LifeOpsBrowserCompanionReleaseManifest | null | undefined,
) {
  if (!releaseManifest) {
    return null;
  }
  return browser === "chrome" ? releaseManifest.chrome : releaseManifest.safari;
}

function installButtonLabel(
  browser: LifeOpsBrowserKind,
  releaseManifest: LifeOpsBrowserCompanionReleaseManifest | null | undefined,
): string {
  const target = releaseTargetForBrowser(browser, releaseManifest);
  if (target?.installKind === "chrome_web_store") {
    return "Open Chrome Web Store";
  }
  if (target?.installKind === "apple_app_store") {
    return "Open App Store";
  }
  if (target?.installKind === "github_release") {
    return `Download ${browser === "chrome" ? "Chrome" : "Safari"} Release`;
  }
  if (target?.installKind === "local_download") {
    return `Download ${browser === "chrome" ? "Chrome" : "Safari"} Package`;
  }
  return `Install ${browser === "chrome" ? "Chrome" : "Safari"}`;
}

function installHint(
  browser: LifeOpsBrowserKind,
  releaseManifest: LifeOpsBrowserCompanionReleaseManifest | null | undefined,
): string {
  const target = releaseTargetForBrowser(browser, releaseManifest);
  if (target?.installKind === "chrome_web_store") {
    return "Open the Chrome Web Store listing, install the release build, then import the copied pairing JSON in the extension popup.";
  }
  if (target?.installKind === "apple_app_store") {
    return "Open the Safari companion listing, install the released app, then enable the extension and import the copied pairing JSON.";
  }
  if (target?.installKind === "github_release") {
    return "Download the tagged release bundle, install it, then import the copied pairing JSON in the extension popup.";
  }
  if (target?.installKind === "local_download") {
    return "Download the packaged companion bundle, install it locally, then import the copied pairing JSON.";
  }
  return browser === "chrome"
    ? "Load the unpacked build folder in Chrome, or use the packaged zip for distribution."
    : "Open the generated macOS app once, then enable the Safari extension in Safari Settings.";
}

function releaseBadgeLabel(
  browser: LifeOpsBrowserKind,
  releaseManifest: LifeOpsBrowserCompanionReleaseManifest | null | undefined,
): string | null {
  const target = releaseTargetForBrowser(browser, releaseManifest);
  if (!target) {
    return null;
  }
  if (target.installKind === "chrome_web_store") {
    return "Chrome Web Store";
  }
  if (target.installKind === "apple_app_store") {
    return "App Store";
  }
  if (target.installKind === "github_release") {
    return "Release build";
  }
  return "Download";
}

function BrowserCompanionRow({
  browser,
  buildPath,
  packagePath,
  appPath,
  releaseManifest,
  busy,
  pairing,
  onInstall,
  onBuild,
  onCreatePairing,
  onCopyPairing,
  onDownload,
  onOpenPath,
}: {
  browser: LifeOpsBrowserKind;
  buildPath: string | null | undefined;
  packagePath: string | null | undefined;
  appPath?: string | null | undefined;
  releaseManifest?: LifeOpsBrowserCompanionReleaseManifest | null;
  busy: boolean;
  pairing: LifeOpsBrowserCompanionPairingResponse | null;
  onInstall: (browser: LifeOpsBrowserKind) => Promise<void>;
  onBuild: (browser: LifeOpsBrowserKind) => Promise<unknown>;
  onCreatePairing: (browser: LifeOpsBrowserKind) => Promise<unknown>;
  onCopyPairing: (browser: LifeOpsBrowserKind) => Promise<void>;
  onDownload: (browser: LifeOpsBrowserKind) => Promise<unknown>;
  onOpenPath: (path: string, revealOnly?: boolean) => Promise<void>;
}) {
  const browserLabel = browser === "chrome" ? "Chrome" : "Safari";
  const installLabel = installButtonLabel(browser, releaseManifest);
  const distributionLabel = releaseBadgeLabel(browser, releaseManifest);
  const hasLocalArtifact = Boolean(buildPath || packagePath || appPath);

  return (
    <div className="rounded-lg border border-border/50 bg-bg/30 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{browserLabel}</Badge>
        {distributionLabel ? (
          <Badge variant="secondary" className="text-2xs">{distributionLabel}</Badge>
        ) : null}
        {hasLocalArtifact ? (
          <Badge variant="secondary" className="text-2xs">Built</Badge>
        ) : (
          <Badge variant="outline" className="text-2xs">Not built</Badge>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => void onInstall(browser)}
        >
          <Sparkles className="mr-1.5 h-3 w-3" />
          {busy ? "…" : installLabel}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void onBuild(browser)}
        >
          <Package className="mr-1.5 h-3 w-3" />
          Build
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void onCreatePairing(browser)}
        >
          Pair
        </Button>
        {pairing ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void onCopyPairing(browser)}
          >
            <Copy className="mr-1.5 h-3 w-3" />
            Copy
          </Button>
        ) : null}
        {packagePath ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void onDownload(browser)}
          >
            <Download className="mr-1.5 h-3 w-3" />
            Zip
          </Button>
        ) : null}
      </div>

      {(buildPath || packagePath || appPath) ? (
        <div className="space-y-1 text-xs text-muted">
          {buildPath ? (
            <div className="flex items-center gap-2">
              <span className="font-semibold text-txt">Build:</span>
              <span className="min-w-0 truncate font-mono">{buildPath}</span>
              {isElectrobunRuntime() ? (
                <Button size="sm" variant="outline" onClick={() => void onOpenPath(buildPath, true)}>
                  <FolderOpen className="h-3 w-3" />
                </Button>
              ) : null}
            </div>
          ) : null}
          {packagePath ? (
            <div className="flex items-center gap-2">
              <span className="font-semibold text-txt">Pkg:</span>
              <span className="min-w-0 truncate font-mono">{packagePath}</span>
              {isElectrobunRuntime() ? (
                <Button size="sm" variant="outline" onClick={() => void onOpenPath(packagePath, true)}>
                  <FolderOpen className="h-3 w-3" />
                </Button>
              ) : null}
            </div>
          ) : null}
          {appPath ? (
            <div className="flex items-center gap-2">
              <span className="font-semibold text-txt">App:</span>
              <span className="min-w-0 truncate font-mono">{appPath}</span>
              {isElectrobunRuntime() ? (
                <>
                  <Button size="sm" variant="outline" onClick={() => void onOpenPath(appPath)}>Open</Button>
                  <Button size="sm" variant="outline" onClick={() => void onOpenPath(appPath, true)}>
                    <FolderOpen className="h-3 w-3" />
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function LifeOpsBrowserSetupPanel() {
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [companions, setCompanions] = useState<
    Awaited<
      ReturnType<typeof client.listLifeOpsBrowserCompanions>
    >["companions"]
  >([]);
  const [currentPage, setCurrentPage] = useState<string | null>(null);
  const [packageStatus, setPackageStatus] = useState<ExtensionStatus | null>(
    null,
  );
  const [pairings, setPairings] = useState<
    Partial<Record<LifeOpsBrowserKind, LifeOpsBrowserCompanionPairingResponse>>
  >({});
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [buildingBrowser, setBuildingBrowser] =
    useState<LifeOpsBrowserKind | null>(null);
  const [pairingBrowser, setPairingBrowser] =
    useState<LifeOpsBrowserKind | null>(null);
  const [installingBrowser, setInstallingBrowser] =
    useState<LifeOpsBrowserKind | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [
        settingsResponse,
        companionsResponse,
        currentPageResponse,
        status,
      ] = await Promise.all([
        client.getLifeOpsBrowserSettings(),
        client.listLifeOpsBrowserCompanions(),
        client.getLifeOpsBrowserCurrentPage(),
        client.getLifeOpsBrowserPackageStatus(),
      ]);
      setDraft(settingsToDraft(settingsResponse.settings));
      setCompanions(companionsResponse.companions);
      setCurrentPage(
        currentPageResponse.page
          ? `${currentPageResponse.page.title} ${currentPageResponse.page.url}`
          : null,
      );
      setPackageStatus((current) => mergePackageStatus(current, status.status));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const companionByBrowser = useMemo(() => {
    const map = new Map<LifeOpsBrowserKind, (typeof companions)[number]>();
    for (const companion of companions) {
      if (!map.has(companion.browser)) {
        map.set(companion.browser, companion);
      }
    }
    return map;
  }, [companions]);

  const pairingPayloads = useMemo(() => {
    const payloads: Partial<Record<LifeOpsBrowserKind, string>> = {};
    for (const browser of ["chrome", "safari"] as const) {
      const pairing = pairings[browser];
      if (pairing) {
        payloads[browser] = JSON.stringify(pairingPayload(pairing), null, 2);
      }
    }
    return payloads;
  }, [pairings]);

  const updateDraft = <K extends keyof SettingsDraft>(
    key: K,
    value: SettingsDraft[K],
  ) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  const saveSettings = async () => {
    if (!draft) {
      return;
    }
    setSavingSettings(true);
    setError(null);
    try {
      const maxRememberedTabs = Math.max(
        1,
        Number.parseInt(draft.maxRememberedTabs, 10) || 10,
      );
      const response = await client.updateLifeOpsBrowserSettings({
        enabled: draft.enabled,
        trackingMode: draft.trackingMode,
        allowBrowserControl: draft.allowBrowserControl,
        requireConfirmationForAccountAffecting:
          draft.requireConfirmationForAccountAffecting,
        incognitoEnabled: draft.incognitoEnabled,
        siteAccessMode: draft.siteAccessMode,
        grantedOrigins: parseOriginLines(draft.grantedOriginsText),
        blockedOrigins: parseOriginLines(draft.blockedOriginsText),
        maxRememberedTabs,
        pauseUntil: parseDateTimeLocalValue(draft.pauseUntilLocal),
      });
      setDraft(settingsToDraft(response.settings));
      setStatusMessage("Saved LifeOps Browser settings.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingSettings(false);
    }
  };

  const buildPackage = async (
    browser: LifeOpsBrowserKind,
    options?: { silent?: boolean },
  ): Promise<ExtensionStatus> => {
    setBuildingBrowser(browser);
    setError(null);
    try {
      const response =
        await client.buildLifeOpsBrowserCompanionPackage(browser);
      const nextStatus = mergePackageStatus(packageStatus, response.status);
      setPackageStatus(nextStatus);
      if (!options?.silent) {
        setStatusMessage(
          `Built ${browser === "chrome" ? "Chrome" : "Safari"} companion package.`,
        );
      }
      return nextStatus;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setBuildingBrowser(null);
    }
  };

  const createPairing = async (
    browser: LifeOpsBrowserKind,
    options?: { silent?: boolean },
  ): Promise<LifeOpsBrowserCompanionPairingResponse> => {
    setPairingBrowser(browser);
    setError(null);
    try {
      const response = await client.createLifeOpsBrowserCompanionPairing(
        normalizePairingRequest(
          browser,
          companionByBrowser.get(browser) ?? null,
        ),
      );
      setPairings((current) => ({
        ...current,
        [browser]: response,
      }));
      if (!options?.silent) {
        setStatusMessage(
          `Created a ${browser} pairing payload. Import it into the companion popup.`,
        );
      }
      await refresh();
      return response;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setPairingBrowser(null);
    }
  };

  const copyPairing = async (browser: LifeOpsBrowserKind) => {
    try {
      const payload = pairingPayloads[browser];
      if (!payload) {
        return;
      }
      await copyTextToClipboard(payload);
      setStatusMessage(`Copied ${browser} pairing JSON to the clipboard.`);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const downloadPackage = async (
    browser: LifeOpsBrowserKind,
    options?: { silent?: boolean },
  ) => {
    try {
      setError(null);
      const download =
        await client.downloadLifeOpsBrowserCompanionPackage(browser);
      const objectUrl = URL.createObjectURL(download.blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = download.filename;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
      }, 0);
      if (!options?.silent) {
        setStatusMessage(
          `Downloaded ${browser === "chrome" ? "Chrome" : "Safari"} companion package.`,
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  };

  const openPath = async (pathValue: string, revealOnly = false) => {
    try {
      if (isElectrobunRuntime()) {
        await openDesktopPath(pathValue, revealOnly);
        setError(null);
        return;
      }
      await copyTextToClipboard(pathValue);
      setStatusMessage("Copied the local path to the clipboard.");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const installCompanion = async (browser: LifeOpsBrowserKind) => {
    setInstallingBrowser(browser);
    setError(null);
    try {
      const releaseTarget = releaseTargetForBrowser(
        browser,
        packageStatus?.releaseManifest,
      );
      const response = await createPairing(browser, { silent: true });
      await copyTextToClipboard(
        JSON.stringify(pairingPayload(response), null, 2),
      );

      if (releaseTarget?.installUrl) {
        await openExternalUrl(releaseTarget.installUrl);
        setStatusMessage(
          releaseTarget.installKind === "chrome_web_store"
            ? "Chrome install is prepared. We copied the pairing JSON and opened the Chrome Web Store listing. Install the release build, then import the copied pairing JSON in the extension popup."
            : releaseTarget.installKind === "apple_app_store"
              ? "Safari install is prepared. We copied the pairing JSON and opened the App Store listing. Install the release app, enable the Safari extension, then import the copied pairing JSON."
              : `${browser === "chrome" ? "Chrome" : "Safari"} install is prepared. We copied the pairing JSON and opened the release download. Install the release build, then import the copied pairing JSON in the extension popup.`,
        );
        return;
      }

      const needsBuild =
        browser === "chrome"
          ? isElectrobunRuntime()
            ? !packageStatus?.chromeBuildPath
            : !packageStatus?.chromePackagePath
          : isElectrobunRuntime()
            ? !packageStatus?.safariAppPath
            : !packageStatus?.safariPackagePath;

      const nextStatus = needsBuild
        ? await buildPackage(browser, { silent: true })
        : packageStatus;

      if (browser === "chrome") {
        if (isElectrobunRuntime()) {
          const buildPath = nextStatus?.chromeBuildPath;
          if (!buildPath) {
            throw new Error("Chrome build folder is not available");
          }
          await openDesktopPath(buildPath, true);
        } else {
          await downloadPackage(browser, { silent: true });
        }
        await openExternalUrl(CHROME_EXTENSIONS_URL);
        setStatusMessage(
          "Chrome install is prepared. We copied the pairing JSON and opened the extension manager. In Chrome, click Load unpacked and select the built LifeOps Browser folder.",
        );
      } else {
        if (isElectrobunRuntime()) {
          const appPath = nextStatus?.safariAppPath;
          if (!appPath) {
            throw new Error("Safari app bundle is not available");
          }
          await openDesktopPath(appPath);
        } else {
          await downloadPackage(browser, { silent: true });
        }
        setStatusMessage(
          "Safari install is prepared. We copied the pairing JSON and opened the LifeOps Browser app or package. Run the app once, then enable the extension in Safari Settings.",
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInstallingBrowser(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-muted">
          <ShieldCheck className="h-4 w-4" />
          <div className="text-xs font-semibold uppercase tracking-wide">
            LifeOps Browser
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => void refresh()}>
          <RefreshCw className="mr-1.5 h-3 w-3" />
          Refresh
        </Button>
      </div>

      {currentPage ? (
        <div className="text-xs text-muted">
          Current page: <span className="text-txt">{currentPage}</span>
        </div>
      ) : null}
      {statusMessage ? (
        <div className="rounded-lg border border-border/50 bg-bg/40 px-3 py-2 text-xs text-txt">
          {statusMessage}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-lg border border-danger/50 bg-danger/10 px-3 py-1.5 text-xs text-danger">
          {error}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        {/* Left column: settings */}
        <div className="space-y-3">
          {draft ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-semibold text-muted uppercase tracking-wide">Settings</div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={savingSettings || loading}
                  onClick={() => void saveSettings()}
                >
                  {savingSettings ? "Saving…" : "Save"}
                </Button>
              </div>

              <div className="grid gap-2 grid-cols-2">
                <div className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-bg/40 px-3 py-1.5">
                  <span className="text-xs font-medium text-txt">Enabled</span>
                  <Switch
                    checked={draft.enabled}
                    onCheckedChange={(checked) => updateDraft("enabled", checked)}
                  />
                </div>
                <div className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-bg/40 px-3 py-1.5">
                  <span className="text-xs font-medium text-txt">Browser control</span>
                  <Switch
                    checked={draft.allowBrowserControl}
                    onCheckedChange={(checked) =>
                      updateDraft("allowBrowserControl", checked)
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-bg/40 px-3 py-1.5">
                  <span className="text-xs font-medium text-txt">Require confirmation</span>
                  <Switch
                    checked={draft.requireConfirmationForAccountAffecting}
                    onCheckedChange={(checked) =>
                      updateDraft(
                        "requireConfirmationForAccountAffecting",
                        checked,
                      )
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-bg/40 px-3 py-1.5">
                  <span className="text-xs font-medium text-txt">Incognito</span>
                  <Switch
                    checked={draft.incognitoEnabled}
                    onCheckedChange={(checked) =>
                      updateDraft("incognitoEnabled", checked)
                    }
                  />
                </div>
              </div>

              <div className="grid gap-3 grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted">Tracking</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {(["off", "current_tab", "active_tabs"] as const).map(
                      (mode) => (
                        <Button
                          key={mode}
                          size="sm"
                          variant={
                            draft.trackingMode === mode ? "default" : "outline"
                          }
                          onClick={() => updateDraft("trackingMode", mode)}
                        >
                          {mode === "off"
                            ? "Off"
                            : mode === "current_tab"
                              ? "Current tab"
                              : "Active tabs"}
                        </Button>
                      ),
                    )}
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted">Site access</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {LIFEOPS_BROWSER_SITE_ACCESS_MODES.map((mode) => (
                      <Button
                        key={mode}
                        size="sm"
                        variant={
                          draft.siteAccessMode === mode ? "default" : "outline"
                        }
                        onClick={() => updateDraft("siteAccessMode", mode)}
                      >
                        {mode === "current_site_only"
                          ? "Current site"
                          : mode === "granted_sites"
                            ? "Granted sites"
                            : "All sites"}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid gap-3 grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="lifeops-browser-max-tabs" className="text-xs text-muted">
                    Max remembered tabs
                  </Label>
                  <Input
                    id="lifeops-browser-max-tabs"
                    value={draft.maxRememberedTabs}
                    onChange={(event) =>
                      updateDraft("maxRememberedTabs", event.currentTarget.value)
                    }
                    inputMode="numeric"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="lifeops-browser-pause-until" className="text-xs text-muted">
                    Pause until
                  </Label>
                  <div className="flex gap-1.5">
                    <Input
                      id="lifeops-browser-pause-until"
                      type="datetime-local"
                      value={draft.pauseUntilLocal}
                      onChange={(event) =>
                        updateDraft("pauseUntilLocal", event.currentTarget.value)
                      }
                      className="min-w-0 flex-1"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        updateDraft(
                          "pauseUntilLocal",
                          formatDateTimeLocalValue(
                            new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                          ),
                        )
                      }
                    >
                      1h
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => updateDraft("pauseUntilLocal", "")}
                    >
                      Now
                    </Button>
                  </div>
                </div>
              </div>

              <div className="grid gap-3 grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="lifeops-browser-granted-origins" className="text-xs text-muted">
                    Granted origins
                  </Label>
                  <Textarea
                    id="lifeops-browser-granted-origins"
                    rows={3}
                    placeholder="https://mail.google.com"
                    value={draft.grantedOriginsText}
                    onChange={(event) =>
                      updateDraft("grantedOriginsText", event.currentTarget.value)
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="lifeops-browser-blocked-origins" className="text-xs text-muted">
                    Blocked origins
                  </Label>
                  <Textarea
                    id="lifeops-browser-blocked-origins"
                    rows={3}
                    placeholder="https://bank.example.com"
                    value={draft.blockedOriginsText}
                    onChange={(event) =>
                      updateDraft("blockedOriginsText", event.currentTarget.value)
                    }
                  />
                </div>
              </div>

              <div className="text-xs text-muted">
                Companions: {companions.length} | Workspace: <span className="font-mono text-txt">{packageStatus?.extensionPath ?? "N/A"}</span>
              </div>
            </>
          ) : loading ? (
            <div className="text-xs text-muted">Loading settings…</div>
          ) : null}
        </div>

        {/* Right column: installation & connectivity */}
        <div className="space-y-3">
          <div className="text-xs font-semibold text-muted uppercase tracking-wide">Installation</div>
          <BrowserCompanionRow
            browser="chrome"
            buildPath={packageStatus?.chromeBuildPath}
            packagePath={packageStatus?.chromePackagePath}
            releaseManifest={packageStatus?.releaseManifest ?? null}
            busy={
              buildingBrowser === "chrome" ||
              pairingBrowser === "chrome" ||
              installingBrowser === "chrome"
            }
            pairing={pairings.chrome ?? null}
            onInstall={installCompanion}
            onBuild={buildPackage}
            onCreatePairing={createPairing}
            onCopyPairing={copyPairing}
            onDownload={downloadPackage}
            onOpenPath={openPath}
          />
          <BrowserCompanionRow
            browser="safari"
            buildPath={packageStatus?.safariWebExtensionPath}
            packagePath={packageStatus?.safariPackagePath}
            appPath={packageStatus?.safariAppPath}
            releaseManifest={packageStatus?.releaseManifest ?? null}
            busy={
              buildingBrowser === "safari" ||
              pairingBrowser === "safari" ||
              installingBrowser === "safari"
            }
            pairing={pairings.safari ?? null}
            onInstall={installCompanion}
            onBuild={buildPackage}
            onCreatePairing={createPairing}
            onCopyPairing={copyPairing}
            onDownload={downloadPackage}
            onOpenPath={openPath}
          />

          {(["chrome", "safari"] as const).map((browser) => {
            const payload = pairingPayloads[browser];
            if (!payload) {
              return null;
            }
            return (
              <div key={browser} className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-txt">
                    {browser === "chrome" ? "Chrome" : "Safari"} pairing
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void copyPairing(browser)}
                  >
                    <Copy className="mr-1.5 h-3 w-3" />
                    Copy
                  </Button>
                </div>
                <Textarea
                  readOnly
                  rows={5}
                  value={payload}
                  className="font-mono text-xs"
                />
              </div>
            );
          })}

          {companions.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-muted uppercase tracking-wide">Paired companions</div>
              <div className="grid gap-2">
                {companions.map((companion) => (
                  <div
                    key={companion.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 bg-bg/40 px-3 py-1.5 text-xs"
                  >
                    <Badge variant="outline" className="text-2xs">
                      {companion.browser}/{companion.profileLabel}
                    </Badge>
                    <Badge variant="secondary" className="text-2xs">
                      {companion.connectionState}
                    </Badge>
                    <span className="text-muted">
                      {formatTimestamp(companion.lastSeenAt) ?? "Never seen"}
                    </span>
                    <span className="text-muted">
                      {permissionSummary(companion.permissions)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
