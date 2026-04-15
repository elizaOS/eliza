import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
} from "@elizaos/app-lifeops/contracts";
import {
  Button,
  SegmentedControl,
  useApp,
  useGoogleLifeOpsConnector,
} from "@elizaos/app-core";
import { Plug2 } from "lucide-react";
import { LifeOpsBrowserSetupPanel } from "./LifeOpsBrowserSetupPanel";

const VISIBLE_CONNECTOR_MODES = ["cloud_managed", "local"] as const;
type VisibleConnectorMode = (typeof VISIBLE_CONNECTOR_MODES)[number];

function statusLabel(reason: string, connected: boolean): string {
  if (connected) {
    return "Connected";
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

function readIdentity(identity: Record<string, unknown> | null): {
  primary: string;
  secondary: string | null;
} {
  if (!identity) {
    return {
      primary: "Google not connected",
      secondary: null,
    };
  }
  const name =
    typeof identity.name === "string" && identity.name.trim().length > 0
      ? identity.name.trim()
      : null;
  const email =
    typeof identity.email === "string" && identity.email.trim().length > 0
      ? identity.email.trim()
      : null;
  return {
    primary: name ?? email ?? "Google connected",
    secondary: name && email ? email : null,
  };
}

function modeLabel(mode: LifeOpsConnectorMode): string {
  return mode === "local" ? "Local" : "Cloud";
}

function sideTitle(side: LifeOpsConnectorSide): string {
  return side === "owner" ? "Owner" : "Agent";
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

function GoogleConnectorSideCard({
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
  const identity = readIdentity(status?.identity ?? null);
  const currentStatusLabel = statusLabel(
    status?.reason ?? "disconnected",
    status?.connected === true,
  );
  const controlDisabled = loading || actionPending;
  const visibleMode: VisibleConnectorMode =
    activeMode === "local" ? "local" : "cloud_managed";

  const connectedAccounts = accounts.filter((a) => a.connected);
  const hasMultipleAccounts = connectedAccounts.length > 1;
  const preferredGrantId = status?.grant?.id ?? null;

  return (
    <div className="space-y-3 rounded-2xl border border-border/24 bg-bg/20 px-4 py-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted">
        {sideTitle(side)}
      </div>

      {connectedAccounts.length > 0 ? (
        <div className="space-y-2">
          {connectedAccounts.map((acct) => {
            const acctIdentity = readIdentity(acct.identity ?? null);
            const isPreferred =
              acct.grant?.id != null && acct.grant.id === preferredGrantId;
            return (
              <div
                key={acct.grant?.id ?? acctIdentity.primary}
                className="flex items-center gap-2 min-w-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 truncate text-sm font-semibold text-txt">
                    {acctIdentity.primary}
                    {isPreferred && hasMultipleAccounts ? (
                      <span className="shrink-0 rounded bg-ok/16 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ok">
                        Preferred
                      </span>
                    ) : null}
                  </div>
                  {acctIdentity.secondary ? (
                    <div className="mt-0.5 text-xs text-muted">
                      {acctIdentity.secondary}
                    </div>
                  ) : null}
                </div>
                {acct.grant?.id ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 shrink-0 rounded-lg px-2 text-[11px] font-semibold"
                    disabled={controlDisabled}
                    onClick={() => void disconnectAccount(acct.grant!.id)}
                  >
                    Disconnect
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-txt">
            {identity.primary}
          </div>
          {identity.secondary ? (
            <div className="mt-1 text-xs text-muted">{identity.secondary}</div>
          ) : null}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
          <GoogleIcon className="h-4 w-4 shrink-0" />
          <span>Google</span>
        </div>

        <SegmentedControl<VisibleConnectorMode>
          aria-label={`${sideTitle(side)} Google connection mode`}
          value={visibleMode}
          onValueChange={(mode) => void selectMode(mode)}
          items={VISIBLE_CONNECTOR_MODES.map((mode) => ({
            value: mode,
            label: modeLabel(mode),
            disabled: controlDisabled,
          }))}
          className="border-border/28 bg-card/24 p-0.5"
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
      </div>

      {status?.connected ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 rounded-lg px-2 text-[11px] font-semibold"
            disabled={controlDisabled}
            onClick={() => void connectAdditional()}
          >
            + Add account
          </Button>
          {!hasMultipleAccounts ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 rounded-lg px-2 text-[11px] font-semibold"
              disabled={controlDisabled}
              onClick={() => void disconnect()}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className={status?.connected ? "text-xs text-ok" : "text-xs text-muted"}>
        {currentStatusLabel}
      </div>

      {error ? <div className="text-xs text-danger">{error}</div> : null}
    </div>
  );
}

export function LifeOpsSettingsSection() {
  const { t: translate } = useApp();
  const ownerConnector = useGoogleLifeOpsConnector({ side: "owner" });
  const agentConnector = useGoogleLifeOpsConnector({ side: "agent" });
  const t =
    typeof translate === "function" ? translate : (key: string): string => key;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-muted">
        <Plug2 className="h-4 w-4" />
        <div className="text-xs font-semibold uppercase tracking-wide">
          {t("settings.sections.lifeops.label")}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <GoogleConnectorSideCard connector={ownerConnector} side="owner" />
        <GoogleConnectorSideCard connector={agentConnector} side="agent" />
      </div>

      <LifeOpsBrowserSetupPanel />
    </div>
  );
}
