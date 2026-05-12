import type {
  LifeOpsOwnerBrowserAccessStatus,
  LifeOpsTelegramAuthState,
} from "@elizaos/shared";
import {
  Button,
  client,
  dispatchFocusConnector,
  isElectrobunRuntime,
  openExternalUrl,
  useApp,
} from "@elizaos/ui";
import {
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  ExternalLink,
  Loader2,
  MessageCircle,
  Phone,
  Plug2,
  QrCode,
  RefreshCw,
  Unplug,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useDiscordConnector } from "../hooks/useDiscordConnector.js";
import { useIMessageConnector } from "../hooks/useIMessageConnector.js";
import { useSignalConnector } from "../hooks/useSignalConnector.js";
import { useTelegramConnector } from "../hooks/useTelegramConnector.js";
import { useWhatsAppConnector } from "../hooks/useWhatsAppConnector.js";
import { WhatsAppQrOverlay } from "./WhatsAppQrOverlay.js";

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

const MACOS_FULL_DISK_ACCESS_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
const LIFEOPS_BROWSER_SETUP_ID = "lifeops-browser-setup";

type ConnectorStatusVariant = "ok" | "muted" | "warning";

const CONNECTOR_STATUS_DOT_CLASS: Record<ConnectorStatusVariant, string> = {
  ok: "bg-emerald-500",
  muted: "bg-muted/40",
  warning: "bg-amber-500",
};

