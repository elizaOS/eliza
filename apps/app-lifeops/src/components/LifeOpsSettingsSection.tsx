import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGoogleCapability,
} from "@elizaos/app-lifeops/contracts";
import { Button, SegmentedControl, useGoogleLifeOpsConnector } from "@elizaos/app-core";
import { Plug2 } from "lucide-react";

const MAX_GOOGLE_ACCOUNTS_PER_SIDE = 6;
const VISIBLE_CONNECTOR_MODES = ["cloud_managed", "local"] as const;
type VisibleConnectorMode = (typeof VISIBLE_CONNECTOR_MODES)[number];

function statusLabel(reason: string, connected: boolean): string {
  if (connected) {
    return "Ready";
  }
  switch (reason) {
    case "needs_reauth":
      return "Needs reauth";
    case "config_missing":
      return "Needs setup";
    case "token_missing":
      return "Token missing";
    default:
      return "Not connected";
  }
}

function readIdentity(identity: Record<string, unknown> | null): string {
  if (!identity) {
    return "No account";
  }
  const email =
    typeof identity.email === "string" && identity.email.trim().length > 0
      ? identity.email.trim()
      : null;
  const name =
    typeof identity.name === "string" && identity.name.trim().length > 0
      ? identity.name.trim()
      : null;
  return email ?? name ?? "Google";
}

function sideTitle(side: LifeOpsConnectorSide): string {
  return side === "owner" ? "User" : "Agent";
}

function modeLabel(mode: LifeOpsConnectorMode): string {
  return mode === "local" ? "Local" : "Cloud";
}

function capabilityTokens(
  grantedCapabilities: LifeOpsGoogleCapability[] | undefined,
): string[] {
  const capabilities = new Set(grantedCapabilities ?? []);
  const tokens: string[] = [];
  if (
    capabilities.has("google.gmail.triage") ||
    capabilities.has("google.gmail.send")
  ) {
    tokens.push("Mail");
  }
  if (
    capabilities.has("google.calendar.read") ||
    capabilities.has("google.calendar.write")
  ) {
    tokens.push("Cal");
  }
  return tokens;
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

type GoogleConnectorController = ReturnType<typeof useGoogleLifeOpsConnector>;

function GoogleSetupRow({
  connector,
  side,
}: {
  connector: GoogleConnectorController;
  side: LifeOpsConnectorSide;
}) {
  const {
    accounts,
    activeMode,
    actionPending,
    connect,
    connectAdditional,
    disconnect,
    disconnectAccount,
    error,
    loading,
    selectMode,
    status,
  } = connector;

  const connectedAccounts = accounts.filter((account) => account.connected);
  const remainingSlots = Math.max(
    0,
    MAX_GOOGLE_ACCOUNTS_PER_SIDE - connectedAccounts.length,
  );
  const controlDisabled = loading || actionPending;
  const visibleMode: VisibleConnectorMode =
    activeMode === "local" ? "local" : "cloud_managed";
  const showAddAccount =
    status?.connected === true &&
    connectedAccounts.length < MAX_GOOGLE_ACCOUNTS_PER_SIDE;
  const showDisconnectAll =
    status?.connected === true && connectedAccounts.length <= 1;
  const currentStatusLabel = statusLabel(
    status?.reason ?? "disconnected",
    status?.connected === true,
  );

  return (
    <div className="space-y-4 rounded-3xl bg-card/16 px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">
          {sideTitle(side)}
        </div>
        <div className="text-xs font-medium text-muted">
          {connectedAccounts.length} / {MAX_GOOGLE_ACCOUNTS_PER_SIDE}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center gap-1.5 rounded-full bg-card/24 px-2 py-1 text-xs text-muted">
          <GoogleIcon className="h-3.5 w-3.5 shrink-0" />
          <span>Google</span>
        </div>

        <SegmentedControl<VisibleConnectorMode>
          aria-label={`${sideTitle(side)} Google mode`}
          value={visibleMode}
          onValueChange={(mode) => void selectMode(mode)}
          items={VISIBLE_CONNECTOR_MODES.map((mode) => ({
            value: mode,
            label: modeLabel(mode),
            disabled: controlDisabled,
          }))}
          className="border-border/24 bg-card/24 p-0.5"
          buttonClassName="min-h-8 px-3 py-1.5 text-xs"
        />

        {!status?.connected ? (
          <Button
            size="sm"
            variant="default"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            disabled={controlDisabled}
            onClick={() => void connect()}
          >
            {status?.reason === "needs_reauth" ? "Reconnect" : "Connect"}
          </Button>
        ) : null}

        {showAddAccount ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            disabled={controlDisabled}
            onClick={() => void connectAdditional()}
          >
            + Account
          </Button>
        ) : null}

        {showDisconnectAll ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            disabled={controlDisabled}
            onClick={() => void disconnect()}
          >
            Disconnect
          </Button>
        ) : null}
      </div>

      <div
        className={
          status?.connected === true
            ? "text-xs font-medium text-ok"
            : "text-xs font-medium text-muted"
        }
      >
        {currentStatusLabel}
      </div>

      <div className="flex min-w-0 flex-wrap gap-2">
        {connectedAccounts.map((account) => {
          const tokens = capabilityTokens(account.grantedCapabilities);
          const label = readIdentity(account.identity ?? null);
          return (
            <div
              key={account.grant?.id ?? label}
              className="inline-flex min-h-9 max-w-full items-center gap-2 rounded-2xl bg-card/44 px-3 py-2"
            >
              <span className="max-w-[14rem] truncate text-sm font-semibold text-txt">
                {label}
              </span>
              {tokens.length > 0 ? (
                <span className="text-[10px] uppercase tracking-[0.12em] text-muted">
                  {tokens.join(" ")}
                </span>
              ) : null}
              {account.grant?.id ? (
                <button
                  type="button"
                  className="rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-bg-hover hover:text-txt"
                  disabled={controlDisabled}
                  onClick={() => void disconnectAccount(account.grant!.id)}
                  aria-label={`Disconnect ${label}`}
                >
                  x
                </button>
              ) : null}
            </div>
          );
        })}

        {Array.from({ length: remainingSlots }).map((_, index) => (
          <div
            key={`${side}-slot-${index}`}
            className="inline-flex min-h-9 items-center rounded-2xl bg-card/16 px-3 py-2 text-sm text-muted/40"
          >
            slot {connectedAccounts.length + index + 1}
          </div>
        ))}
      </div>

      {error ? <div className="text-xs text-danger">{error}</div> : null}
    </div>
  );
}

export function LifeOpsSettingsSection() {
  const ownerConnector = useGoogleLifeOpsConnector({ side: "owner" });
  const agentConnector = useGoogleLifeOpsConnector({ side: "agent" });
  const setupReady =
    ownerConnector.status?.connected === true &&
    agentConnector.status?.connected === true;

  return (
    <section className="overflow-hidden rounded-3xl border border-border/16 bg-card/18 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-txt">
          <Plug2 className="h-4 w-4 text-muted" />
          <div className="text-sm font-semibold">Google</div>
        </div>
        <div className="text-xs font-medium text-muted">
          {setupReady ? "Calendar + email ready" : "User + agent required"}
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <GoogleSetupRow connector={ownerConnector} side="owner" />
        <GoogleSetupRow connector={agentConnector} side="agent" />
      </div>
    </section>
  );
}
