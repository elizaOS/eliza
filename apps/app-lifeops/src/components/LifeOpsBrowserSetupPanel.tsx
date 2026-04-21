import {
  Badge,
  Button,
  client,
  copyTextToClipboard,
  type ExtensionStatus,
  Input,
  invokeDesktopBridgeRequest,
  isElectrobunRuntime,
  Label,
  openExternalUrl,
  SegmentedControl,
  Switch,
  Textarea,
  useApp,
} from "@elizaos/app-core";
import {
  type CreateLifeOpsBrowserCompanionPairingRequest,
  LIFEOPS_BROWSER_SITE_ACCESS_MODES,
  type LifeOpsBrowserCompanionPairingResponse,
  type LifeOpsBrowserCompanionReleaseManifest,
  type LifeOpsBrowserKind,
  type LifeOpsBrowserPackagePathTarget,
  type LifeOpsBrowserSettings,
  type LifeOpsBrowserSiteAccessMode,
  type LifeOpsBrowserTrackingMode,
} from "@elizaos/app-lifeops/contracts";
import {
  Copy,
  Download,
  FolderOpen,
  Monitor,
  Package,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveLifeOpsBrowserApiBaseUrl } from "../utils/lifeops-url.js";

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
const CONNECTION_REFRESH_INTERVAL_MS = 4_000;

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

function isFutureLocalDateTimeValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  const parsed = new Date(trimmed);
  return Number.isFinite(parsed.getTime()) && parsed.getTime() > Date.now();
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
  hasLocalArtifact: boolean,
): string {
  if (hasLocalArtifact) {
    return browser === "chrome" ? "Install in Chrome" : "Install in Safari";
  }
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
  return `Install ${browser === "chrome" ? "Chrome" : "Safari"} Extension`;
}

function trackingModeLabel(mode: LifeOpsBrowserTrackingMode): string {
  switch (mode) {
    case "current_tab":
      return "Current tab";
    case "active_tabs":
      return "Active tabs";
    default:
      return "Off";
  }
}

function siteAccessModeLabel(mode: LifeOpsBrowserSiteAccessMode): string {
  switch (mode) {
    case "current_site_only":
      return "Current site";
    case "granted_sites":
      return "Granted sites";
    default:
      return "All sites";
  }
}