function ConnectorCardShell({
  icon,
  platform,
  status,
  statusVariant,
  children,
}: {
  icon: ReactNode;
  platform: string;
  status: string;
  statusVariant: ConnectorStatusVariant;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2 rounded-2xl border border-border/20 bg-card/14 px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon}
          <span className="text-sm font-medium text-txt">{platform}</span>
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${CONNECTOR_STATUS_DOT_CLASS[statusVariant]}`}
            title={status}
            aria-label={status}
            role="img"
          />
        </div>
      </div>
      {children}
    </div>
  );
}

function AccessPips({
  items,
  label,
}: {
  items: ConnectorStatusVariant[];
  label: string;
}) {
  const dots = items.length > 0 ? items : ["muted" as const];
  const slots = ["a", "b", "c", "d", "e", "f"] as const;
  return (
    <span
      aria-label={label}
      className="inline-flex items-center gap-1"
      role="img"
      title={label}
    >
      {slots.slice(0, dots.slice(0, 6).length).map((slot, slotIndex) => {
        const tone = dots[slotIndex];
        const color =
          tone === "muted" ? "bg-muted/45" : CONNECTOR_STATUS_DOT_CLASS[tone];
        return (
          <span key={slot} className={`h-1.5 w-1.5 rounded-full ${color}`} />
        );
      })}
    </span>
  );
}

function SignalIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z" />
    </svg>
  );
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
    </svg>
  );
}

function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M19.11 4.93A9.9 9.9 0 0 0 12.04 2c-5.5 0-9.96 4.45-9.96 9.94 0 1.75.46 3.47 1.34 4.99L2 22l5.23-1.37a9.97 9.97 0 0 0 4.81 1.23h.01c5.49 0 9.95-4.45 9.95-9.94a9.87 9.87 0 0 0-2.89-6.99ZM12.05 20.2h-.01a8.25 8.25 0 0 1-4.2-1.14l-.3-.18-3.1.81.83-3.02-.2-.31a8.22 8.22 0 0 1-1.28-4.42 8.29 8.29 0 0 1 8.3-8.27c2.22 0 4.31.86 5.87 2.42a8.2 8.2 0 0 1 2.43 5.85 8.29 8.29 0 0 1-8.34 8.26Zm4.53-6.18c-.25-.12-1.48-.73-1.71-.82-.23-.08-.39-.12-.56.12-.16.24-.64.82-.78.98-.14.16-.29.18-.54.06-.25-.12-1.05-.39-2-.24-.74.33-1.37-1.11-1.52-1.35-.14-.24-.02-.37.11-.49.11-.11.25-.29.37-.43.12-.14.16-.24.24-.41.08-.16.04-.31-.02-.43-.06-.12-.56-1.34-.77-1.84-.2-.48-.4-.41-.56-.42h-.48c-.16 0-.43.06-.65.31-.22.24-.85.83-.85 2.03 0 1.19.87 2.35.99 2.51.12.16 1.7 2.59 4.12 3.63.58.25 1.03.4 1.38.51.58.18 1.1.15 1.52.09.46-.07 1.48-.61 1.69-1.2.21-.59.21-1.09.15-1.2-.06-.11-.22-.18-.47-.3Z" />
    </svg>
  );
}

function inferTelegramRetryState(args: {
  authState: LifeOpsTelegramAuthState;
  authError: string | null;
}): LifeOpsTelegramAuthState {
  if (args.authState !== "error") {
    return args.authState;
  }

  const message = (args.authError ?? "").trim().toUpperCase();
  if (
    message.includes("PASSWORD_HASH_INVALID") ||
    message.includes("AUTH.CHECKPASSWORD") ||
    message.includes("TWO-FACTOR PASSWORD")
  ) {
    return "waiting_for_password";
  }
  if (
    message.includes("PHONE_CODE_INVALID") ||
    message.includes("PHONE_CODE_EXPIRED") ||
    message.includes("LOGIN CODE")
  ) {
    return "waiting_for_code";
  }
  if (message.includes("PROVISIONING CODE")) {
    return "waiting_for_provisioning_code";
  }
  return "error";
}

function browserAccessTitle(access: LifeOpsOwnerBrowserAccessStatus): string {
  if (access.source === "discord_desktop") {
    return "Discord Desktop App";
  }
  if (access.source === "desktop_browser") {
    return "Eliza Desktop Browser";
  }
  const browserLabel = access.browser === "safari" ? "Safari" : "Chrome";
  const profileLabel = access.profileLabel?.trim() || "Default profile";
  return `Your Browser · ${browserLabel} / ${profileLabel}`;
}

function browserAccessBadge(access: LifeOpsOwnerBrowserAccessStatus): {
  label: string;
  tone: "ok" | "warning" | "muted";
} {
  if (isBrowserAccessReady(access)) {
    return {
      label: access.tabState === "dm_inbox_visible" ? "Using now" : "Ready",
      tone: "ok",
    };
  }
  if (access.active || access.available) {
    return { label: "Available", tone: "warning" };
  }
  return { label: "Not ready", tone: "muted" };
}

function isBrowserAccessReady(
  access: LifeOpsOwnerBrowserAccessStatus,
): boolean {
  return (
    access.canControl &&
    access.siteAccessOk !== false &&
    access.nextAction === "none" &&
    (access.tabState === "dm_inbox_visible" ||
      access.tabState === "discord_open" ||
      access.tabState === "background_discord")
  );
}

function BrowserAccessStatusIcon({
  label,
  tone,
}: {
  label: string;
  tone: "ok" | "warning" | "muted";
}) {
  const className =
    tone === "ok"
      ? "text-emerald-500"
      : tone === "warning"
        ? "text-amber-500"
        : "text-muted/55";
  const Icon =
    tone === "ok"
      ? CheckCircle2
      : tone === "warning"
        ? CircleAlert
        : CircleDashed;
  return (
    <span
      aria-label={label}
      className={`inline-flex h-5 w-5 items-center justify-center ${className}`}
      role="img"
      title={label}
    >
      <Icon className="h-4 w-4" aria-hidden />
    </span>
  );
}

function browserAccessSourceLabel(
  access: LifeOpsOwnerBrowserAccessStatus | null | undefined,
): string {
  if (!access) {
    return "your browser";
  }
  return access.source === "desktop_browser"
    ? "Eliza Desktop Browser"
    : access.source === "discord_desktop"
      ? "Discord Desktop"
      : "Your Browser";
}

function browserAccessActionLabel(
  action: LifeOpsOwnerBrowserAccessStatus["nextAction"] | null | undefined,
): string | null {
  switch (action) {
    case "connect_browser":
      return "Connect Your Browser";
    case "open_extension_popup":
      return "Open Extension Popup";
    case "enable_browser_access":
      return "Turn On Browser Access";
    case "enable_browser_control":
      return "Enable Browser Control";
    case "open_discord":
      return "Open Discord";
    case "open_dm_inbox":
      return "Open Discord DMs";
    case "focus_discord_manually":
      return "Open Discord Manually";
    case "focus_dm_inbox_manually":
      return "Focus DMs Manually";
    case "log_in":
      return "Log In to Discord";
    case "open_desktop_browser":
      return "Open Eliza Desktop";
    case "relaunch_discord":
      return "Relaunch Discord";
    default:
      return null;
  }
}

function browserAccessMessage(access: LifeOpsOwnerBrowserAccessStatus): string {
  const sourceLabel = browserAccessSourceLabel(access);
  if (access.source === "discord_desktop") {
    if (access.nextAction === "relaunch_discord") {
      return "Relaunch Discord with local agent control enabled. This keeps your existing Discord login.";
    }
    if (access.authState === "logged_out") {
      return "Discord Desktop is controllable, but that session still needs you to log in.";
    }
    if (access.tabState === "missing") {
      return "Discord Desktop control is on, but no Discord page target was found yet.";
    }
    if (
      access.authState === "logged_in" &&
      access.tabState !== "dm_inbox_visible"
    ) {
      return "Discord Desktop is connected, but the DM inbox is not visible yet.";
    }
    return "Discord Desktop is ready for local agent control.";
  }
  if (access.source === "lifeops_browser") {
    if (!access.available && access.nextAction === "enable_browser_access") {
      return access.active
        ? "Browser access is paused in Agent Browser Bridge settings."
        : "Browser access is turned off in Agent Browser Bridge settings.";
    }
    if (access.nextAction === "connect_browser") {
      return "No browser profile is connected yet. Install the extension, then open its popup in the browser profile that has your account.";
    }
    if (access.nextAction === "open_extension_popup") {
      return "A browser was paired before, but no profile is connected right now. Reopen the extension popup in the browser profile you want LifeOps to use.";
    }
    if (access.authState === "logged_out") {
      return `Discord is open in ${sourceLabel}, but that profile still needs you to log in.`;
    }
    if (!access.canControl && access.tabState === "missing") {
      return `${sourceLabel} is connected, but browser control is off, so LifeOps cannot open Discord for you.`;
    }
    if (!access.canControl && access.tabState !== "dm_inbox_visible") {
      return `${sourceLabel} can see Discord, but browser control is off. Focus the Discord DM tab manually or turn browser control on.`;
    }
    if (access.siteAccessOk === false) {
      return `${sourceLabel} is connected, but Discord has not been granted yet in this profile. Open Discord there and retry.`;
    }
    if (access.tabState === "missing") {
      return `${sourceLabel} is connected, but Discord is not open in that browser profile yet.`;
    }
    if (
      access.authState === "logged_in" &&
      access.tabState !== "dm_inbox_visible"
    ) {
      return `${sourceLabel} sees your Discord session, but not the DM inbox yet.`;
    }
    return `${sourceLabel} is ready for Discord.`;
  }

  if (access.nextAction === "open_desktop_browser") {
    return "Open Eliza Desktop to use its built-in browser for your Discord session.";
  }
  if (access.authState === "logged_out") {
    return "Discord is open in Eliza Desktop Browser, but that session still needs you to log in.";
  }
  if (access.tabState === "missing") {
    return "Eliza Desktop Browser is available, but Discord is not open there yet.";
  }
  if (
    access.authState === "logged_in" &&
    access.tabState !== "dm_inbox_visible"
  ) {
    return "Eliza Desktop Browser sees your Discord session, but not the DM inbox yet.";
  }
  return "Eliza Desktop Browser is ready for Discord.";
}

function focusBrowserSetupPanel(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const element = document.getElementById(LIFEOPS_BROWSER_SETUP_ID);
  if (!element) {
    return false;
  }
  element.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}

function browserAccessActionIcon(
  action: LifeOpsOwnerBrowserAccessStatus["nextAction"],
) {
  switch (action) {
    case "connect_browser":
    case "open_extension_popup":
    case "enable_browser_access":
    case "enable_browser_control":
      return <Plug2 className="mr-1.5 h-3 w-3" aria-hidden />;
    case "log_in":
    case "open_desktop_browser":
    case "relaunch_discord":
    case "open_discord":
    case "open_dm_inbox":
    case "focus_discord_manually":
    case "focus_dm_inbox_manually":
      return action === "relaunch_discord" ? (
        <RefreshCw className="mr-1.5 h-3 w-3" aria-hidden />
      ) : (
        <ExternalLink className="mr-1.5 h-3 w-3" aria-hidden />
      );
    default:
      return null;
  }
}

function ConnectorManagementButton({
  provider,
  platform,
  label = "Open in Connectors",
  disabled,
}: {
  provider: "signal" | "telegram";
  platform: string;
  label?: string;
  disabled?: boolean;
}) {
  const { setActionNotice, setTab } = useApp();
  const handleOpen = useCallback(() => {
    setTab("connectors");
    dispatchFocusConnector(provider);
    setActionNotice(
      `${platform} setup is managed in Connectors. Configure the connector account there, then refresh LifeOps status.`,
      "info",
      4200,
    );
  }, [platform, provider, setActionNotice, setTab]);

  return (
    <Button
      size="sm"
      variant="outline"
      className="h-8 rounded-xl px-3 text-xs font-semibold"
      disabled={disabled}
      onClick={handleOpen}
      title={`${label}: ${platform}`}
      aria-label={`${label}: ${platform}`}
    >
      <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden />
      {label}
    </Button>
  );
}

function ManagedConnectorChip({
  platform,
  message,
}: {
  platform: string;
  message: string | null | undefined;
}) {
  const title =
    message ??
    `${platform} setup is managed by its connector plugin, not by LifeOps.`;
  return (
    <span
      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 text-[11px] font-semibold text-amber-600"
      title={title}
    >
      <Plug2 className="h-3.5 w-3.5" aria-hidden />
      Managed
    </span>
  );
}

export function SignalConnectorCard() {
  const signal = useSignalConnector();
  const isConnected = signal.status?.connected === true;
  const inboundReady = signal.status?.inbound === true;
  const sendReady =
    signal.status?.grantedCapabilities.includes("signal.send") === true;
  const fullyReady = isConnected && inboundReady && sendReady;
  const showPluginManagedSetup =
    !isConnected && signal.setupManagedByPlugin === true;
  const pairingState = signal.pairingStatus?.state ?? null;
  const isPairing =
    !showPluginManagedSetup &&
    !isConnected &&
    (pairingState === "generating_qr" ||
      pairingState === "waiting_for_scan" ||
      pairingState === "linking");
  const busy = signal.actionPending || signal.loading;
  const statusLabel =
    signal.loading && !signal.status
      ? "Checking..."
      : isConnected
        ? fullyReady
          ? "Connected"
          : inboundReady
            ? "Connected, send limited"
            : sendReady
              ? "Connected, inbound off"
              : "Connected, capabilities missing"
        : showPluginManagedSetup
          ? "Managed in Connectors"
          : isPairing
            ? "Pairing..."
            : signal.error
              ? "Needs attention"
              : "Not connected";
  const statusVariant: ConnectorStatusVariant = fullyReady
    ? "ok"
    : isConnected ||
        isPairing ||
        showPluginManagedSetup ||
        signal.error ||
        (signal.loading && !signal.status)
      ? "warning"
      : "muted";

  return (
    <ConnectorCardShell
      icon={<SignalIcon className="h-5 w-5 shrink-0 text-muted" />}
      platform="Signal"
      status={statusLabel}
      statusVariant={statusVariant}
    >
      {showPluginManagedSetup ? (
        <div className="space-y-2">
          <ManagedConnectorChip
            platform="Signal"
            message={signal.pluginManagedMessage}
          />
          <div className="flex flex-wrap items-center gap-2">
            <ConnectorManagementButton
              provider="signal"
              platform="Signal"
              disabled={busy}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-8 rounded-xl p-0"
              disabled={busy}
              onClick={() => void signal.refresh()}
              title="Refresh"
              aria-label="Refresh"
            >
              {signal.loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              )}
            </Button>
          </div>
        </div>
      ) : !isConnected && !isPairing ? (
        <Button
          size="sm"
          className="h-8 w-8 rounded-xl p-0"
          disabled={busy}
          onClick={() => void signal.startPairing()}
          title="Link Signal"
          aria-label="Link Signal"
        >
          {signal.actionPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <QrCode className="h-3.5 w-3.5" aria-hidden />
          )}
        </Button>
      ) : null}

      {isPairing ? (
        <div className="space-y-3">
          {signal.pairingStatus?.qrDataUrl ? (
            <div className="flex justify-center rounded-2xl bg-white p-3">
              <img
                src={signal.pairingStatus.qrDataUrl}
                alt="Signal pairing QR code"
                className="h-40 w-40"
              />
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Generating QR code...
            </div>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 rounded-xl p-0"
            onClick={() => void signal.stopPairing()}
            title="Cancel"
            aria-label="Cancel"
          >
            <Unplug className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      ) : null}

      {isConnected ? (
        <div className="space-y-2">
          {signal.status?.identity?.phoneNumber ? (
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <Phone className="h-3.5 w-3.5" />
              {signal.status.identity.phoneNumber}
            </div>
          ) : null}
          <details className="rounded-2xl bg-bg/24 px-3 py-2">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
              <span className="text-xs font-semibold text-txt">Access</span>
              <AccessPips
                items={[
                  inboundReady ? "ok" : "warning",
                  sendReady ? "ok" : "warning",
                ]}
                label={`Signal inbound ${inboundReady ? "ready" : "not ready"}, send ${sendReady ? "ready" : "not ready"}`}
              />
            </summary>
            <div className="mt-2 rounded-xl border border-border/40 bg-card/18 px-3 py-2 text-xs text-muted">
              <div>Inbound: {inboundReady ? "ready" : "not ready"}</div>
              <div>Send: {sendReady ? "ready" : "not ready"}</div>
            </div>
          </details>
          <div className="flex flex-wrap items-center gap-2">
            <ConnectorManagementButton
              provider="signal"
              platform="Signal"
              label="Manage"
              disabled={busy}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-8 rounded-xl p-0"
              disabled={busy}
              onClick={() => void signal.refresh()}
              title="Refresh"
              aria-label="Refresh"
            >
              {signal.loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              )}
            </Button>
          </div>
        </div>
      ) : null}

      {signal.error ? (
        <div className="text-xs text-danger">{signal.error}</div>
      ) : null}
    </ConnectorCardShell>
  );
}

export function DiscordConnectorCard() {
  const discord = useDiscordConnector();
  const { setActionNotice, setTab } = useApp();
  const busy = discord.actionPending || discord.loading;
  const username = discord.status?.identity?.username;
  const browserAccess = discord.status?.browserAccess ?? [];
  const activeDmInboxAccess =
    browserAccess.find(
      (access) => access.active && access.tabState === "dm_inbox_visible",
    ) ?? null;
  const isConnected =
    discord.status?.connected === true || Boolean(activeDmInboxAccess);
  const desktopAccess =
    browserAccess.find((access) => access.source === "desktop_browser") ?? null;
  const discordDesktopAccess =
    browserAccess.find((access) => access.source === "discord_desktop") ?? null;
  const dmInboxVisible =
    discord.status?.dmInbox.visible === true || Boolean(activeDmInboxAccess);
  const canRelaunchDiscord =
    discordDesktopAccess?.nextAction === "relaunch_discord";
  const preferredDiscordDesktopAccess =
    !dmInboxVisible && canRelaunchDiscord
      ? discordDesktopAccess
      : discordDesktopAccess?.active
        ? discordDesktopAccess
        : null;
  const preferredAccess =
    preferredDiscordDesktopAccess ??
    browserAccess.find((access) => access.active) ??
    browserAccess.find((access) => access.available) ??
    discordDesktopAccess ??
    browserAccess[0] ??
    null;
  const available =
    discord.status?.available === true ||
    browserAccess.some((access) => access.available);
  const visibleDmCount = discord.status?.dmInbox.count ?? 0;
  const lastError = canRelaunchDiscord ? null : discord.status?.lastError;
  const visibleDmLabels =
    discord.status?.dmInbox.previews
      ?.map((preview) => preview.label)
      .filter((label, index, labels) => labels.indexOf(label) === index)
      .slice(0, 3) ?? [];
  const pairing =
    discord.status?.reason === "pairing" ||
    preferredAccess?.nextAction === "open_discord" ||
    preferredAccess?.nextAction === "open_dm_inbox" ||
    preferredAccess?.nextAction === "relaunch_discord";
  const authPending =
    discord.status?.reason === "auth_pending" ||
    preferredAccess?.authState === "logged_out";
  const preferredActionLabel = browserAccessActionLabel(
    preferredAccess?.nextAction,
  );
  const showConnectButton =
    (available || canRelaunchDiscord || Boolean(preferredActionLabel)) &&
    (!isConnected || !dmInboxVisible);
  const statusLabel = dmInboxVisible
    ? `Connected • ${visibleDmCount} DM${visibleDmCount === 1 ? "" : "s"} visible`
    : authPending
      ? `Log in to Discord in ${browserAccessSourceLabel(preferredAccess)}`
      : preferredAccess?.nextAction === "relaunch_discord"
        ? "Relaunch Discord"
        : preferredAccess?.nextAction === "enable_browser_control"
          ? "Enable browser control"
          : preferredAccess?.nextAction === "connect_browser" ||
              preferredAccess?.nextAction === "open_extension_popup"
            ? "Connect Your Browser"
            : preferredAccess?.nextAction === "open_desktop_browser"
              ? "Open Eliza Desktop"
              : !available
                ? "Browser access unavailable"
                : isConnected
                  ? "Connected, opening DM inbox"
                  : pairing
                    ? `Opening Discord in ${browserAccessSourceLabel(preferredAccess)}…`
                    : "Not connected";
  const statusVariant: ConnectorStatusVariant = isConnected
    ? dmInboxVisible
      ? "ok"
      : "warning"
    : pairing || authPending || preferredActionLabel
      ? "warning"
      : "muted";
  const browserAccessTones = browserAccess.map((access) =>
    isBrowserAccessReady(access)
      ? "ok"
      : access.active || access.available
        ? "warning"
        : "muted",
  );

  const handleOpenDesktopDiscord = useCallback(async () => {
    try {
      await client.startDiscordConnector({
        side: "owner",
        source: "desktop_browser",
      });
      await discord.refresh();
      setTab("browser");
      setActionNotice(
        "Opened Discord in Eliza Desktop Browser.",
        "success",
        3200,
      );
    } catch (cause) {
      setActionNotice(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "Eliza Desktop Browser could not open Discord.",
        "error",
        4200,
      );
    }
  }, [discord, setActionNotice, setTab]);

  const handleBrowserAccessAction = useCallback(
    async (access: LifeOpsOwnerBrowserAccessStatus) => {
      if (access.source === "desktop_browser") {
        await handleOpenDesktopDiscord();
        return;
      }
      if (access.source === "discord_desktop") {
        await discord.connect("discord_desktop");
        return;
      }

      switch (access.nextAction) {
        case "connect_browser":
        case "open_extension_popup":
        case "enable_browser_access":
        case "enable_browser_control":
          if (!focusBrowserSetupPanel()) {
            setTab("browser");
          }
          setActionNotice(
            "Use Guided Browser Setup to connect the browser profile that is already logged in to Discord.",
            "info",
            4200,
          );
          return;
        case "focus_discord_manually":
        case "focus_dm_inbox_manually":
          setActionNotice(
            "Open Discord in the connected browser profile, then refresh this card.",
            "info",
            4200,
          );
          return;
        case "log_in":
        case "open_discord":
        case "open_dm_inbox":
          await discord.connect(access.source);
          return;
        default:
          await discord.refresh();
      }
    },
    [discord, handleOpenDesktopDiscord, setActionNotice, setTab],
  );
  const mainActionLabel =
    preferredActionLabel ??
    (authPending
      ? "Open Discord Login"
      : isConnected
        ? "Show Discord DMs"
        : pairing
          ? "Open Discord"
          : "Connect Discord");
  const handlePrimaryAction = useCallback(async () => {
    if (preferredAccess && preferredActionLabel) {
      await handleBrowserAccessAction(preferredAccess);
      return;
    }
    await discord.connect(preferredAccess?.source);
  }, [
    discord,
    handleBrowserAccessAction,
    preferredAccess,
    preferredActionLabel,
  ]);

  return (
    <ConnectorCardShell
      icon={<DiscordIcon className="h-5 w-5 shrink-0 text-muted" />}
      platform="Discord"
      status={statusLabel}
      statusVariant={statusVariant}
    >
      {showConnectButton ? (
        <Button
          size="sm"
          className="h-8 w-8 rounded-xl p-0"
          disabled={busy}
          onClick={() => void handlePrimaryAction()}
          title={mainActionLabel}
          aria-label={mainActionLabel}
        >
          {preferredAccess?.nextAction === "relaunch_discord" ? (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <Plug2 className="h-3.5 w-3.5" aria-hidden />
          )}
        </Button>
      ) : null}

      {isElectrobunRuntime() &&
      desktopAccess &&
      (desktopAccess.nextAction === "open_desktop_browser" ||
        desktopAccess.nextAction === "open_discord" ||
        desktopAccess.nextAction === "open_dm_inbox" ||
        (!dmInboxVisible && desktopAccess.available)) ? (
        <Button
          size="sm"
          variant="outline"
          className="h-8 w-8 rounded-xl p-0"
          disabled={busy}
          onClick={() => void handleOpenDesktopDiscord()}
          title="Open in Eliza Desktop Browser"
          aria-label="Open in Eliza Desktop Browser"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </Button>
      ) : null}

      {isConnected ? (
        <div className="space-y-2">
          {username ? (
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <MessageCircle className="h-3.5 w-3.5" />
              {String(username)}
            </div>
          ) : null}
          {dmInboxVisible ? (
            <div className="text-xs text-muted">
              {visibleDmLabels.length > 0
                ? visibleDmLabels.join(", ")
                : "DM inbox visible"}
            </div>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 rounded-xl p-0"
            disabled={busy}
            onClick={() => void discord.disconnect()}
            title="Disconnect"
            aria-label="Disconnect"
          >
            <Unplug className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      ) : null}

      {browserAccess.length > 0 ? (
        <details className="rounded-2xl bg-bg/24 px-3 py-2">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
            <span className="text-xs font-semibold text-txt">Sources</span>
            <AccessPips
              items={browserAccessTones}
              label={`${browserAccess.length} browser sources`}
            />
          </summary>
          <div className="mt-2 space-y-2">
            {browserAccess.map((access) => {
              const badge = browserAccessBadge(access);
              const actionLabel = browserAccessActionLabel(access.nextAction);
              return (
                <div
                  key={`${access.source}:${access.browser ?? "desktop"}:${access.profileId ?? "default"}`}
                  className="rounded-2xl border border-border/20 bg-card/18 px-3 py-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-txt">
                      {browserAccessTitle(access)}
                    </div>
                    <BrowserAccessStatusIcon
                      label={badge.label}
                      tone={badge.tone}
                    />
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    {browserAccessMessage(access)}
                  </div>
                  <div className="mt-1 text-[11px] text-muted/80">
                    {access.canControl ? "Control on" : "Control off"}
                    {access.siteAccessOk === false
                      ? " • Discord not granted yet"
                      : ""}
                    {access.tabState === "dm_inbox_visible"
                      ? " • DM inbox visible"
                      : access.tabState === "discord_open"
                        ? " • Discord open"
                        : access.tabState === "background_discord"
                          ? " • Discord tab found"
                          : ""}
                  </div>
                  {actionLabel ? (
                    <Button
                      size="sm"
                      variant={
                        access.source === "desktop_browser"
                          ? "outline"
                          : "default"
                      }
                      className="mt-2 h-8 rounded-xl px-3 text-xs font-semibold"
                      disabled={busy}
                      onClick={() => void handleBrowserAccessAction(access)}
                      title={actionLabel}
                      aria-label={actionLabel}
                    >
                      {browserAccessActionIcon(access.nextAction)}
                      {actionLabel}
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </details>
      ) : null}

      {discord.error ? (
        <div className="text-xs text-danger">{discord.error}</div>
      ) : lastError ? (
        <div className="text-xs text-danger">{lastError}</div>
      ) : null}
    </ConnectorCardShell>
  );
}

export function TelegramConnectorCard() {
  const telegram = useTelegramConnector();
  const [phoneInput, setPhoneInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);

  const isConnected = telegram.status?.connected === true;
  const setupManagedByPlugin = telegram.setupManagedByPlugin === true;
  const rawAuthError = telegram.status?.authError ?? telegram.error;
  const authError = telegram.pluginManaged ? telegram.error : rawAuthError;
  const authState = inferTelegramRetryState({
    authState: telegram.authState ?? "idle",
    authError: rawAuthError,
  });
  const readReady =
    telegram.status?.grantedCapabilities.includes("telegram.read") === true;
  const sendReady =
    telegram.status?.grantedCapabilities.includes("telegram.send") === true;
  const fullyReady = isConnected && readReady && sendReady;
  const busy =
    telegram.actionPending || telegram.loading || telegram.verifyPending;

  useEffect(() => {
    if (telegram.status?.phone && phoneInput.trim().length === 0) {
      setPhoneInput(telegram.status.phone);
    }
  }, [telegram.status?.phone, phoneInput]);

  useEffect(() => {
    if (isConnected || setupManagedByPlugin) {
      setLoginOpen(false);
      return;
    }
    if (authState !== "idle" && authState !== "error") {
      setLoginOpen(true);
    }
  }, [authState, isConnected, setupManagedByPlugin]);

  const handleSendCode = useCallback(() => {
    if (phoneInput.trim().length > 0) {
      void telegram.startAuth(phoneInput.trim());
    }
  }, [phoneInput, telegram]);

  const handleVerifyCode = useCallback(() => {
    if (codeInput.trim().length > 0) {
      void telegram.submitCode(codeInput.trim());
    }
  }, [codeInput, telegram]);

  const handleSubmitPassword = useCallback(() => {
    if (passwordInput.length > 0) {
      void telegram.submitPassword(passwordInput);
    }
  }, [passwordInput, telegram]);

  const handleRestartAuth = useCallback(() => {
    setCodeInput("");
    setPasswordInput("");
    void telegram.cancelAuth();
  }, [telegram]);

  const showStartStep =
    !isConnected &&
    !setupManagedByPlugin &&
    !loginOpen &&
    (authState === "idle" || authState === "error");
  const showPhoneStep =
    !isConnected &&
    !setupManagedByPlugin &&
    loginOpen &&
    (authState === "idle" || authState === "error");
  const showCodeStep =
    !setupManagedByPlugin &&
    (authState === "waiting_for_provisioning_code" ||
      authState === "waiting_for_code");
  const showPasswordStep =
    !setupManagedByPlugin && authState === "waiting_for_password";
  const statusLabel =
    telegram.loading && !telegram.status
      ? "Checking..."
      : isConnected
        ? fullyReady
          ? "Connected"
          : readReady
            ? "Connected, send limited"
            : sendReady
              ? "Connected, inbound off"
              : "Connected, capabilities missing"
        : setupManagedByPlugin
          ? "Managed in Connectors"
          : authState === "waiting_for_provisioning_code"
            ? "Enter my.telegram.org code"
            : authState === "waiting_for_code"
              ? "Enter verification code"
              : authState === "waiting_for_password"
                ? "2FA password required"
                : authState === "error"
                  ? "Retry Telegram login"
                  : "Not connected";
  const statusVariant: ConnectorStatusVariant = fullyReady
    ? "ok"
    : isConnected ||
        setupManagedByPlugin ||
        showCodeStep ||
        showPasswordStep ||
        authState === "error" ||
        (telegram.loading && !telegram.status)
      ? "warning"
      : "muted";

  return (
    <ConnectorCardShell
      icon={<TelegramIcon className="h-5 w-5 shrink-0 text-muted" />}
      platform="Telegram"
      status={statusLabel}
      statusVariant={statusVariant}
    >
      {showStartStep ? (
        <Button
          size="sm"
          className="h-8 w-8 rounded-xl p-0"
          disabled={busy}
          onClick={() => setLoginOpen(true)}
          title={authState === "error" ? "Retry" : "Connect"}
          aria-label={authState === "error" ? "Retry" : "Connect"}
        >
          <Plug2 className="h-3.5 w-3.5" aria-hidden />
        </Button>
      ) : null}

      {!isConnected && setupManagedByPlugin ? (
        <div className="space-y-2">
          <ManagedConnectorChip
            platform="Telegram"
            message={telegram.pluginManagedMessage}
          />
          <div className="flex flex-wrap items-center gap-2">
            <ConnectorManagementButton
              provider="telegram"
              platform="Telegram"
              disabled={busy}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-8 rounded-xl p-0"
              disabled={busy}
              onClick={() => void telegram.refresh()}
              title="Refresh"
              aria-label="Refresh"
            >
              {telegram.loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              )}
            </Button>
          </div>
        </div>
      ) : null}

      {showPhoneStep ? (
        <div className="flex items-center gap-2">
          <input
            type="tel"
            placeholder="+1 234 567 8900"
            value={phoneInput}
            onChange={(e) => setPhoneInput(e.target.value)}
            className="h-8 flex-1 rounded-lg bg-bg/40 px-3 text-xs text-txt placeholder:text-muted/50 focus:outline-none focus:ring-1 focus:ring-primary/40"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleSendCode();
              }
            }}
          />
          <Button
            size="sm"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            disabled={busy || phoneInput.trim().length === 0}
            onClick={handleSendCode}
          >
            Send Code
          </Button>
        </div>
      ) : null}

      {showCodeStep ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Verification code"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              className="h-8 flex-1 rounded-xl border border-border/28 bg-card/24 px-3 text-xs text-txt placeholder:text-muted/50 focus:outline-none focus:ring-1 focus:ring-primary/40"
              autoComplete="one-time-code"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleVerifyCode();
                }
              }}
            />
            <Button
              size="sm"
              className="h-8 rounded-xl px-3 text-xs font-semibold"
              disabled={busy || codeInput.trim().length === 0}
              onClick={handleVerifyCode}
            >
              Verify
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 rounded-xl px-3 text-xs font-semibold"
              disabled={busy}
              onClick={handleRestartAuth}
            >
              Restart
            </Button>
          </div>
          <div className="text-xs text-muted">
            Enter the login code Telegram sent to your app or SMS, then retry if
            the code was wrong or expired.
          </div>
        </div>
      ) : null}

      {showPasswordStep ? (
        <div className="flex items-center gap-2">
          <input
            type="password"
            placeholder="2FA password"
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
            className="h-8 flex-1 rounded-lg bg-bg/40 px-3 text-xs text-txt placeholder:text-muted/50 focus:outline-none focus:ring-1 focus:ring-primary/40"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleSubmitPassword();
              }
            }}
          />
          <Button
            size="sm"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            disabled={busy || passwordInput.length === 0}
            onClick={handleSubmitPassword}
          >
            Submit
          </Button>
        </div>
      ) : null}

      {isConnected ? (
        <div className="space-y-2">
          {telegram.status?.identity ? (
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <Phone className="h-3.5 w-3.5" />
              {String(
                telegram.status.identity.username ||
                  telegram.status.identity.phone ||
                  "",
              )}
            </div>
          ) : null}
          <details className="rounded-2xl bg-bg/24 px-3 py-2">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
              <span className="text-xs font-semibold text-txt">Access</span>
              <AccessPips
                items={[
                  readReady ? "ok" : "warning",
                  sendReady ? "ok" : "warning",
                ]}
                label={`Telegram read ${readReady ? "ready" : "not ready"}, send ${sendReady ? "ready" : "not ready"}`}
              />
            </summary>
            <div className="mt-2 rounded-xl border border-border/40 bg-card/18 px-3 py-2 text-xs text-muted">
              <div>Read: {readReady ? "ready" : "not ready"}</div>
              <div>Send: {sendReady ? "ready" : "not ready"}</div>
            </div>
          </details>
          <div className="flex flex-wrap items-center gap-2">
            <ConnectorManagementButton
              provider="telegram"
              platform="Telegram"
              label="Manage"
              disabled={busy}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-8 rounded-xl p-0"
              disabled={busy}
              onClick={() => void telegram.refresh()}
              title="Refresh"
              aria-label="Refresh"
            >
              {telegram.loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              )}
            </Button>
          </div>
        </div>
      ) : null}

      {authError ? (
        <div className="text-xs text-danger">{authError}</div>
      ) : null}
    </ConnectorCardShell>
  );
}

export function WhatsAppConnectorCard() {
  const whatsapp = useWhatsAppConnector();
  const [pairingOpen, setPairingOpen] = useState(false);
  const status = whatsapp.status;
  const inboundReady = status?.inboundReady === true;
  const outboundReady = status?.outboundReady === true;
  const fullyReady = inboundReady && outboundReady;
  const anyDirectionReady = inboundReady || outboundReady;
  const hasDegradations = Boolean(status?.degradations?.length);
  const localAuthNeedsRepair = status?.localAuthRegistered === false;
  const localAuthUnavailable =
    status?.localAuthAvailable === true && status.serviceConnected !== true;
  const isConnected = status?.connected === true;
  const busy = whatsapp.loading;
  let statusLabel: string;
  if (busy && !status) {
    statusLabel = "Checking...";
  } else if (fullyReady) {
    statusLabel =
      status?.transport === "cloudapi"
        ? "Inbound + outbound"
        : "Local session ready";
  } else if (outboundReady) {
    statusLabel = "Outbound only";
  } else if (inboundReady) {
    statusLabel = "Inbound only";
  } else if (localAuthNeedsRepair) {
    statusLabel = "Re-pair required";
  } else if (localAuthUnavailable) {
    statusLabel = "Local session offline";
  } else if (pairingOpen) {
    statusLabel = "Pairing";
  } else {
    statusLabel = "Needs setup";
  }
  const statusVariant: ConnectorStatusVariant = fullyReady
    ? "ok"
    : anyDirectionReady ||
        hasDegradations ||
        localAuthNeedsRepair ||
        localAuthUnavailable ||
        busy ||
        pairingOpen
      ? "warning"
      : "muted";

  return (
    <ConnectorCardShell
      icon={<WhatsAppIcon className="h-5 w-5 shrink-0 text-muted" />}
      platform="WhatsApp"
      status={statusLabel}
      statusVariant={statusVariant}
    >
      <div className="space-y-2">
        {status?.phoneNumberId ? (
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <Phone className="h-3.5 w-3.5" />
            Phone number ID: {status.phoneNumberId}
          </div>
        ) : null}
        {status ? (
          <details className="rounded-2xl bg-bg/24 px-3 py-2">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
              <span className="text-xs font-semibold text-txt">
                {status.transport === "cloudapi"
                  ? "Cloud API"
                  : status.transport === "baileys"
                    ? "Local session"
                    : "Transport"}
              </span>
              <AccessPips
                items={[
                  inboundReady ? "ok" : "warning",
                  outboundReady ? "ok" : "warning",
                ]}
                label={`WhatsApp inbound ${inboundReady ? "ready" : "not ready"}, outbound ${outboundReady ? "ready" : "not ready"}`}
              />
            </summary>
            <div className="mt-2 space-y-1 rounded-xl border border-border/40 bg-card/18 px-3 py-2 text-xs text-muted">
              <div>Inbound: {inboundReady ? "ready" : "not ready"}</div>
              <div>Outbound: {outboundReady ? "ready" : "not ready"}</div>
              {status.serviceConnected !== undefined ? (
                <div>
                  Runtime:{" "}
                  {status.serviceConnected ? "connected" : "not connected"}
                </div>
              ) : null}
              {status.degradations?.map((degradation) => (
                <div key={degradation.code} className="text-danger">
                  {degradation.message}
                </div>
              ))}
            </div>
          </details>
        ) : null}
        <div className="flex items-center gap-2">
          {!isConnected ? (
            <Button
              size="sm"
              className="h-8 rounded-xl px-3 text-xs font-semibold"
              disabled={busy}
              onClick={() => setPairingOpen((open) => !open)}
              title={pairingOpen ? "Hide WhatsApp QR" : "Pair WhatsApp"}
              aria-label={pairingOpen ? "Hide WhatsApp QR" : "Pair WhatsApp"}
            >
              <QrCode className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {pairingOpen ? "Hide QR" : "Pair WhatsApp"}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 rounded-xl p-0"
            disabled={busy}
            onClick={() => void whatsapp.refresh()}
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
        {pairingOpen ? (
          <WhatsAppQrOverlay
            accountId="default"
            connectedMessage="WhatsApp is paired. LifeOps will reuse this local session."
            onConnected={() => {
              setPairingOpen(false);
              void whatsapp.refresh();
            }}
          />
        ) : null}
      </div>

      {whatsapp.error ? (
        <div className="text-xs text-danger">{whatsapp.error}</div>
      ) : null}
    </ConnectorCardShell>
  );
}

function formatIMessageSendMode(
  sendMode: "cli" | "private-api" | "apple-script" | "none",
): string {
  switch (sendMode) {
    case "cli":
      return "imsg CLI";
    case "private-api":
      return "Plugin private API";
    case "apple-script":
      return "Messages.app AppleScript";
    default:
      return "Unavailable";
  }
}

function formatIMessageDiagnostic(code: string): string {
  switch (code) {
    case "full_disk_access_required":
      return "Full Disk Access is required before Eliza can read incoming Messages history.";
    case "chat_db_unavailable":
      return "Eliza could not open Messages chat.db for incoming message reads.";
    case "native_bridge_not_connected":
      return "The native Messages bridge is loaded but not connected yet.";
    case "no_backend_available":
    case "imessage_plugin_unavailable":
      return "No local iMessage backend is available.";
    default:
      return code;
  }
}

export function IMessageConnectorCard() {
  const imessage = useIMessageConnector();
  const { setActionNotice } = useApp();
  const iosRuntime = isIosRuntime();
  const status = imessage.status;
  const busy = imessage.loading;
  const isConnected = status?.connected === true;
  const hostPlatform = status?.hostPlatform ?? "unknown";
  const runningOnMacHost = hostPlatform === "darwin";
  const nativeReadDegraded =
    status?.diagnostics.includes("full_disk_access_required") ||
    status?.diagnostics.includes("chat_db_unavailable");
  const isDegraded = Boolean(isConnected && nativeReadDegraded);
  const needsFullDiskAccess = imessage.fullDiskAccess?.status === "revoked";
  const showFullDiskAccessControls =
    runningOnMacHost && (needsFullDiskAccess || nativeReadDegraded);
  const bridgeLabel =
    status?.bridgeType === "native"
      ? "Messages.app"
      : status?.bridgeType === "imsg"
        ? "imsg"
        : null;
  const statusLabel =
    busy && !status
      ? "Checking..."
      : isConnected
        ? bridgeLabel === "Messages.app" && nativeReadDegraded
          ? "Connected, needs Full Disk Access"
          : bridgeLabel
            ? `Connected via ${bridgeLabel}`
            : "Connected"
        : "Not connected";
  const statusVariant: ConnectorStatusVariant = isDegraded
    ? "warning"
    : showFullDiskAccessControls
      ? "warning"
      : isConnected
        ? "ok"
        : busy && !status
          ? "warning"
          : "muted";
  const bridgePips: ConnectorStatusVariant[] = [
    isConnected ? "ok" : "muted",
    nativeReadDegraded ? "warning" : isConnected ? "ok" : "muted",
    status?.sendMode === "apple-script"
      ? "warning"
      : isConnected
        ? "ok"
        : "muted",
  ];

  const handleOpenFullDiskAccess = useCallback(async () => {
    try {
      await openExternalUrl(MACOS_FULL_DISK_ACCESS_SETTINGS_URL);
      setActionNotice(
        "Opened macOS Full Disk Access settings.",
        "success",
        3600,
      );
    } catch (cause) {
      setActionNotice(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "Eliza could not open Full Disk Access settings.",
        "error",
        5000,
      );
    }
  }, [setActionNotice]);

  return (
    <ConnectorCardShell
      icon={<MessageCircle className="h-5 w-5 shrink-0 text-muted" />}
      platform="iMessage"
      status={statusLabel}
      statusVariant={statusVariant}
    >
      <div className="space-y-2">
        <div className="text-xs text-muted">
          {isConnected
            ? bridgeLabel === "Messages.app"
              ? nativeReadDegraded
                ? "Eliza can send through Messages.app now. Grant Full Disk Access to let it read incoming iMessages from chat.db."
                : "Eliza is using the native Mac Messages bridge for iMessage send and receive."
              : "LifeOps is using the plugin-managed iMessage bridge."
            : iosRuntime
              ? "iMessage access must run through a paired Mac or a remote Mac backend that has iMessage configured."
              : runningOnMacHost
                ? "Eliza could not load the native Messages bridge. Refresh after enabling the iMessage connector or restarting the agent."
                : "iMessage bridging requires a Mac host running Messages.app."}
        </div>
        {showFullDiskAccessControls ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 rounded-xl px-3 text-xs font-semibold"
              disabled={busy}
              onClick={() => void handleOpenFullDiskAccess()}
            >
              Open Full Disk Access
            </Button>
          </div>
        ) : null}
        {showFullDiskAccessControls ? (
          <div className="rounded-xl border border-border/40 bg-card/18 px-3 py-2 text-xs text-muted">
            Full Disk Access is still blocked for the process running Eliza, so
            reading `~/Library/Messages/chat.db` may stay limited until you
            allow it in System Settings → Privacy & Security → Full Disk Access.
          </div>
        ) : null}
        {status?.accountHandle ? (
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <Phone className="h-3.5 w-3.5" />
            {status.accountHandle}
          </div>
        ) : null}
        {isConnected ? (
          <details className="rounded-2xl bg-bg/24 px-3 py-2">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
              <span className="text-xs font-semibold text-txt">
                {bridgeLabel ?? "Bridge"}
              </span>
              <AccessPips items={bridgePips} label="iMessage bridge status" />
            </summary>
            <div className="mt-2 rounded-xl border border-border/40 bg-card/18 px-3 py-2 text-xs text-muted">
              <div>
                Send path: {formatIMessageSendMode(status?.sendMode ?? "none")}
              </div>
              <div>Read path: {nativeReadDegraded ? "limited" : "ready"}</div>
            </div>
          </details>
        ) : null}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 rounded-xl p-0"
            disabled={busy}
            onClick={() => void imessage.refresh()}
            title="Refresh"
            aria-label="Refresh"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            )}
          </Button>
        </div>
        {status?.error ? (
          <div className="text-xs text-danger">{status.error}</div>
        ) : null}
        {status?.diagnostics.length ? (
          <details className="rounded-2xl bg-bg/24 px-3 py-2">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
              <span className="text-xs font-semibold text-txt">
                Diagnostics
              </span>
              <AccessPips
                items={status.diagnostics.map(() => "warning")}
                label={`${status.diagnostics.length} diagnostics`}
              />
            </summary>
            <div className="mt-2 space-y-2">
              {status.diagnostics.map((diagnostic) => (
                <div
                  key={diagnostic}
                  className="rounded-xl border border-border/40 bg-card/18 px-3 py-2 text-xs text-muted"
                >
                  {formatIMessageDiagnostic(diagnostic)}
                </div>
              ))}
            </div>
          </details>
        ) : null}
        {imessage.error ? (
          <div className="text-xs text-danger">{imessage.error}</div>
        ) : null}
      </div>
    </ConnectorCardShell>
  );
}

export function MessagingConnectorGrid() {
  return (
    <div className="space-y-1">
      <div className="space-y-1">
        <SignalConnectorCard />
        <DiscordConnectorCard />
        <WhatsAppConnectorCard />
        <TelegramConnectorCard />
        <IMessageConnectorCard />
      </div>
    </div>
  );
}
