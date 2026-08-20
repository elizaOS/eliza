/**
 * Renders Settings > Devices & Runtimes: linked controllers, QR/code pairing,
 * runtime switching, and deliberately separated advanced server enrollment.
 */
import {
  Check,
  ChevronDown,
  Cloud,
  Copy,
  HardDrive,
  KeyRound,
  Laptop,
  Link2,
  LoaderCircle,
  MonitorSmartphone,
  Plus,
  Server,
  ShieldCheck,
  Smartphone,
  Tag,
  Terminal,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import type { AgentProfile } from "../../state/agent-profile-types";
import { SettingsInputRow } from "../settings/settings-agent-rows";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../settings/settings-layout";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

type RuntimeKind = AgentProfile["kind"];

const KIND_META: Record<
  RuntimeKind,
  { label: string; icon: typeof Cloud; badge: string }
> = {
  local: {
    label: "On this device",
    icon: HardDrive,
    badge: "text-muted border-border",
  },
  cloud: {
    label: "Eliza Cloud",
    icon: Cloud,
    badge: "text-accent border-accent/30 bg-accent-subtle",
  },
  remote: {
    label: "Remote host",
    icon: Server,
    badge: "text-accent border-accent/30",
  },
};
const KIND_ORDER: RuntimeKind[] = ["local", "cloud", "remote"];

export interface LinkedElizaDevice {
  id: string;
  name: string;
  platform: "iphone" | "ipad" | "mac" | "windows" | "linux" | "other";
  role: "this-device" | "controller" | "host";
  status: "online" | "offline" | "pending";
  lastSeenLabel?: string;
}

export interface RuntimePairingChallenge {
  code: string;
  qrPayload: string;
  expiresAt: string;
}

export interface MyRuntimesSectionProps {
  runtimes: AgentProfile[];
  activeId: string | null;
  onSwitch: (id: string) => void | Promise<void>;
  devices?: LinkedElizaDevice[];
  onCreatePairing?: () => Promise<RuntimePairingChallenge>;
  onRedeemPairing?: (code: string) => Promise<void>;
  onAddSshHost?: () => void;
  onAddRemote?: (entry: {
    label: string;
    apiBase: string;
    accessToken?: string;
  }) => void | Promise<void>;
  busy?: boolean;
  className?: string;
}

function deviceIcon(platform: LinkedElizaDevice["platform"]) {
  if (platform === "iphone" || platform === "ipad") return Smartphone;
  if (platform === "mac") return Laptop;
  return MonitorSmartphone;
}

function formatPairingCode(code: string): string {
  const digits = code.replace(/\D/g, "").slice(0, 6);
  return digits.length > 3
    ? `${digits.slice(0, 3)} ${digits.slice(3)}`
    : digits;
}

/**
 * The first-party device/runtime manager. Pairing is provider-driven so the UI
 * can render in stories while production callers retain ownership of issuance,
 * redemption, secure storage, and revocation.
 */
export function MyRuntimesSection({
  runtimes,
  activeId,
  devices = [],
  onSwitch,
  onCreatePairing,
  onRedeemPairing,
  onAddSshHost,
  onAddRemote,
  busy = false,
  className,
}: MyRuntimesSectionProps) {
  const [pairOpen, setPairOpen] = useState(false);
  const [pairMode, setPairMode] = useState<"show" | "enter">("show");
  const [challenge, setChallenge] = useState<RuntimePairingChallenge | null>(
    null,
  );
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [enteredCode, setEnteredCode] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");

  const sorted = useMemo(
    () =>
      [...runtimes].sort(
        (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
      ),
    [runtimes],
  );
  const canAdd = !busy && label.trim().length > 0 && url.trim().length > 0;
  const canRedeem = !pairBusy && /^\d{6}$/.test(enteredCode.replace(/\D/g, ""));

  useEffect(() => {
    let canceled = false;
    if (!challenge?.qrPayload) {
      setQrDataUrl(null);
      return;
    }
    void import("qrcode")
      .then((qr) =>
        qr.toDataURL(challenge.qrPayload, {
          width: 256,
          margin: 2,
          errorCorrectionLevel: "M",
        }),
      )
      .then((dataUrl) => {
        if (!canceled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!canceled)
          setPairError(
            "The QR code could not be rendered. Use the six-digit code instead.",
          );
      });
    return () => {
      canceled = true;
    };
  }, [challenge]);

  const openPairing = async (mode: "show" | "enter") => {
    setPairMode(mode);
    setPairOpen(true);
    setPairError(null);
    if (mode !== "show" || challenge || !onCreatePairing) return;
    setPairBusy(true);
    try {
      setChallenge(await onCreatePairing());
    } catch (error) {
      setPairError(
        error instanceof Error
          ? error.message
          : "Pairing is unavailable right now.",
      );
    } finally {
      setPairBusy(false);
    }
  };

  const redeem = async () => {
    if (!canRedeem || !onRedeemPairing) return;
    setPairBusy(true);
    setPairError(null);
    try {
      await onRedeemPairing(enteredCode.replace(/\D/g, ""));
      setPairOpen(false);
      setEnteredCode("");
    } catch (error) {
      setPairError(
        error instanceof Error ? error.message : "That code could not be used.",
      );
    } finally {
      setPairBusy(false);
    }
  };

  const submitRemote = () => {
    if (!canAdd || !onAddRemote) return;
    void onAddRemote({
      label: label.trim(),
      apiBase: url.trim(),
      accessToken: token.trim() || undefined,
    });
    setLabel("");
    setUrl("");
    setToken("");
  };

  return (
    <SettingsStack data-testid="devices-and-runtimes" className={className}>
      <SettingsGroup
        title="Linked devices"
        description="Use your phone or another computer to control your Eliza agents. Eliza Cloud connects approved devices privately; no Tailscale account is required."
        action={
          <Button
            type="button"
            size="sm"
            className="min-h-11"
            disabled={!onCreatePairing || busy}
            onClick={() => void openPairing("show")}
          >
            <Plus className="mr-1.5 size-4" aria-hidden /> Link device
          </Button>
        }
      >
        {devices.length === 0 ? (
          <SettingsRow
            icon={ShieldCheck}
            label="Only this device"
            description="Link an iPhone or another Mac with a QR code or six-digit code."
            control={
              onRedeemPairing ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11"
                  onClick={() => void openPairing("enter")}
                >
                  Enter code
                </Button>
              ) : undefined
            }
          />
        ) : (
          devices.map((device) => {
            const Icon = deviceIcon(device.platform);
            return (
              <SettingsRow
                key={device.id}
                icon={Icon}
                label={device.name}
                description={
                  device.lastSeenLabel ??
                  (device.status === "online" ? "Online now" : "Offline")
                }
                control={
                  <span
                    className={cn(
                      "text-xs font-medium",
                      device.status === "online" ? "text-ok" : "text-muted",
                    )}
                  >
                    {device.role === "this-device"
                      ? "This device"
                      : device.status === "pending"
                        ? "Waiting"
                        : device.status === "online"
                          ? "Online"
                          : "Offline"}
                  </span>
                }
              />
            );
          })
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Agents"
        description="Choose where new chats and commands run."
      >
        {sorted.map((rt) => {
          const meta = KIND_META[rt.kind];
          const Icon = meta.icon;
          const isActive = rt.id === activeId;
          return (
            <div key={rt.id} data-testid={`runtime-${rt.id}`}>
              <SettingsRow
                icon={Icon}
                active={isActive}
                label={
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{rt.label}</span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                        meta.badge,
                      )}
                    >
                      {meta.label}
                    </span>
                  </span>
                }
                description={
                  rt.apiBase ??
                  (rt.kind === "local"
                    ? "Runs on this device"
                    : "Managed by Eliza Cloud")
                }
                control={
                  isActive ? (
                    <span
                      data-testid={`runtime-${rt.id}-active`}
                      className="flex shrink-0 items-center gap-1 text-xs font-semibold text-accent"
                    >
                      <Check className="size-3.5" aria-hidden /> Active
                    </span>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11"
                      data-testid={`runtime-${rt.id}-use`}
                      disabled={busy}
                      onClick={() => onSwitch(rt.id)}
                    >
                      Use
                    </Button>
                  )
                }
              />
            </div>
          );
        })}
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          icon={Terminal}
          label="Advanced"
          description="Add a VPS over SSH or connect an existing private endpoint."
          control={
            <ChevronDown
              className={cn(
                "size-4 text-muted transition-transform",
                advancedOpen && "rotate-180",
              )}
              aria-hidden
            />
          }
          onClick={() => setAdvancedOpen((open) => !open)}
        />
        {advancedOpen ? (
          <div
            className="border-l border-border pl-3 sm:ml-4"
            data-testid="advanced-runtime-options"
          >
            {onAddSshHost ? (
              <SettingsRow
                icon={Server}
                label="Add server with SSH"
                description="Eliza uses your Mac's SSH agent to install and enroll a private host. Your phone never receives the SSH key."
                control={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    onClick={onAddSshHost}
                  >
                    Set up
                  </Button>
                }
              />
            ) : null}
            {onAddRemote ? (
              <form
                data-testid="add-remote-runtime"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitRemote();
                }}
              >
                <SettingsInputRow
                  agentId="devices-runtimes-add-label"
                  group="devices-runtimes-add"
                  icon={Tag}
                  label="Label"
                  value={label}
                  onValueChange={setLabel}
                  placeholder="e.g. production VPS"
                  testId="add-remote-label"
                  autoComplete="off"
                />
                <SettingsInputRow
                  agentId="devices-runtimes-add-url"
                  group="devices-runtimes-add"
                  icon={Link2}
                  label="URL"
                  description="Use a private Tailscale address or trusted HTTPS endpoint."
                  type="url"
                  inputMode="url"
                  value={url}
                  onValueChange={setUrl}
                  placeholder="https://host.example or http://100.x.y.z:3000"
                  testId="add-remote-url"
                  autoComplete="off"
                />
                <SettingsInputRow
                  agentId="devices-runtimes-add-token"
                  group="devices-runtimes-add"
                  icon={KeyRound}
                  label="Access token"
                  description="Stored in the device secure store when available."
                  type="password"
                  value={token}
                  onValueChange={setToken}
                  placeholder="Optional"
                  testId="add-remote-token"
                  autoComplete="new-password"
                />
                <div className="py-2">
                  <Button
                    type="submit"
                    size="sm"
                    className="min-h-11"
                    data-testid="add-remote-submit"
                    disabled={!canAdd}
                  >
                    Add endpoint
                  </Button>
                </div>
              </form>
            ) : null}
          </div>
        ) : null}
      </SettingsGroup>

      <Dialog open={pairOpen} onOpenChange={setPairOpen}>
        <DialogContent
          data-testid="device-pairing-dialog"
          className="overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>
              {pairMode === "show"
                ? "Link another device"
                : "Enter pairing code"}
            </DialogTitle>
            <DialogDescription>
              {pairMode === "show"
                ? "On the other device, open Eliza → Settings → Devices & Runtimes."
                : "Enter the code shown by the Mac or server you want to control."}
            </DialogDescription>
          </DialogHeader>
          {pairMode === "show" ? (
            <div className="flex flex-col items-center gap-4 py-2">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="Eliza device pairing QR code"
                  className="size-56 rounded-xl bg-white p-2"
                />
              ) : (
                <div className="flex size-56 items-center justify-center rounded-xl bg-surface">
                  <LoaderCircle
                    className="size-6 animate-spin text-muted"
                    aria-label="Creating pairing code"
                  />
                </div>
              )}
              {challenge ? (
                <div className="text-center">
                  <p className="text-xs text-muted">Or enter this code</p>
                  <div className="mt-1 flex items-center gap-2">
                    <code
                      className="text-2xl font-semibold tracking-[0.22em] text-txt-strong"
                      data-testid="pairing-code"
                    >
                      {formatPairingCode(challenge.code)}
                    </code>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-11"
                      aria-label="Copy pairing code"
                      onClick={() =>
                        void navigator.clipboard?.writeText(challenge.code)
                      }
                    >
                      <Copy className="size-4" />
                    </Button>
                  </div>
                  <p className="mt-2 text-xs text-muted">
                    Expires in five minutes. It works once.
                  </p>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="space-y-2 py-3">
              <label
                htmlFor="pairing-code-input"
                className="text-xs font-medium text-muted"
              >
                Six-digit code
              </label>
              <Input
                id="pairing-code-input"
                data-testid="pairing-code-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                value={formatPairingCode(enteredCode)}
                onChange={(event) =>
                  setEnteredCode(
                    event.target.value.replace(/\D/g, "").slice(0, 6),
                  )
                }
                className="h-14 text-center text-xl tracking-[0.2em]"
                autoFocus
              />
            </div>
          )}
          {pairError ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {pairError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              onClick={() => setPairOpen(false)}
            >
              Cancel
            </Button>
            {pairMode === "enter" ? (
              <Button
                type="button"
                className="min-h-11"
                disabled={!canRedeem || !onRedeemPairing}
                onClick={() => void redeem()}
              >
                {pairBusy ? "Connecting…" : "Connect"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsStack>
  );
}
