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
  navigatePreOpenedWindow,
  openExternalUrl,
  preOpenWindow,
  SegmentedControl,
  Switch,
  Textarea,
  useApp,
} from "@elizaos/app-core";
import {
  CheckCircle2,
  Circle,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  Monitor,
  Package,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BROWSER_BRIDGE_SITE_ACCESS_MODES,
  type BrowserBridgeCompanionPairingResponse,
  type BrowserBridgeCompanionReleaseManifest,
  type BrowserBridgeKind,
  type BrowserBridgePackagePathTarget,
  type BrowserBridgeSettings,
  type BrowserBridgeSiteAccessMode,
  type BrowserBridgeTrackingMode,
  type CreateBrowserBridgeCompanionPairingRequest,
  type UpdateBrowserBridgeSettingsRequest,
} from "../contracts/index.js";
import { resolveBrowserBridgeApiBaseUrl } from "../utils/lifeops-url.js";

type SettingsDraft = {
  enabled: boolean;
  trackingMode: BrowserBridgeTrackingMode;
  allowBrowserControl: boolean;
  requireConfirmationForAccountAffecting: boolean;
  incognitoEnabled: boolean;
  siteAccessMode: BrowserBridgeSiteAccessMode;
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
const BROWSER_SETUP_HASH = "lifeops.section=setup";

function isIosRuntime(): boolean {
  if (
    typeof navigator !== "undefined" &&
    /iPad|iPhone|iPod/.test(navigator.userAgent)
  ) {
    return true;
  }
  const capacitor = (
    globalThis as { Capacitor?: { getPlatform?: () => string } }
  ).Capacitor;
  return capacitor?.getPlatform?.() === "ios";
}

function detectRuntimeBrowserKind(): BrowserBridgeKind | null {
  if (typeof navigator === "undefined") {
    return null;
  }
  const userAgent = navigator.userAgent.toLowerCase();
  const vendor = navigator.vendor?.toLowerCase() ?? "";
  const chromeFamily =
    userAgent.includes("chrome") ||
    userAgent.includes("chromium") ||
    userAgent.includes("crios") ||
    userAgent.includes("edg/") ||
    userAgent.includes("brave");
  if (chromeFamily) {
    return "chrome";
  }
  if (vendor.includes("apple") && userAgent.includes("safari")) {
    return "safari";
  }
  return null;
}

function settingsToDraft(settings: BrowserBridgeSettings): SettingsDraft {
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

function settingsRequestFromDraft(
  draft: SettingsDraft,
): UpdateBrowserBridgeSettingsRequest {
  return {
    enabled: draft.enabled,
    trackingMode: draft.trackingMode,
    allowBrowserControl: draft.allowBrowserControl,
    requireConfirmationForAccountAffecting:
      draft.requireConfirmationForAccountAffecting,
    incognitoEnabled: draft.incognitoEnabled,
    siteAccessMode: draft.siteAccessMode,
    grantedOrigins: parseOriginLines(draft.grantedOriginsText),
    blockedOrigins: parseOriginLines(draft.blockedOriginsText),
    maxRememberedTabs: Math.max(
      1,
      Number.parseInt(draft.maxRememberedTabs, 10) || 10,
    ),
    pauseUntil: parseDateTimeLocalValue(draft.pauseUntilLocal),
  };
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
  browser: BrowserBridgeKind,
  existing: {
    profileId?: string;
    profileLabel?: string;
    label?: string;
  } | null,
): CreateBrowserBridgeCompanionPairingRequest {
  return {
    browser,
    profileId: existing?.profileId || DEFAULT_PAIRING_PROFILE.profileId,
    profileLabel:
      existing?.profileLabel || DEFAULT_PAIRING_PROFILE.profileLabel,
    label:
      existing?.label ||
      `Agent Browser Bridge ${browser} ${existing?.profileLabel || DEFAULT_PAIRING_PROFILE.profileLabel}`,
  };
}

function pairingPayload(
  response: BrowserBridgeCompanionPairingResponse,
): Record<string, string> {
  return {
    apiBaseUrl: resolveBrowserBridgeApiBaseUrl(),
    companionId: response.companion.id,
    pairingToken: response.pairingToken,
    pairingTokenExpiresAt: response.pairingTokenExpiresAt ?? "",
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
    releaseManifest?: BrowserBridgeCompanionReleaseManifest | null;
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
  browser: BrowserBridgeKind,
  releaseManifest: BrowserBridgeCompanionReleaseManifest | null | undefined,
) {
  if (!releaseManifest) {
    return null;
  }
  return browser === "chrome" ? releaseManifest.chrome : releaseManifest.safari;
}

function installButtonLabel(
  browser: BrowserBridgeKind,
  releaseManifest: BrowserBridgeCompanionReleaseManifest | null | undefined,
  options: {
    hasLocalArtifact: boolean;
    localWorkspaceAvailable: boolean;
  },
): string {
  const { hasLocalArtifact, localWorkspaceAvailable } = options;
  if (localWorkspaceAvailable) {
    if (!hasLocalArtifact) {
      return `Build & Install in ${browser === "chrome" ? "Chrome" : "Safari"}`;
    }
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

function trackingModeLabel(mode: BrowserBridgeTrackingMode): string {
  switch (mode) {
    case "current_tab":
      return "Current tab";
    case "active_tabs":
      return "Active tabs";
    default:
      return "Off";
  }
}

function siteAccessModeLabel(mode: BrowserBridgeSiteAccessMode): string {
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
  browser: BrowserBridgeKind,
  releaseManifest: BrowserBridgeCompanionReleaseManifest | null | undefined,
  localWorkspaceAvailable: boolean,
): string | null {
  if (localWorkspaceAvailable) {
    return "Local build";
  }
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

function buildStateBadgeLabel(
  hasLocalArtifact: boolean,
  localWorkspaceAvailable: boolean,
): string {
  if (hasLocalArtifact) {
    return "Built";
  }
  if (localWorkspaceAvailable) {
    return "Build on install";
  }
  return "Download";
}

function BridgeDot({
  label,
  tone,
}: {
  label: string;
  tone: "ok" | "warning" | "muted";
}) {
  const className =
    tone === "ok"
      ? "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.14)]"
      : tone === "warning"
        ? "bg-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.14)]"
        : "bg-muted/45";
  return (
    <span
      aria-label={label}
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${className}`}
      role="img"
      title={label}
    />
  );
}

function BridgeMeter({
  connected,
  total,
}: {
  connected: number;
  total: number;
}) {
  const safeTotal = Math.max(total, 0);
  const width =
    safeTotal > 0
      ? `${(Math.min(Math.max(connected, 0), safeTotal) / safeTotal) * 100}%`
      : "0%";
  return (
    <span
      aria-label={`${connected}/${total} browser profiles connected`}
      className="inline-flex h-1.5 w-16 overflow-hidden rounded-full bg-bg/70"
      role="img"
      title={`${connected}/${total} browser profiles connected`}
    >
      <span className="h-full rounded-full bg-emerald-500" style={{ width }} />
    </span>
  );
}

function installHint(
  browser: BrowserBridgeKind,
  currentBrowser: BrowserBridgeKind | null,
  localWorkspaceAvailable: boolean,
  releaseManifest: BrowserBridgeCompanionReleaseManifest | null | undefined,
): string {
  if (localWorkspaceAvailable) {
    if (browser === "chrome") {
      return currentBrowser === "chrome"
        ? "Install builds the extension, opens chrome://extensions in this browser profile when possible, and reveals the folder for Load unpacked."
        : "Install builds the extension, opens Chrome extensions, and reveals the folder you need for Load unpacked.";
    }
    return "Install builds the Safari helper app and opens it so you can enable the extension once.";
  }

  const target = releaseTargetForBrowser(browser, releaseManifest);
  if (target?.installKind === "chrome_web_store") {
    return "Use the published Chrome Web Store build, then open the popup once in the profile you want LifeOps to use.";
  }
  if (target?.installKind === "apple_app_store") {
    return "Use the published Safari App Store build, then enable the extension and open its popup once.";
  }
  return "Download the published browser companion, install it, then open the popup once to auto-connect.";
}

type GuidedSetupStepStatus = "done" | "current" | "pending" | "attention";

interface GuidedSetupStep {
  id: string;
  title: string;
  detail: string;
  status: GuidedSetupStepStatus;
}

function statusLabel(status: GuidedSetupStepStatus): string {
  switch (status) {
    case "done":
      return "Done";
    case "current":
      return "Next";
    case "attention":
      return "Check";
    default:
      return "Pending";
  }
}

function recommendedBrowserKind(
  currentBrowser: BrowserBridgeKind | null,
): BrowserBridgeKind {
  return currentBrowser ?? "chrome";
}

function browserLabel(browser: BrowserBridgeKind): string {
  return browser === "safari" ? "Safari" : "Chrome";
}

function browserSettingsReady(draft: SettingsDraft | null): boolean {
  return Boolean(
    draft?.enabled &&
      draft.trackingMode !== "off" &&
      draft.allowBrowserControl &&
      !isFutureLocalDateTimeValue(draft.pauseUntilLocal),
  );
}

function buildSetupUrl(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const url = new URL(window.location.href);
    url.hash = BROWSER_SETUP_HASH;
    return url.toString();
  } catch {
    return window.location.href || null;
  }
}

function hasBrowserArtifact(
  browser: BrowserBridgeKind,
  status: ExtensionStatus | null,
): boolean {
  if (!status) {
    return false;
  }
  return browser === "chrome"
    ? Boolean(status.chromeBuildPath || status.chromePackagePath)
    : Boolean(
        status.safariAppPath ||
          status.safariPackagePath ||
          status.safariWebExtensionPath,
      );
}

function companionPermissionReady(
  companion:
    | Awaited<
        ReturnType<typeof client.listBrowserBridgeCompanions>
      >["companions"][number]
    | null,
): boolean {
  if (!companion?.permissions) {
    return false;
  }
  return (
    companion.permissions.tabs &&
    companion.permissions.scripting &&
    companion.permissions.activeTab &&
    companion.permissions.allOrigins
  );
}

function BrowserCompanionRow({
  currentBrowser,
  browser,
  buildPath,
  packagePath,
  appPath,
  localWorkspaceAvailable,
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
  currentBrowser: BrowserBridgeKind | null;
  browser: BrowserBridgeKind;
  buildPath: string | null | undefined;
  packagePath: string | null | undefined;
  appPath?: string | null | undefined;
  localWorkspaceAvailable: boolean;
  releaseManifest?: BrowserBridgeCompanionReleaseManifest | null;
  busy: boolean;
  pairing: BrowserBridgeCompanionPairingResponse | null;
  onInstall: (browser: BrowserBridgeKind) => Promise<void>;
  onBuild: (browser: BrowserBridgeKind) => Promise<unknown>;
  onCreatePairing: (browser: BrowserBridgeKind) => Promise<unknown>;
  onCopyPairing: (browser: BrowserBridgeKind) => Promise<void>;
  onDownload: (browser: BrowserBridgeKind) => Promise<unknown>;
  onOpenTarget: (
    target: BrowserBridgePackagePathTarget,
    revealOnly?: boolean,
    options?: { silent?: boolean },
  ) => Promise<{ path: string | null; opened: boolean }>;
  onOpenManager: (
    browser: BrowserBridgeKind,
    options?: { silent?: boolean },
  ) => Promise<boolean>;
}) {
  const browserLabel = browser === "chrome" ? "Chrome" : "Safari";
  const distributionLabel = releaseBadgeLabel(
    browser,
    releaseManifest,
    localWorkspaceAvailable,
  );
  const hasLocalArtifact = Boolean(buildPath || packagePath || appPath);
  const installLabel = installButtonLabel(browser, releaseManifest, {
    hasLocalArtifact,
    localWorkspaceAvailable,
  });
  const buildBadgeLabel = buildStateBadgeLabel(
    hasLocalArtifact,
    localWorkspaceAvailable,
  );
  const rowHint = installHint(
    browser,
    currentBrowser,
    localWorkspaceAvailable,
    releaseManifest,
  );

  return (
    <div className="space-y-2 rounded-2xl bg-card/16 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{browserLabel}</Badge>
        {currentBrowser === browser ? (
          <Badge variant="secondary" className="text-2xs">
            This Browser
          </Badge>
        ) : null}
        {distributionLabel ? (
          <Badge variant="secondary" className="text-2xs">
            {distributionLabel}
          </Badge>
        ) : null}
        {hasLocalArtifact || localWorkspaceAvailable ? (
          <Badge variant="secondary" className="text-2xs">
            {buildBadgeLabel}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-2xs">
            Download
          </Badge>
        )}
      </div>
      <div className="text-xs leading-relaxed text-muted">{rowHint}</div>
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
          Manual Pairing
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

export function BrowserBridgeSetupPanel() {
  const { setActionNotice, setTab } = useApp();
  const currentBrowser = useMemo(() => detectRuntimeBrowserKind(), []);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const draftRef = useRef<SettingsDraft | null>(null);
  const draftDirtyRef = useRef(false);
  const [companions, setCompanions] = useState<
    Awaited<ReturnType<typeof client.listBrowserBridgeCompanions>>["companions"]
  >([]);
  const [packageStatus, setPackageStatus] = useState<ExtensionStatus | null>(
    null,
  );
  const [pairings, setPairings] = useState<
    Partial<Record<BrowserBridgeKind, BrowserBridgeCompanionPairingResponse>>
  >({});
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [buildingBrowser, setBuildingBrowser] =
    useState<BrowserBridgeKind | null>(null);
  const [pairingBrowser, setPairingBrowser] =
    useState<BrowserBridgeKind | null>(null);
  const [installingBrowser, setInstallingBrowser] =
    useState<BrowserBridgeKind | null>(null);
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
        client.getBrowserBridgeSettings(),
        client.listBrowserBridgeCompanions(),
        client.getBrowserBridgePackageStatus(),
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
    const map = new Map<BrowserBridgeKind, (typeof companions)[number]>();
    for (const companion of companions) {
      if (!map.has(companion.browser)) {
        map.set(companion.browser, companion);
      }
    }
    return map;
  }, [companions]);

  const pairingPayloads = useMemo(() => {
    const payloads: Partial<Record<BrowserBridgeKind, string>> = {};
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
    const iosRuntime = isIosRuntime();
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
        detail: iosRuntime
          ? "Connect a Chrome or Safari companion running on your Mac or cloud browser host. The iPhone app talks to that host; iOS WebKit does not expose real browser-tab automation."
          : "Install the extension in the exact browser profile where you are logged into your real accounts, then open the popup once to auto-connect.",
        steps: iosRuntime
          ? [
              "Make sure this iPhone is connected to the remote Mac or cloud backend that owns the browser companion.",
              "Install and pair the Chrome or Safari companion on that host.",
              "Open the extension popup there once so it can auto-connect.",
            ]
          : [
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
  const connectionTone =
    connectionSummary.badgeVariant === "default"
      ? "ok"
      : connectionSummary.badgeVariant === "secondary"
        ? "warning"
        : "muted";

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
      const response = await client.updateBrowserBridgeSettings(
        settingsRequestFromDraft(draft),
      );
      setDraft(settingsToDraft(response.settings));
      setDraftDirty(false);
      setStatusMessage("Saved Agent Browser Bridge settings.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingSettings(false);
    }
  };

  const enableRecommendedBrowserSettings = async () => {
    if (!draft) {
      return;
    }
    setSavingSettings(true);
    setError(null);
    try {
      const nextDraft: SettingsDraft = {
        ...draft,
        enabled: true,
        trackingMode:
          draft.trackingMode === "off" ? "current_tab" : draft.trackingMode,
        allowBrowserControl: true,
        requireConfirmationForAccountAffecting: true,
        pauseUntilLocal: "",
      };
      const response = await client.updateBrowserBridgeSettings(
        settingsRequestFromDraft(nextDraft),
      );
      setDraft(settingsToDraft(response.settings));
      setDraftDirty(false);
      setStatusMessage(
        "Browser access is enabled. Next, install the extension in the profile that has your real accounts.",
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setSavingSettings(false);
    }
  };

  const buildPackage = async (
    browser: BrowserBridgeKind,
    options?: { silent?: boolean },
  ): Promise<ExtensionStatus> => {
    setBuildingBrowser(browser);
    setError(null);
    if (!options?.silent) {
      setStatusMessage(
        `Building ${browser === "chrome" ? "Chrome" : "Safari"} companion…`,
      );
    }
    try {
      const response = await client.buildBrowserBridgeCompanionPackage(browser);
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
    browser: BrowserBridgeKind,
    options?: { silent?: boolean },
  ): Promise<BrowserBridgeCompanionPairingResponse> => {
    setPairingBrowser(browser);
    setError(null);
    try {
      const response = await client.createBrowserBridgeCompanionPairing(
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

  const copyPairing = async (browser: BrowserBridgeKind) => {
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
    browser: BrowserBridgeKind,
    options?: { silent?: boolean },
  ) => {
    try {
      setError(null);
      const download =
        await client.downloadBrowserBridgeCompanionPackage(browser);
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
    (target: BrowserBridgePackagePathTarget): string | null => {
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
    target: BrowserBridgePackagePathTarget,
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
              ? "Revealed the local Agent Browser Bridge path."
              : "Opened the local Agent Browser Bridge path.",
          );
        }
        setError(null);
        return { path: knownPath, opened: true };
      }
      const response = await client.openBrowserBridgeCompanionPackagePath({
        target,
        revealOnly,
      });
      if (!options?.silent) {
        setStatusMessage(
          revealOnly
            ? "Revealed the local Agent Browser Bridge path."
            : "Opened the local Agent Browser Bridge path.",
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
            "Copied the local Agent Browser Bridge path to the clipboard.",
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
    browser: BrowserBridgeKind,
    options?: { silent?: boolean },
  ): Promise<boolean> => {
    if (browser === "safari") {
      if (!options?.silent) {
        setStatusMessage(
          "Safari extension permissions live in Safari > Settings > Extensions. Open the Agent Browser Bridge app once, enable the extension there, then open its popup.",
        );
      }
      setError(null);
      return false;
    }
    try {
      if (
        browser === "chrome" &&
        currentBrowser === "chrome" &&
        !isElectrobunRuntime()
      ) {
        navigatePreOpenedWindow(preOpenWindow(), CHROME_EXTENSIONS_URL);
        if (!options?.silent) {
          setStatusMessage(
            "Opened chrome://extensions/ in this browser profile.",
          );
        }
        setError(null);
        return true;
      }
      await client.openBrowserBridgeCompanionManager(browser);
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

  const installCompanion = async (browser: BrowserBridgeKind) => {
    setInstallingBrowser(browser);
    setError(null);
    setStatusMessage(
      `Preparing ${browser === "chrome" ? "Chrome" : "Safari"} install…`,
    );
    try {
      const releaseTarget = releaseTargetForBrowser(
        browser,
        packageStatus?.releaseManifest,
      );
      const preOpenedChromeManager =
        browser === "chrome" &&
        currentBrowser === "chrome" &&
        !isElectrobunRuntime()
          ? preOpenWindow()
          : null;

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
          let managerOpened: boolean;
          if (preOpenedChromeManager) {
            navigatePreOpenedWindow(
              preOpenedChromeManager,
              CHROME_EXTENSIONS_URL,
            );
            managerOpened = true;
          } else {
            managerOpened = await openBrowserManager("chrome", {
              silent: true,
            });
          }
          setStatusMessage(
            managerOpened
              ? folderResult.opened
                ? currentBrowser === "chrome"
                  ? "Chrome install is prepared in this browser profile. We revealed the built LifeOps extension folder and opened chrome://extensions here. Click Load unpacked, choose that folder, then open the popup once to auto-pair."
                  : "Chrome install is prepared. We revealed the built LifeOps extension folder and asked Chrome to open its extensions page. Click Load unpacked and choose that folder, then open the popup once to auto-pair."
                : currentBrowser === "chrome"
                  ? "Chrome install is prepared in this browser profile. We opened chrome://extensions here and copied the build folder path. Click Load unpacked, choose that folder, then open the popup once to auto-pair."
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
            "Safari install is prepared. We opened the Agent Browser Bridge app bundle. Run it once, enable the Safari extension, then open the popup once to auto-pair.",
          );
          return;
        }

        if (nextStatus?.safariPackagePath) {
          await openPackageTarget("safari_package", true, { silent: true });
          setStatusMessage(
            "Safari install is prepared. We revealed the packaged Agent Browser Bridge Safari build. Install it, enable the Safari extension, then open the popup once to auto-pair.",
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
      setActionNotice("Opened Eliza Desktop Browser.", "success", 3000);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const recommendedBrowser = recommendedBrowserKind(currentBrowser);
  const recommendedBrowserName = browserLabel(recommendedBrowser);
  const recommendedCompanion =
    companionByBrowser.get(recommendedBrowser) ?? primaryCompanion;
  const recommendedConnected =
    recommendedCompanion?.connectionState === "connected";
  const recommendedArtifactReady = hasBrowserArtifact(
    recommendedBrowser,
    packageStatus,
  );
  const settingsReady = browserSettingsReady(draft);
  const browserPermissionReady = companionPermissionReady(
    recommendedConnected ? recommendedCompanion : primaryCompanion,
  );
  const setupBusy =
    loading ||
    savingSettings ||
    buildingBrowser !== null ||
    pairingBrowser !== null ||
    installingBrowser !== null;
  const setupSteps = useMemo<GuidedSetupStep[]>(() => {
    const hasAnyCompanion = companions.length > 0;
    return [
      {
        id: "settings",
        title: "Enable safe browser access",
        detail:
          "LifeOps turns on visibility, keeps account-changing confirmations on, and clears any pause.",
        status: settingsReady ? "done" : "current",
      },
      {
        id: "install",
        title: `Install ${recommendedBrowserName} companion`,
        detail: currentBrowser
          ? `Best path: install into this ${recommendedBrowserName} profile so pairing can happen automatically.`
          : `Best path: install Chrome first, then open this setup page there before loading the extension.`,
        status: !settingsReady
          ? "pending"
          : hasAnyCompanion
            ? "done"
            : recommendedArtifactReady
              ? "current"
              : "current",
      },
      {
        id: "pair",
        title: "Auto-connect the profile",
        detail:
          "After install, keep this LifeOps setup page open and open the extension popup once.",
        status: !hasAnyCompanion
          ? "pending"
          : recommendedConnected
            ? "done"
            : "current",
      },
      {
        id: "permissions",
        title: "Verify extension permissions",
        detail:
          "Tabs, activeTab, DOM scripting, and all-sites access should be available for reliable connector automation.",
        status: recommendedConnected
          ? browserPermissionReady
            ? "done"
            : "attention"
          : "pending",
      },
    ];
  }, [
    browserPermissionReady,
    companions.length,
    currentBrowser,
    recommendedArtifactReady,
    recommendedBrowserName,
    recommendedConnected,
    settingsReady,
  ]);
  const nextSetupStep =
    setupSteps.find((step) => step.status === "current") ??
    setupSteps.find((step) => step.status === "attention") ??
    null;
  const setupComplete = setupSteps.every((step) => step.status === "done");
  const primarySetupLabel = !draft
    ? "Checking Setup"
    : !settingsReady
      ? "Enable Browser Access"
      : connectedCompanions.length === 0
        ? recommendedArtifactReady
          ? `Continue: Open ${recommendedBrowserName} Install`
          : `Continue: Build & Install in ${recommendedBrowserName}`
        : recommendedConnected
          ? browserPermissionReady
            ? "Refresh Browser Status"
            : `Review ${recommendedBrowserName} Permissions`
          : `Reconnect ${recommendedBrowserName}`;

  const continueBrowserSetup = async () => {
    if (!draft || setupBusy) {
      return;
    }
    try {
      if (!settingsReady) {
        await enableRecommendedBrowserSettings();
        return;
      }
      if (connectedCompanions.length === 0) {
        await installCompanion(recommendedBrowser);
        return;
      }
      if (!recommendedConnected) {
        const openedManager = await openBrowserManager(recommendedBrowser, {
          silent: true,
        });
        setStatusMessage(
          openedManager
            ? `Opened ${recommendedBrowserName} extension settings. Enable Agent Browser Bridge if needed, then open its popup once to reconnect.`
            : `${recommendedBrowserName} needs a quick manual check. Enable Agent Browser Bridge in the browser's extension settings, then open its popup once to reconnect.`,
        );
        return;
      }
      if (!browserPermissionReady) {
        const openedManager = await openBrowserManager(recommendedBrowser, {
          silent: true,
        });
        setStatusMessage(
          openedManager
            ? `${recommendedBrowserName} is connected, but extension permissions need a check. In the extension details, allow site access for all sites and enable incognito only if you want LifeOps to see private windows.`
            : `${recommendedBrowserName} is connected, but extension permissions need a check. In Safari, use Safari > Settings > Extensions, enable Agent Browser Bridge, and review website access there.`,
        );
        return;
      }
      await refresh({ preserveDraft: true });
      setStatusMessage("Browser setup looks healthy.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const openSetupPage = async () => {
    const setupUrl = buildSetupUrl();
    if (!setupUrl) {
      return;
    }
    try {
      await openExternalUrl(setupUrl);
      setStatusMessage(
        `Opened this LifeOps setup page in your default browser. Use the ${recommendedBrowserName} profile that contains your real accounts.`,
      );
      setError(null);
    } catch {
      await copyTextToClipboard(setupUrl);
      setStatusMessage(
        "Copied this LifeOps setup page URL. Open it in the browser profile that contains your real accounts.",
      );
      setError(null);
    }
  };

  return (
    <div id="lifeops-browser-setup" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-muted">
          <ShieldCheck className="h-4 w-4" aria-hidden />
          <div className="text-sm font-semibold text-txt">Your Browser</div>
          <BridgeDot label={connectionSummary.badge} tone={connectionTone} />
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 rounded-xl p-0"
            disabled={loading}
            onClick={() => void refresh({ preserveDraft: true })}
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
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

      <div className="rounded-3xl border border-border/18 bg-[radial-gradient(circle_at_top_left,color-mix(in_srgb,var(--card)_82%,transparent),transparent_34%),linear-gradient(135deg,color-mix(in_srgb,var(--bg)_96%,transparent),color-mix(in_srgb,var(--card)_86%,transparent))] px-5 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="text-sm font-semibold text-txt">
              Guided Browser Setup
            </div>
            <div className="max-w-2xl text-xs leading-relaxed text-muted">
              Use this when you want the easy path. LifeOps will enable the
              recommended browser settings, build or open the companion
              installer, and take you to the right browser page for the current
              profile.
            </div>
          </div>
          <Badge variant={setupComplete ? "default" : "secondary"}>
            {setupComplete
              ? "Ready"
              : nextSetupStep
                ? nextSetupStep.title
                : "Checking"}
          </Badge>
        </div>

        <div className="mt-4 grid gap-2 md:grid-cols-2">
          {setupSteps.map((step) => {
            const done = step.status === "done";
            const active =
              step.status === "current" || step.status === "attention";
            return (
              <div
                key={step.id}
                className={`rounded-2xl border px-3 py-3 text-xs ${
                  done
                    ? "border-emerald-500/18 bg-emerald-500/10"
                    : active
                      ? "border-amber-500/24 bg-amber-500/10"
                      : "border-border/14 bg-card/12"
                }`}
              >
                <div className="flex items-center gap-2">
                  {done ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <Circle
                      className={`h-3.5 w-3.5 ${
                        active ? "text-amber-300" : "text-muted"
                      }`}
                    />
                  )}
                  <span className="font-semibold text-txt">{step.title}</span>
                  <span className="ml-auto rounded-full border border-border/18 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                    {statusLabel(step.status)}
                  </span>
                </div>
                <div className="mt-1.5 leading-relaxed text-muted">
                  {step.detail}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            disabled={setupBusy || !draft}
            onClick={() => void continueBrowserSetup()}
          >
            <Sparkles className="mr-1.5 h-3 w-3" />
            {setupBusy ? "Working..." : primarySetupLabel}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            onClick={() => void openSetupPage()}
          >
            <ExternalLink className="mr-1.5 h-3 w-3" />
            Open This Setup Page
          </Button>
          {currentBrowser === "chrome" ? (
            <Button
              size="sm"
              variant="outline"
              className="h-8 rounded-xl px-3 text-xs font-semibold"
              disabled={setupBusy}
              onClick={() => void openBrowserManager("chrome")}
            >
              Open Chrome Extensions
            </Button>
          ) : null}
        </div>
      </div>

      <details className="rounded-2xl border border-border/18 bg-card/12 px-4 py-3">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-txt">
          <span>Browser profiles</span>
          <BridgeMeter
            connected={connectedCompanions.length}
            total={companions.length}
          />
        </summary>

        <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
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
                    {primaryCompanion.browser === "safari"
                      ? "Safari"
                      : "Chrome"}{" "}
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
                    Open Eliza Desktop Browser
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
                          {formatTimestamp(companion.lastSeenAt) ??
                            "Never seen"}
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
              currentBrowser={currentBrowser}
              browser="chrome"
              buildPath={packageStatus?.chromeBuildPath}
              packagePath={packageStatus?.chromePackagePath}
              localWorkspaceAvailable={Boolean(packageStatus?.extensionPath)}
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
              currentBrowser={currentBrowser}
              browser="safari"
              buildPath={packageStatus?.safariWebExtensionPath}
              packagePath={packageStatus?.safariPackagePath}
              appPath={packageStatus?.safariAppPath}
              localWorkspaceAvailable={Boolean(packageStatus?.extensionPath)}
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
                    Manual fallback only. Automatic pairing should work as soon
                    as the extension popup can see this app in the same browser
                    profile.
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <details className="mt-4 rounded-2xl border border-border/18 bg-card/12 px-4 py-3">
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
                    onCheckedChange={(checked) =>
                      updateDraft("enabled", checked)
                    }
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
                      Choose whether LifeOps sees only the current tab or
                      multiple active tabs.
                    </div>
                    <SegmentedControl<BrowserBridgeTrackingMode>
                      value={draft.trackingMode}
                      onValueChange={(mode) =>
                        updateDraft("trackingMode", mode)
                      }
                      items={(
                        ["off", "current_tab", "active_tabs"] as const
                      ).map((mode) => ({
                        value: mode,
                        label: trackingModeLabel(mode),
                      }))}
                      className="w-full max-w-full border-border/28 bg-transparent p-0.5"
                      buttonClassName="min-h-8 flex-1 justify-center px-2.5 py-1.5 text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted">Site access</Label>
                    <div className="text-[11px] text-muted">
                      Restrict LifeOps to the current site, an allow-list, or
                      all sites.
                    </div>
                    <SegmentedControl<BrowserBridgeSiteAccessMode>
                      value={draft.siteAccessMode}
                      onValueChange={(mode) =>
                        updateDraft("siteAccessMode", mode)
                      }
                      items={BROWSER_BRIDGE_SITE_ACCESS_MODES.map((mode) => ({
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
                      htmlFor="browser-bridge-max-tabs"
                      className="text-xs text-muted"
                    >
                      Max remembered tabs
                    </Label>
                    <div className="text-[11px] text-muted">
                      Controls how much recent browser context LifeOps keeps
                      around.
                    </div>
                    <Input
                      id="browser-bridge-max-tabs"
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
                      htmlFor="browser-bridge-pause-until"
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
                        id="browser-bridge-pause-until"
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
                              new Date(
                                Date.now() + 60 * 60 * 1000,
                              ).toISOString(),
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
                      htmlFor="browser-bridge-granted-origins"
                      className="text-xs text-muted"
                    >
                      Granted origins
                    </Label>
                    <div className="text-[11px] text-muted">
                      When Site access is set to Granted sites, only these
                      origins are readable.
                    </div>
                    <Textarea
                      id="browser-bridge-granted-origins"
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
                      htmlFor="browser-bridge-blocked-origins"
                      className="text-xs text-muted"
                    >
                      Blocked origins
                    </Label>
                    <div className="text-[11px] text-muted">
                      These origins are never readable, even if broader site
                      access is enabled.
                    </div>
                    <Textarea
                      id="browser-bridge-blocked-origins"
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
      </details>
    </div>
  );
}
