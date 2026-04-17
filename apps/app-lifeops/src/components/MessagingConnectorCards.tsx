import { Badge, Button } from "@elizaos/app-core";
import { Loader2, MessageCircle, Phone, QrCode, X } from "lucide-react";
import { useCallback, useState } from "react";
import { useSignalConnector } from "../hooks/useSignalConnector.js";
import { useDiscordConnector } from "../hooks/useDiscordConnector.js";
import { useTelegramConnector } from "../hooks/useTelegramConnector.js";

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
  const statusColorClass =
    statusVariant === "ok"
      ? "text-ok"
      : statusVariant === "warning"
        ? "text-warning"
        : "text-muted";

  return (
    <section className="space-y-3 rounded-3xl border border-border/16 bg-card/18 px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-sm font-semibold text-txt">{platform}</span>
        </div>
        <Badge variant="outline" className="text-2xs">
          {status}
        </Badge>
      </div>
      <div className={`text-xs ${statusColorClass}`}>{status}</div>
      {children}
    </section>
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

  return (
    <ConnectorCardShell
      icon={<SignalIcon className="h-5 w-5 shrink-0 text-muted" />}
      platform="Signal"
      status={
        signal.status === "connected"
          ? "Connected"
          : signal.status === "pairing"
            ? "Pairing..."
            : "Not connected"
      }
      statusVariant={signal.status === "connected" ? "ok" : "muted"}
    >
      {signal.status === "disconnected" ? (
        <Button
          size="sm"
          className="h-8 rounded-xl px-3 text-xs font-semibold"
          disabled={signal.busy}
          onClick={() => void signal.startPairing()}
        >
          <QrCode className="mr-1.5 h-3.5 w-3.5" />
          Link Signal
        </Button>
      ) : null}

      {signal.status === "pairing" ? (
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
            onClick={() => void signal.cancelPairing()}
          >
            Cancel
          </Button>
        </div>
      ) : null}

      {signal.status === "connected" ? (
        <div className="space-y-2">
          {signal.phoneNumber ? (
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <Phone className="h-3.5 w-3.5" />
              {signal.phoneNumber}
            </div>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            disabled={signal.busy}
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

  return (
    <ConnectorCardShell
      icon={<DiscordIcon className="h-5 w-5 shrink-0 text-muted" />}
      platform="Discord"
      status={discord.connected ? "Connected" : "Not connected"}
      statusVariant={discord.connected ? "ok" : "muted"}
    >
      {!discord.connected ? (
        <Button
          size="sm"
          className="h-8 rounded-xl px-3 text-xs font-semibold"
          disabled={discord.busy}
          onClick={() => void discord.connect()}
        >
          Connect Discord
        </Button>
      ) : null}

      {discord.connected ? (
        <div className="space-y-2">
          {discord.username ? (
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <MessageCircle className="h-3.5 w-3.5" />
              {discord.username}
            </div>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            disabled={discord.busy}
            onClick={() => void discord.disconnect()}
          >
            Disconnect
          </Button>
        </div>
      ) : null}

      {discord.error ? (
        <div className="text-xs text-danger">{discord.error}</div>
      ) : null}
    </ConnectorCardShell>
  );
}

export function TelegramConnectorCard() {
  const telegram = useTelegramConnector();
  const [phoneInput, setPhoneInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");

  const handleSendCode = useCallback(() => {
    if (phoneInput.trim().length > 0) {
      void telegram.sendCode(phoneInput.trim());
    }
  }, [phoneInput, telegram]);

  const handleVerifyCode = useCallback(() => {
    if (codeInput.trim().length > 0) {
      void telegram.verifyCode(codeInput.trim());
    }
  }, [codeInput, telegram]);

  const handleSubmitPassword = useCallback(() => {
    if (passwordInput.length > 0) {
      void telegram.submitPassword(passwordInput);
    }
  }, [passwordInput, telegram]);

  const statusLabel =
    telegram.status === "connected"
      ? "Connected"
      : telegram.status === "awaiting_code"
        ? "Enter verification code"
        : telegram.status === "awaiting_password"
          ? "2FA password required"
          : "Not connected";

  return (
    <ConnectorCardShell
      icon={<TelegramIcon className="h-5 w-5 shrink-0 text-muted" />}
      platform="Telegram"
      status={statusLabel}
      statusVariant={telegram.status === "connected" ? "ok" : "muted"}
    >
      {telegram.status === "disconnected" ? (
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
            disabled={telegram.busy || phoneInput.trim().length === 0}
            onClick={handleSendCode}
          >
            Send Code
          </Button>
        </div>
      ) : null}

      {telegram.status === "awaiting_code" ? (
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
            disabled={telegram.busy || codeInput.trim().length === 0}
            onClick={handleVerifyCode}
          >
            Verify
          </Button>
        </div>
      ) : null}

      {telegram.status === "awaiting_password" ? (
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
            disabled={telegram.busy || passwordInput.length === 0}
            onClick={handleSubmitPassword}
          >
            Submit
          </Button>
        </div>
      ) : null}

      {telegram.status === "connected" ? (
        <div className="space-y-2">
          {telegram.identity ? (
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <Phone className="h-3.5 w-3.5" />
              {telegram.identity}
            </div>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            disabled={telegram.busy}
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

export function IMessageConnectorCard() {
  // iMessage is auto-detected, no connect/disconnect needed.
  // This is a read-only status card.
  const [status] = useState<"available" | "unavailable" | "unknown">("unknown");

  return (
    <ConnectorCardShell
      icon={<MessageCircle className="h-5 w-5 shrink-0 text-muted" />}
      platform="iMessage"
      status={
        status === "available"
          ? "Available"
          : status === "unavailable"
            ? "Unavailable"
            : "Checking..."
      }
      statusVariant={
        status === "available"
          ? "ok"
          : status === "unavailable"
            ? "muted"
            : "warning"
      }
    >
      <div className="text-xs text-muted">
        {status === "available"
          ? "Detected via local imsg CLI or BlueBubbles."
          : status === "unavailable"
            ? "No iMessage bridge detected. Requires macOS with imsg CLI or BlueBubbles."
            : "Auto-detected on macOS desktop. No manual setup needed."}
      </div>
    </ConnectorCardShell>
  );
}

export function MessagingConnectorGrid() {
  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted">
        Messaging
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <SignalConnectorCard />
        <DiscordConnectorCard />
        <TelegramConnectorCard />
        <IMessageConnectorCard />
      </div>
    </div>
  );
}
