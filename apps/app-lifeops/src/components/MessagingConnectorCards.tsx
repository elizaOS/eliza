import { Badge, Button } from "@elizaos/app-core";
import { Loader2, MessageCircle, Phone, QrCode, X } from "lucide-react";
import { useCallback, useState } from "react";
import { useSignalConnector } from "../hooks/useSignalConnector.js";
import { useDiscordConnector } from "../hooks/useDiscordConnector.js";
import { useTelegramConnector } from "../hooks/useTelegramConnector.js";
import { useIMessageConnector } from "../hooks/useIMessageConnector.js";

function ConnectorCardShell({
  icon,
  platform,
  status,
  statusVariant,
  children,
}: {
  icon: React.ReactNode;
  platform: string;
  status: string;
  statusVariant: "ok" | "muted" | "warning";
  children: React.ReactNode;
}) {
  const dotColor =
    statusVariant === "ok"
      ? "bg-emerald-500"
      : statusVariant === "warning"
        ? "bg-amber-500"
        : "bg-muted/40";

  return (
    <div className="space-y-2 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          {icon}
          <span className="text-sm font-medium text-txt">{platform}</span>
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotColor}`} />
          <span className="text-xs text-muted">{status}</span>
        </div>
      </div>
      {children}
    </div>
  );
}

function SignalIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z" />
    </svg>
  );
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
    </svg>
  );
}

function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

export function SignalConnectorCard() {
  const signal = useSignalConnector();
  const isConnected = signal.status?.connected === true;
  const isPairing = signal.pairingStatus != null;
  const busy = signal.actionPending || signal.loading;

  return (
    <ConnectorCardShell
      icon={<SignalIcon className="h-5 w-5 shrink-0 text-muted" />}
      platform="Signal"
      status={
        isConnected
          ? "Connected"
          : isPairing
            ? "Pairing..."
            : "Not connected"
      }
      statusVariant={isConnected ? "ok" : "muted"}
    >
      {!isConnected && !isPairing ? (
        <Button
          size="sm"
          className="h-8 rounded-xl px-3 text-xs font-semibold"
          disabled={busy}
          onClick={() => void signal.startPairing()}
        >
          <QrCode className="mr-1.5 h-3.5 w-3.5" />
          Link Signal
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
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            onClick={() => void signal.stopPairing()}
          >
            Cancel
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
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            disabled={busy}
            onClick={() => void signal.disconnect()}
          >
            Disconnect
          </Button>
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
  const isConnected = discord.status?.connected === true;
  const busy = discord.actionPending || discord.loading;
  const username = discord.status?.identity?.username;
  const available = discord.status?.available !== false;
  const dmInboxVisible = discord.status?.dmInbox.visible === true;
  const visibleDmCount = discord.status?.dmInbox.count ?? 0;
  const lastError = discord.status?.lastError;
  const visibleDmLabels =
    discord.status?.dmInbox.previews
      ?.map((preview) => preview.label)
      .filter((label, index, labels) => labels.indexOf(label) === index)
      .slice(0, 3) ?? [];
  const pairing = discord.status?.reason === "pairing";
  const authPending = discord.status?.reason === "auth_pending";
  const showConnectButton = available && (!isConnected || !dmInboxVisible);
  const statusLabel = !available
    ? "Browser access unavailable"
    : authPending
      ? "Log in to Discord in your browser"
      : isConnected
      ? dmInboxVisible
        ? `Connected • ${visibleDmCount} DM${visibleDmCount === 1 ? "" : "s"} visible`
        : "Connected, opening DM inbox"
      : pairing
        ? "Opening Discord in LifeOps Browser…"
        : "Not connected";
  const statusVariant: "ok" | "muted" | "warning" = isConnected
    ? dmInboxVisible
      ? "ok"
      : "warning"
    : pairing || authPending
      ? "warning"
      : "muted";

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
          className="h-8 rounded-xl px-3 text-xs font-semibold"
          disabled={busy || !available}
          onClick={() => void discord.connect()}
        >
          {authPending
            ? "Open Discord Login"
            : isConnected
              ? "Show Discord DMs"
              : pairing
                ? "Open Discord"
                : "Connect Discord"}
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
              LifeOps can currently see your Discord DM list.
              {visibleDmLabels.length > 0
                ? ` Visible now: ${visibleDmLabels.join(", ")}.`
                : ""}
            </div>
          ) : (
            <div className="text-xs text-muted">
              LifeOps sees your Discord session, but not the DM inbox yet. Use
              {" "}Show Discord DMs to focus the right tab.
            </div>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            disabled={busy}
            onClick={() => void discord.disconnect()}
          >
            Disconnect
          </Button>
        </div>
      ) : null}

      {!isConnected && authPending ? (
        <div className="text-xs text-muted">
          LifeOps found Discord, but that browser profile still needs you to log in.
        </div>
      ) : null}

      {!available ? (
        <div className="text-xs text-muted">
          Discord needs either a connected LifeOps Browser companion or the
          Milady desktop browser workspace.
        </div>
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

  const isConnected = telegram.status?.connected === true;
  const authState = telegram.authState ?? "idle";
  const busy =
    telegram.actionPending || telegram.loading || telegram.verifyPending;

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

  const statusLabel = isConnected
    ? "Connected"
    : authState === "waiting_for_provisioning_code"
      ? "Enter provisioning code"
      : authState === "waiting_for_code"
      ? "Enter verification code"
      : authState === "waiting_for_password"
        ? "2FA password required"
        : "Not connected";

  return (
    <ConnectorCardShell
      icon={<TelegramIcon className="h-5 w-5 shrink-0 text-muted" />}
      platform="Telegram"
      status={statusLabel}
      statusVariant={isConnected ? "ok" : "muted"}
    >
      {!isConnected && authState === "idle" ? (
        <div className="flex items-center gap-2">
          <input
            type="tel"
            placeholder="+1 234 567 8900"
            value={phoneInput}
            onChange={(e) => setPhoneInput(e.target.value)}
            className="h-8 flex-1 rounded-xl border border-border/28 bg-card/24 px-3 text-xs text-txt placeholder:text-muted/50 focus:outline-none focus:ring-1 focus:ring-primary/40"
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

      {authState === "waiting_for_provisioning_code" ||
      authState === "waiting_for_code" ? (
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder={
              authState === "waiting_for_provisioning_code"
                ? "my.telegram.org code"
                : "Verification code"
            }
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
        </div>
      ) : null}

      {authState === "waiting_for_password" ? (
        <div className="flex items-center gap-2">
          <input
            type="password"
            placeholder="2FA password"
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
            className="h-8 flex-1 rounded-xl border border-border/28 bg-card/24 px-3 text-xs text-txt placeholder:text-muted/50 focus:outline-none focus:ring-1 focus:ring-primary/40"
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
              {String(telegram.status.identity.username || telegram.status.identity.phone || "")}
            </div>
          ) : null}
          <div className="rounded-xl border border-border/40 bg-card/18 px-3 py-2 text-xs text-muted">
            Reads recent chats and sends a test note to Saved Messages.
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            disabled={busy}
            onClick={() => void telegram.verify()}
          >
            {telegram.verifyPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : null}
            Verify Read + Send
          </Button>
          {telegram.verification ? (
            <div className="rounded-xl border border-border/40 bg-card/18 px-3 py-2 text-xs text-muted">
              <div>
                Read: {telegram.verification.read.ok
                  ? `${telegram.verification.read.dialogCount} recent chats`
                  : telegram.verification.read.error ?? "failed"}
              </div>
              <div>
                Send: {telegram.verification.send.ok
                  ? `sent to ${telegram.verification.send.target}`
                  : telegram.verification.send.error ?? "failed"}
              </div>
              {telegram.verification.read.dialogs.length > 0 ? (
                <div className="mt-1 truncate">
                  Recent: {telegram.verification.read.dialogs
                    .slice(0, 3)
                    .map((dialog) => dialog.title)
                    .join(", ")}
                </div>
              ) : null}
            </div>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            disabled={busy}
            onClick={() => void telegram.disconnect()}
          >
            Disconnect
          </Button>
        </div>
      ) : null}

      {telegram.error ? (
        <div className="text-xs text-danger">{telegram.error}</div>
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
      return "BlueBubbles Private API";
    case "apple-script":
      return "BlueBubbles AppleScript fallback";
    default:
      return "Unavailable";
  }
}

function formatIMessageDiagnostic(code: string): string {
  switch (code) {
    case "bluebubbles_private_api_disabled":
      return "BlueBubbles Private API is disabled, so sends rely on AppleScript.";
    case "bluebubbles_helper_disconnected":
      return "BlueBubbles helper is disconnected, which usually means the Mac-side send path is degraded.";
    case "no_backend_available":
      return "No local iMessage backend is available.";
    default:
      return code;
  }
}

export function IMessageConnectorCard() {
  const imessage = useIMessageConnector();
  const status = imessage.status;
  const busy = imessage.loading;
  const isConnected = status?.connected === true;
  const isDegraded =
    isConnected &&
    status?.bridgeType === "bluebubbles" &&
    (status.sendMode === "apple-script" || status.helperConnected === false);
  const bridgeLabel =
    status?.bridgeType === "bluebubbles"
      ? "BlueBubbles"
      : status?.bridgeType === "imsg"
        ? "imsg"
        : null;
  const statusLabel =
    busy && !status
      ? "Checking..."
      : isConnected
        ? bridgeLabel === "BlueBubbles" && status?.sendMode === "apple-script"
          ? "Connected via BlueBubbles (AppleScript send)"
          : bridgeLabel
            ? `Connected via ${bridgeLabel}`
            : "Connected"
        : "Not connected";
  const statusVariant: "ok" | "muted" | "warning" =
    isDegraded ? "warning" : isConnected ? "ok" : busy && !status ? "warning" : "muted";

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
            ? bridgeLabel === "BlueBubbles"
              ? status?.sendMode === "private-api"
                ? "LifeOps is using the local BlueBubbles bridge with Private API enabled."
                : "LifeOps is using the local BlueBubbles bridge. Sends are currently using the AppleScript fallback."
              : "LifeOps is using the local imsg bridge for iMessage access."
            : "LifeOps could not detect an iMessage bridge. Configure BlueBubbles or the imsg CLI in Milady settings."}
        </div>
        {status?.accountHandle ? (
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <Phone className="h-3.5 w-3.5" />
            {status.accountHandle}
          </div>
        ) : null}
        {isConnected ? (
          <div className="rounded-xl border border-border/40 bg-card/18 px-3 py-2 text-xs text-muted">
            <div>Send path: {formatIMessageSendMode(status?.sendMode ?? "none")}</div>
            {status?.privateApiEnabled !== null ? (
              <div>Private API: {status.privateApiEnabled ? "enabled" : "disabled"}</div>
            ) : null}
            {status?.helperConnected !== null ? (
              <div>Helper: {status.helperConnected ? "connected" : "disconnected"}</div>
            ) : null}
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            disabled={busy}
            onClick={() => void imessage.refresh()}
          >
            {busy ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Refreshing
              </>
            ) : (
              "Refresh"
            )}
          </Button>
          {status?.lastCheckedAt ? (
            <span className="text-xs text-muted">
              Checked {new Date(status.lastCheckedAt).toLocaleTimeString()}
            </span>
          ) : null}
        </div>
        {status?.error ? (
          <div className="text-xs text-danger">{status.error}</div>
        ) : null}
        {status?.diagnostics.map((diagnostic) => (
          <div
            key={diagnostic}
            className="rounded-xl border border-border/40 bg-card/18 px-3 py-2 text-xs text-muted"
          >
            {formatIMessageDiagnostic(diagnostic)}
          </div>
        ))}
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
      <div className="pb-1 text-xs font-semibold uppercase tracking-wide text-muted">
        Messaging
      </div>
      <div className="divide-y divide-border/12">
        <SignalConnectorCard />
        <DiscordConnectorCard />
        <TelegramConnectorCard />
        <IMessageConnectorCard />
      </div>
    </div>
  );
}