function BrowserSettingRow({
  checked,
  hint,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  hint?: string;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm text-txt">{label}</div>
        {hint ? <div className="mt-0.5 text-xs text-muted">{hint}</div> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
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
  onOpenTarget,
  onOpenManager,
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
  onOpenTarget: (
    target: LifeOpsBrowserPackagePathTarget,
    revealOnly?: boolean,
  ) => Promise<unknown>;
  onOpenManager: (browser: LifeOpsBrowserKind) => Promise<unknown>;
}) {
  const browserLabel = browser === "chrome" ? "Chrome" : "Safari";
  const distributionLabel = releaseBadgeLabel(browser, releaseManifest);
  const hasLocalArtifact = Boolean(buildPath || packagePath || appPath);
  const installLabel = installButtonLabel(
    browser,
    releaseManifest,
    hasLocalArtifact,
  );

  return (
    <div className="space-y-2 rounded-2xl bg-card/16 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{browserLabel}</Badge>
        {distributionLabel ? (
          <Badge variant="secondary" className="text-2xs">
            {distributionLabel}
          </Badge>
        ) : null}
        {hasLocalArtifact ? (
          <Badge variant="secondary" className="text-2xs">
            Built
          </Badge>
        ) : (
          <Badge variant="outline" className="text-2xs">
            Not built
          </Badge>
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
          Manual Fallback
        </Button>
        {browser === "chrome" && buildPath ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void onOpenTarget("chrome_build", true)}
            >
              <FolderOpen className="mr-1.5 h-3 w-3" />
              Open Folder
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void onOpenManager("chrome")}
            >
              Open Extensions
            </Button>
          </>
        ) : null}
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

      {buildPath || packagePath || appPath ? (
        <div className="space-y-1 text-xs text-muted">
          {buildPath ? (
            <div className="flex items-center gap-2">
              <span className="font-semibold text-txt">Build:</span>
              <span className="min-w-0 truncate font-mono">{buildPath}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void onOpenTarget(
                    browser === "chrome"
                      ? "chrome_build"
                      : "safari_web_extension",
                    true,
                  )
                }
              >
                Open Folder
              </Button>
            </div>
          ) : null}
          {packagePath ? (
            <div className="flex items-center gap-2">
              <span className="font-semibold text-txt">Pkg:</span>
              <span className="min-w-0 truncate font-mono">{packagePath}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void onOpenTarget(
                    browser === "chrome" ? "chrome_package" : "safari_package",
                    true,
                  )
                }
              >
                Reveal Zip
              </Button>
            </div>
          ) : null}
          {appPath ? (
            <div className="flex items-center gap-2">
              <span className="font-semibold text-txt">App:</span>
              <span className="min-w-0 truncate font-mono">{appPath}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void onOpenTarget("safari_app")}
              >
                Open
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void onOpenTarget("safari_app", true)}
              >
                <FolderOpen className="mr-1.5 h-3 w-3" />
                Show in Folder
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function LifeOpsBrowserSetupPanel() {
  const { setActionNotice, setTab } = useApp();
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const draftRef = useRef<SettingsDraft | null>(null);
  const draftDirtyRef = useRef(false);
  const [companions, setCompanions] = useState<
    Awaited<
      ReturnType<typeof client.listLifeOpsBrowserCompanions>
    >["companions"]
  >([]);
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

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    draftDirtyRef.current = draftDirty;
  }, [draftDirty]);

  const refresh = useCallback(async (options?: { preserveDraft?: boolean }) => {
    setLoading(true);
    setError(null);
    const [settingsResult, companionsResult, statusResult] =
      await Promise.allSettled([
        client.getLifeOpsBrowserSettings(),
        client.listLifeOpsBrowserCompanions(),
        client.getLifeOpsBrowserPackageStatus(),
      ]);
    const errors: string[] = [];

    if (settingsResult.status === "fulfilled") {
      if (
        !options?.preserveDraft ||
        !draftDirtyRef.current ||
        !draftRef.current
      ) {
        setDraft(settingsToDraft(settingsResult.value.settings));
        setDraftDirty(false);
      }
    } else {
      errors.push(
        settingsResult.reason instanceof Error
          ? settingsResult.reason.message
          : String(settingsResult.reason),
      );
    }

    if (companionsResult.status === "fulfilled") {
      setCompanions(companionsResult.value.companions);
    } else {
      errors.push(
        companionsResult.reason instanceof Error
          ? companionsResult.reason.message
          : String(companionsResult.reason),
      );
    }

    if (statusResult.status === "fulfilled") {
      setPackageStatus((current) =>
        mergePackageStatus(current, statusResult.value.status),
      );
    } else {
      errors.push(
        statusResult.reason instanceof Error
          ? statusResult.reason.message
          : String(statusResult.reason),
      );
    }

    if (errors.length > 0) {
      setError(errors[0]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh({ preserveDraft: true });
    }, CONNECTION_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
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

  const connectedCompanions = useMemo(
    () =>
      companions.filter(
        (companion) => companion.connectionState === "connected",
      ),
    [companions],
  );

  const primaryCompanion = connectedCompanions[0] ?? companions[0] ?? null;

  const connectionSummary = useMemo(() => {
    const trackingEnabled = draft ? draft.trackingMode !== "off" : false;
    const paused = draft
      ? isFutureLocalDateTimeValue(draft.pauseUntilLocal)
      : false;
    const browserReady =
      Boolean(draft?.enabled) &&
      trackingEnabled &&
      connectedCompanions.length > 0;
    const controlEnabled = Boolean(draft?.allowBrowserControl);

    if (!draft) {
      return {
        badge: "Loading",
        badgeVariant: "outline" as const,
        title: "Loading browser connection",
        detail: "Checking whether Your Browser is connected to LifeOps.",
        steps: [] as string[],
      };
    }

    if (paused) {
      return {
        badge: "Paused",
        badgeVariant: "outline" as const,
        title: "Browser access is paused",
        detail:
          "LifeOps is paired to browsers, but tracking is paused right now, so owner-side connectors cannot see live tabs.",
        steps: [
          "Clear Pause until or wait for it to expire.",
          "Keep Tracking on if you want connector status to stay current.",
        ],
      };
    }

    if (browserReady && controlEnabled) {
      return {
        badge: "Connected",
        badgeVariant: "default" as const,
        title: "Your Browser is connected",
        detail:
          connectedCompanions.length === 1
            ? "LifeOps can read and control the connected browser profile."
            : `LifeOps can use ${connectedCompanions.length} connected browser profiles.`,
        steps: [
          "Open Discord, Gmail, or any owner-side app in the connected browser profile.",
          "Use connector cards below to verify that LifeOps can see the page you expect.",
        ],
      };
    }

    if (browserReady && !controlEnabled) {
      return {
        badge: "Attention",
        badgeVariant: "secondary" as const,
        title: "Your Browser is connected, but control is off",
        detail:
          "LifeOps can read the browser state, but it cannot open Discord, switch tabs, or navigate for you until Browser control is enabled.",
        steps: [
          "Turn on Browser control if you want LifeOps to open or focus sites for you.",
          "Leave Browser control off only if you are okay opening the target tabs yourself.",
        ],
      };
    }

    if (!draft.enabled || !trackingEnabled) {
      return {
        badge: "Off",
        badgeVariant: "outline" as const,
        title: "Browser access is turned off",
        detail:
          "LifeOps is not currently tracking Your Browser, so extension pairing alone is not enough.",
        steps: [
          "Turn on Enabled and set Tracking to Current tab or Active tabs.",
          "Then open the extension popup in the browser profile you want LifeOps to use.",
        ],
      };
    }

    if (companions.length === 0) {
      return {
        badge: "Setup",
        badgeVariant: "secondary" as const,
        title: "No browser is connected yet",
        detail:
          "Install the extension in the exact browser profile where you are logged into your real accounts, then open the popup once to auto-connect.",
        steps: [
          "Install Chrome or Safari extension from the card on the right.",
          "Open LifeOps in that same browser profile.",
          "Open the extension popup once so it can auto-connect.",
        ],
      };
    }

    return {
      badge: "Waiting",
      badgeVariant: "secondary" as const,
      title: "A browser was paired before, but it is not connected right now",
      detail:
        "Reopen the extension popup in the correct browser profile and let it sync again.",
      steps: [
        "Make sure the popup points at the live LifeOps app origin.",
        "Use the same browser profile that contains your logged-in accounts.",
      ],
    };
  }, [companions.length, connectedCompanions.length, draft]);

  const updateDraft = <K extends keyof SettingsDraft>(
    key: K,
    value: SettingsDraft[K],
  ) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setDraftDirty(true);
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
      setDraftDirty(false);
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
          `Created a manual ${browser} pairing payload. Use it only if the extension cannot auto-pair itself.`,
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
      setStatusMessage(
        `Copied manual ${browser} pairing JSON to the clipboard.`,
      );
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

  const resolvePackageTargetPath = useCallback(
    (target: LifeOpsBrowserPackagePathTarget): string | null => {
      switch (target) {
        case "extension_root":
          return packageStatus?.extensionPath ?? null;
        case "chrome_build":
          return packageStatus?.chromeBuildPath ?? null;
        case "chrome_package":
          return packageStatus?.chromePackagePath ?? null;
        case "safari_web_extension":
          return packageStatus?.safariWebExtensionPath ?? null;
        case "safari_app":
          return packageStatus?.safariAppPath ?? null;
        case "safari_package":
          return packageStatus?.safariPackagePath ?? null;
        default:
          return null;
      }
    },
    [packageStatus],
  );

  const openPackageTarget = async (
    target: LifeOpsBrowserPackagePathTarget,
    revealOnly = false,
    options?: { silent?: boolean },
  ): Promise<{ path: string | null; opened: boolean }> => {
    try {
      const knownPath = resolvePackageTargetPath(target);
      if (isElectrobunRuntime()) {
        if (!knownPath) {
          throw new Error("The requested extension path is not available yet");
        }
        await openDesktopPath(knownPath, revealOnly);
        if (!options?.silent) {
          setStatusMessage(
            revealOnly
              ? "Revealed the local LifeOps Browser path."
              : "Opened the local LifeOps Browser path.",
          );
        }
        setError(null);
        return { path: knownPath, opened: true };
      }
      const response = await client.openLifeOpsBrowserCompanionPackagePath({
        target,
        revealOnly,
      });
      if (!options?.silent) {
        setStatusMessage(
          revealOnly
            ? "Revealed the local LifeOps Browser path."
            : "Opened the local LifeOps Browser path.",
        );
      }
      setError(null);
      return { path: response.path, opened: true };
    } catch (cause) {
      const fallbackPath = resolvePackageTargetPath(target);
      if (fallbackPath) {
        await copyTextToClipboard(fallbackPath);
        if (!options?.silent) {
          setStatusMessage(
            "Copied the local LifeOps Browser path to the clipboard.",
          );
        }
        setError(null);
        return { path: fallbackPath, opened: false };
      }
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  };

  const openBrowserManager = async (
    browser: LifeOpsBrowserKind,
    options?: { silent?: boolean },
  ): Promise<boolean> => {
    try {
      await client.openLifeOpsBrowserCompanionManager(browser);
      if (!options?.silent) {
        setStatusMessage(
          browser === "chrome"
            ? "Asked Chrome to open chrome://extensions."
            : "Opened the browser manager.",
        );
      }
      setError(null);
      return true;
    } catch (cause) {
      if (browser === "chrome") {
        await copyTextToClipboard(CHROME_EXTENSIONS_URL);
        if (!options?.silent) {
          setStatusMessage("Copied chrome://extensions/ to the clipboard.");
        }
        setError(null);
        return false;
      }
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
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

      const needsBuild =
        browser === "chrome"
          ? !packageStatus?.chromeBuildPath
          : isElectrobunRuntime()
            ? !packageStatus?.safariAppPath
            : !packageStatus?.safariPackagePath;
      const hasLocalWorkspace = Boolean(packageStatus?.extensionPath);

      const nextStatus =
        hasLocalWorkspace && needsBuild
          ? await buildPackage(browser, { silent: true })
          : packageStatus;

      if (hasLocalWorkspace) {
        if (browser === "chrome") {
          if (!nextStatus?.chromeBuildPath) {
            throw new Error("Chrome build folder is not available");
          }
          const folderResult = await openPackageTarget("chrome_build", true, {
            silent: true,
          });
          const managerOpened = await openBrowserManager("chrome", {
            silent: true,
          });
          setStatusMessage(
            managerOpened
              ? folderResult.opened
                ? "Chrome install is prepared. We revealed the built LifeOps extension folder and asked Chrome to open its extensions page. Click Load unpacked and choose that folder, then open the popup once to auto-pair."
                : "Chrome install is prepared. We asked Chrome to open its extensions page and copied the build folder path. Click Load unpacked, choose that folder, then open the popup once to auto-pair."
              : folderResult.opened
                ? "Chrome build folder is ready. In Chrome, open chrome://extensions, click Load unpacked, and choose the revealed LifeOps extension folder."
                : "Chrome install still needs one manual step. We copied both the build folder path and chrome://extensions/, so you can load the unpacked LifeOps extension manually.",
          );
          return;
        }

        if (nextStatus?.safariAppPath) {
          await openPackageTarget("safari_app", false, { silent: true });
          setStatusMessage(
            "Safari install is prepared. We opened the LifeOps Browser app bundle. Run it once, enable the Safari extension, then open the popup once to auto-pair.",
          );
          return;
        }

        if (nextStatus?.safariPackagePath) {
          await openPackageTarget("safari_package", true, { silent: true });
          setStatusMessage(
            "Safari install is prepared. We revealed the packaged LifeOps Browser Safari build. Install it, enable the Safari extension, then open the popup once to auto-pair.",
          );
          return;
        }
      }

      if (releaseTarget?.installUrl) {
        await openExternalUrl(releaseTarget.installUrl);
        setStatusMessage(
          releaseTarget.installKind === "chrome_web_store"
            ? "Chrome install is prepared. We opened the Chrome Web Store listing. After install, open the extension popup in the same browser profile and it should auto-pair itself."
            : releaseTarget.installKind === "apple_app_store"
              ? "Safari install is prepared. We opened the App Store listing. Install the app, enable the Safari extension, then open its popup once so it can auto-pair."
              : `${browser === "chrome" ? "Chrome" : "Safari"} install is prepared. We opened the release download. After install, open the extension popup in the same browser profile and it should auto-pair itself.`,
        );
        return;
      }

      await downloadPackage(browser, { silent: true });
      setStatusMessage(
        `${browser === "chrome" ? "Chrome" : "Safari"} package downloaded. Install it manually, then open the extension popup once so it can auto-pair.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInstallingBrowser(null);
    }
  };

  const openDesktopBrowser = async () => {
    try {
      await client.openBrowserWorkspaceTab({
        url: "about:blank",
        title: "Browser",
        show: true,
      });
      setTab("browser");
      setActionNotice("Opened Milady Desktop Browser.", "success", 3000);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-2 text-muted">
          <ShieldCheck className="mt-0.5 h-4 w-4" />
          <div>
            <div className="text-sm font-semibold text-txt">Your Browser</div>
            <div className="text-xs text-muted">
              Connect a real Chrome or Safari profile, or use Milady Desktop
              Browser when you want built-in browser access.
            </div>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8 rounded-xl px-3 text-xs font-semibold"
          disabled={loading}
          onClick={() => void refresh({ preserveDraft: true })}
        >
          <RefreshCw className="mr-1.5 h-3 w-3" />
          Refresh
        </Button>
      </div>
      {statusMessage ? (
        <div className="rounded-2xl bg-card/22 px-3 py-2 text-xs text-txt">
          {statusMessage}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-2xl bg-danger/10 px-3 py-1.5 text-xs text-danger">
          {error}
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <div className="space-y-4">
          <div className="rounded-3xl border border-border/18 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_94%,transparent),color-mix(in_srgb,var(--bg)_98%,transparent))] px-5 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="text-sm font-semibold text-txt">
                  {connectionSummary.title}
                </div>
                <div className="max-w-xl text-xs leading-relaxed text-muted">
                  {connectionSummary.detail}
                </div>
              </div>
              <Badge variant={connectionSummary.badgeVariant}>
                {connectionSummary.badge}
              </Badge>
            </div>

            {connectionSummary.steps.length > 0 ? (
              <div className="mt-4 grid gap-2">
                {connectionSummary.steps.map((step) => (
                  <div
                    key={step}
                    className="rounded-2xl bg-card/20 px-3 py-2 text-xs text-muted"
                  >
                    {step}
                  </div>
                ))}
              </div>
            ) : null}

            {primaryCompanion ? (
              <div className="mt-4 rounded-2xl bg-card/20 px-3 py-2 text-xs text-muted">
                Primary browser:{" "}
                <span className="font-semibold text-txt">
                  {primaryCompanion.browser === "safari" ? "Safari" : "Chrome"}{" "}
                  / {primaryCompanion.profileLabel}
                </span>
                {" • "}
                {permissionSummary(primaryCompanion.permissions)}
              </div>
            ) : null}

            {isElectrobunRuntime() ? (
              <div className="mt-4">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 rounded-xl px-3 text-xs font-semibold"
                  onClick={() => void openDesktopBrowser()}
                >
                  <Monitor className="mr-1.5 h-3 w-3" />
                  Open Milady Desktop Browser
                </Button>
              </div>
            ) : null}
          </div>

          <div className="space-y-2">
            <div className="text-sm font-semibold text-txt">
              Connected Browsers
            </div>
            {companions.length > 0 ? (
              <div className="grid gap-2">
                {companions.map((companion) => (
                  <div
                    key={companion.id}
                    className="rounded-2xl bg-card/16 px-3 py-3 text-xs"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="text-2xs">
                        {companion.browser}/{companion.profileLabel}
                      </Badge>
                      <Badge variant="secondary" className="text-2xs">
                        {companion.connectionState}
                      </Badge>
                      <span className="text-muted">
                        {formatTimestamp(companion.lastSeenAt) ?? "Never seen"}
                      </span>
                    </div>
                    <div className="mt-1 text-muted">
                      {permissionSummary(companion.permissions)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl bg-card/14 px-3 py-3 text-xs text-muted">
                No browser profiles have connected yet. After installing the
                extension, open its popup once in the browser profile you want
                LifeOps to use.
              </div>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <div className="text-sm font-semibold text-txt">
            Connect a Browser
          </div>
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
            onOpenTarget={openPackageTarget}
            onOpenManager={openBrowserManager}
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
            onOpenTarget={openPackageTarget}
            onOpenManager={openBrowserManager}
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
                <div className="text-[11px] text-muted">
                  Manual fallback only. Automatic pairing should work as soon as
                  the extension popup can see this app in the same browser
                  profile.
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <details className="rounded-3xl border border-border/18 bg-card/12 px-5 py-4">
        <summary className="cursor-pointer list-none text-sm font-semibold text-txt">
          Advanced Browser Rules
        </summary>
        <div className="mt-4 space-y-4">
          {draft ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-muted">
                  These settings control what LifeOps is allowed to see or
                  automate in Your Browser.
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 rounded-xl px-3 text-xs font-semibold"
                  disabled={savingSettings || loading}
                  onClick={() => void saveSettings()}
                >
                  {savingSettings ? "Saving..." : "Save"}
                </Button>
              </div>

              <div className="divide-y divide-border/18">
                <BrowserSettingRow
                  checked={draft.enabled}
                  hint="Master switch for owner-side browser visibility."
                  label="Enabled"
                  onCheckedChange={(checked) => updateDraft("enabled", checked)}
                />
                <BrowserSettingRow
                  checked={draft.allowBrowserControl}
                  hint="Required if LifeOps should open Discord, switch tabs, or navigate for you."
                  label="Browser control"
                  onCheckedChange={(checked) =>
                    updateDraft("allowBrowserControl", checked)
                  }
                />
                <BrowserSettingRow
                  checked={draft.requireConfirmationForAccountAffecting}
                  hint="Ask before actions that could change accounts or submit data."
                  label="Require confirmation"
                  onCheckedChange={(checked) =>
                    updateDraft(
                      "requireConfirmationForAccountAffecting",
                      checked,
                    )
                  }
                />
                <BrowserSettingRow
                  checked={draft.incognitoEnabled}
                  hint="Include incognito windows when the browser has granted that permission."
                  label="Incognito"
                  onCheckedChange={(checked) =>
                    updateDraft("incognitoEnabled", checked)
                  }
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted">Tracking</Label>
                  <div className="text-[11px] text-muted">
                    Choose whether LifeOps sees only the current tab or multiple
                    active tabs.
                  </div>
                  <SegmentedControl<LifeOpsBrowserTrackingMode>
                    value={draft.trackingMode}
                    onValueChange={(mode) => updateDraft("trackingMode", mode)}
                    items={(["off", "current_tab", "active_tabs"] as const).map(
                      (mode) => ({
                        value: mode,
                        label: trackingModeLabel(mode),
                      }),
                    )}
                    className="w-full max-w-full border-border/28 bg-transparent p-0.5"
                    buttonClassName="min-h-8 flex-1 justify-center px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted">Site access</Label>
                  <div className="text-[11px] text-muted">
                    Restrict LifeOps to the current site, an allow-list, or all
                    sites.
                  </div>
                  <SegmentedControl<LifeOpsBrowserSiteAccessMode>
                    value={draft.siteAccessMode}
                    onValueChange={(mode) =>
                      updateDraft("siteAccessMode", mode)
                    }
                    items={LIFEOPS_BROWSER_SITE_ACCESS_MODES.map((mode) => ({
                      value: mode,
                      label: siteAccessModeLabel(mode),
                    }))}
                    className="w-full max-w-full border-border/28 bg-transparent p-0.5"
                    buttonClassName="min-h-8 flex-1 justify-center px-2.5 py-1.5 text-xs"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label
                    htmlFor="lifeops-browser-max-tabs"
                    className="text-xs text-muted"
                  >
                    Max remembered tabs
                  </Label>
                  <div className="text-[11px] text-muted">
                    Controls how much recent browser context LifeOps keeps
                    around.
                  </div>
                  <Input
                    id="lifeops-browser-max-tabs"
                    value={draft.maxRememberedTabs}
                    onChange={(event) =>
                      updateDraft(
                        "maxRememberedTabs",
                        event.currentTarget.value,
                      )
                    }
                    inputMode="numeric"
                  />
                </div>
                <div className="space-y-1">
                  <Label
                    htmlFor="lifeops-browser-pause-until"
                    className="text-xs text-muted"
                  >
                    Pause until
                  </Label>
                  <div className="text-[11px] text-muted">
                    Temporarily stop browser visibility without disconnecting
                    your paired browser.
                  </div>
                  <div className="flex flex-wrap gap-1.5 sm:flex-nowrap">
                    <Input
                      id="lifeops-browser-pause-until"
                      type="datetime-local"
                      value={draft.pauseUntilLocal}
                      onChange={(event) =>
                        updateDraft(
                          "pauseUntilLocal",
                          event.currentTarget.value,
                        )
                      }
                      className="min-w-0 flex-1"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-9 rounded-xl px-3 text-xs font-semibold"
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
                      className="h-9 rounded-xl px-3 text-xs font-semibold"
                      onClick={() => updateDraft("pauseUntilLocal", "")}
                    >
                      Now
                    </Button>
                  </div>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label
                    htmlFor="lifeops-browser-granted-origins"
                    className="text-xs text-muted"
                  >
                    Granted origins
                  </Label>
                  <div className="text-[11px] text-muted">
                    When Site access is set to Granted sites, only these origins
                    are readable.
                  </div>
                  <Textarea
                    id="lifeops-browser-granted-origins"
                    rows={3}
                    placeholder="https://mail.google.com"
                    value={draft.grantedOriginsText}
                    onChange={(event) =>
                      updateDraft(
                        "grantedOriginsText",
                        event.currentTarget.value,
                      )
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label
                    htmlFor="lifeops-browser-blocked-origins"
                    className="text-xs text-muted"
                  >
                    Blocked origins
                  </Label>
                  <div className="text-[11px] text-muted">
                    These origins are never readable, even if broader site
                    access is enabled.
                  </div>
                  <Textarea
                    id="lifeops-browser-blocked-origins"
                    rows={3}
                    placeholder="https://bank.example.com"
                    value={draft.blockedOriginsText}
                    onChange={(event) =>
                      updateDraft(
                        "blockedOriginsText",
                        event.currentTarget.value,
                      )
                    }
                  />
                </div>
              </div>
            </>
          ) : loading ? (
            <div className="text-xs text-muted">Loading</div>
          ) : null}
        </div>
      </details>
    </div>
  );
}
