/**
 * CloudView — the in-app "Cloud" launcher view: the user's Eliza Cloud account
 * at a glance (credits + top-up, hosted agents with status, API-key inventory,
 * billing summary) rendered app-native in the dark launcher aesthetic.
 *
 * Served as this plugin's `cloud` view bundle (`vite.config.views.ts`) and
 * mounted by the shell's DynamicViewLoader at `/cloud`. Data comes from the
 * host `client` singleton's cloud wrappers, while navigation uses the host's
 * scope broker and safe external-URL boundary.
 *
 * State machine honors the repo three-state rule: loading / signed-out
 * (designed connect CTA) / error (with retry) / ready — and inside ready each
 * secondary section (agents, keys, billing) degrades to its own designed
 * "unavailable" note on fetch failure rather than a healthy-empty render.
 */

// Host-provided UI atoms and the narrow API singleton are both externalized by
// the dynamic-view loader, so this bundle does not ship a second UI runtime.
import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@elizaos/ui";
import { navigateBrowserPath } from "@elizaos/ui/app-navigate-view";
import { client } from "@elizaos/ui/api";
import type {
  CloudApiKeys,
  CloudBillingSummary,
  CloudCompatAgent,
  CloudCredits,
  CloudStatus,
} from "@elizaos/ui/api";
import { openExternalUrl } from "@elizaos/ui/utils";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Fetcher seam — defaults hit the host client; tests inject offline fakes.
// ---------------------------------------------------------------------------

export interface CloudViewFetchers {
  fetchStatus: () => Promise<CloudStatus>;
  fetchCredits: () => Promise<CloudCredits>;
  fetchAgents: () => Promise<{
    success: boolean;
    data: CloudCompatAgent[];
    error?: string;
  }>;
  fetchApiKeys: () => Promise<CloudApiKeys>;
  fetchBillingSummary: () => Promise<CloudBillingSummary>;
}

const defaultFetchers: CloudViewFetchers = {
  fetchStatus: () => client.getCloudStatus(),
  fetchCredits: () => client.getCloudCredits(),
  fetchAgents: () => client.getCloudCompatAgents(),
  fetchApiKeys: () => client.listCloudApiKeys(),
  fetchBillingSummary: () => client.getCloudBillingSummary(),
};

export interface CloudViewInteractions {
  navigateInternal: (path: string) => void;
  openExternal: (url: string) => Promise<boolean>;
}

const defaultInteractions: CloudViewInteractions = {
  navigateInternal: navigateBrowserPath,
  openExternal: openExternalUrl,
};

// ---------------------------------------------------------------------------
// Load-state machine.
// ---------------------------------------------------------------------------

/** A secondary section either has data or a designed unavailable message. */
type Section<T> = { data: T; error: null } | { data: null; error: string };

interface ReadyData {
  credits: Section<CloudCredits>;
  agents: Section<CloudCompatAgent[]>;
  apiKeys: Section<CloudApiKeys>;
  billing: Section<CloudBillingSummary>;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: ReadyData };

const AGENT_REFRESH_MS = 30_000;

function section<T>(
  result: PromiseSettledResult<T>,
  unavailable: string,
): Section<T> {
  if (result.status === "fulfilled") return { data: result.value, error: null };
  return { data: null, error: unavailable };
}

async function loadAccount(fetchers: CloudViewFetchers): Promise<LoadState> {
  const status = await fetchers.fetchStatus();
  if (!status.connected) return { kind: "signed-out" };

  const [credits, agents, apiKeys, billing] = await Promise.allSettled([
    fetchers.fetchCredits(),
    fetchers.fetchAgents(),
    fetchers.fetchApiKeys(),
    fetchers.fetchBillingSummary(),
  ]);

  const agentsSection: Section<CloudCompatAgent[]> =
    agents.status === "fulfilled"
      ? agents.value.success
        ? { data: agents.value.data, error: null }
        : {
            data: null,
            error: agents.value.error ?? "Agents are unavailable right now.",
          }
      : { data: null, error: "Agents are unavailable right now." };

  return {
    kind: "ready",
    data: {
      credits: section(credits, "Credits are unavailable right now."),
      agents: agentsSection,
      apiKeys: section(apiKeys, "API keys are unavailable right now."),
      billing: section(billing, "Billing is unavailable right now."),
    },
  };
}

// ---------------------------------------------------------------------------
// Presentational pieces (token classes only — the launcher theme owns colors).
// ---------------------------------------------------------------------------

function CloudCard(props: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card asChild variant="panel">
      <section>
        <CardHeader className="grid grid-cols-[1fr_auto] items-start gap-2 space-y-0 p-4 pb-3">
          <CardTitle className="text-sm text-txt">{props.title}</CardTitle>
          {props.action ? <CardAction>{props.action}</CardAction> : null}
        </CardHeader>
        <CardContent className="px-4 pb-4 pt-0">{props.children}</CardContent>
      </section>
    </Card>
  );
}

function SectionNote(props: { message: string }) {
  return <p className="text-sm text-muted">{props.message}</p>;
}

function ExternalAction(props: {
  href: string;
  children: ReactNode;
  onOpen: (href: string) => void;
}) {
  return (
    <Button
      type="button"
      variant="externalLink"
      onClick={() => props.onOpen(props.href)}
    >
      {props.children}
    </Button>
  );
}

function agentStatusTone(
  status: string,
): "success" | "danger" | "warning" | "muted" {
  const normalized = status.toLowerCase();
  if (normalized === "running") return "success";
  if (normalized === "error") return "danger";
  if (normalized === "provisioning" || normalized === "pending")
    return "warning";
  return "muted";
}

function balanceClass(credits: CloudCredits): string {
  if (credits.critical) return "text-danger";
  if (credits.low) return "text-warn";
  return "text-txt";
}

function formatBalance(balance: number | null): string {
  return balance === null ? "—" : `$${balance.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Cards.
// ---------------------------------------------------------------------------

function CreditsCard(props: {
  credits: Section<CloudCredits>;
  billing: Section<CloudBillingSummary>;
  onOpen: (href: string) => void;
}) {
  const { credits, billing, onOpen } = props;
  if (!credits.data) {
    return (
      <CloudCard title="Credits">
        <SectionNote message={credits.error} />
      </CloudCard>
    );
  }
  const topUpUrl = credits.data.topUpUrl ?? billing.data?.topUpUrl;
  return (
    <CloudCard
      title="Credits"
      action={
        topUpUrl ? (
          <ExternalAction href={topUpUrl} onOpen={onOpen}>
            Top up
          </ExternalAction>
        ) : undefined
      }
    >
      <p
        className={`text-2xl font-semibold ${balanceClass(credits.data)}`}
        data-testid="cloud-credit-balance"
      >
        {formatBalance(credits.data.balance)}
      </p>
      {credits.data.critical ? (
        <p className="mt-1 text-sm text-danger">Balance is critically low.</p>
      ) : credits.data.low ? (
        <p className="mt-1 text-sm text-warn">Balance is running low.</p>
      ) : null}
      {billing.data ? (
        <p className="mt-2 text-sm text-muted">
          {billing.data.hasPaymentMethod
            ? "Payment method on file."
            : "No payment method on file."}
        </p>
      ) : (
        <p className="mt-2 text-sm text-muted">{billing.error}</p>
      )}
    </CloudCard>
  );
}

function AgentsCard(props: { agents: Section<CloudCompatAgent[]> }) {
  const { agents } = props;
  return (
    <CloudCard title="Hosted agents">
      {agents.data === null ? (
        <SectionNote message={agents.error} />
      ) : agents.data.length === 0 ? (
        <SectionNote message="No hosted agents." />
      ) : (
        <ul className="space-y-2" data-testid="cloud-agent-list">
          {agents.data.map((agent) => (
            <li
              key={agent.agent_id}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2"
            >
              <span className="truncate text-sm text-txt">
                {agent.agent_name}
              </span>
              <Badge
                variant="outline"
                size="micro"
                tone={agentStatusTone(agent.status)}
              >
                {agent.status}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </CloudCard>
  );
}

function ApiKeysCard(props: {
  apiKeys: Section<CloudApiKeys>;
  onOpen: (href: string) => void;
}) {
  const { apiKeys, onOpen } = props;
  if (apiKeys.data === null) {
    return (
      <CloudCard title="API keys">
        <SectionNote message={apiKeys.error} />
      </CloudCard>
    );
  }
  const { keys, manageUrl, reason } = apiKeys.data;
  return (
    <CloudCard
      title="API keys"
      action={
        <ExternalAction href={manageUrl} onOpen={onOpen}>
          Manage
        </ExternalAction>
      }
    >
      {keys === null ? (
        <SectionNote
          message={
            reason === "session-required"
              ? "Open the console to view API keys for this account."
              : "Open the console to view API keys."
          }
        />
      ) : (
        <p className="text-sm text-txt" data-testid="cloud-api-key-count">
          {keys.length === 1 ? "1 API key" : `${keys.length} API keys`}
        </p>
      )}
    </CloudCard>
  );
}

// ---------------------------------------------------------------------------
// View.
// ---------------------------------------------------------------------------

export interface CloudViewProps {
  /** Test/host injection seam. Defaults to the host `client` cloud wrappers. */
  fetchers?: CloudViewFetchers;
  /** Test seam for the host-brokered internal and external navigation paths. */
  interactions?: CloudViewInteractions;
}

export function CloudView(props: CloudViewProps = {}): ReactNode {
  const fetchers = props.fetchers ?? defaultFetchers;
  const interactions = props.interactions ?? defaultInteractions;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [navigationError, setNavigationError] = useState<string | null>(null);

  const fetchersRef = useRef(fetchers);
  fetchersRef.current = fetchers;
  const interactionsRef = useRef(interactions);
  interactionsRef.current = interactions;

  const navigateInternal = useCallback((path: string) => {
    setNavigationError(null);
    try {
      interactionsRef.current.navigateInternal(path);
    } catch {
      setNavigationError("Navigation is unavailable right now.");
    }
  }, []);

  const openExternal = useCallback((url: string) => {
    setNavigationError(null);
    void interactionsRef.current
      .openExternal(url)
      .then((opened) => {
        if (!opened)
          setNavigationError("This link could not be opened safely.");
      })
      .catch(() => setNavigationError("This link could not be opened safely."));
  }, []);

  // `background` refreshes in place (the 30s agent-status poll); user-driven
  // loads (mount, retry) show the loading state. Background refreshes keep the
  // last-good view on failure: one transient network blip mid-session must not
  // replace a healthy dashboard with the full-screen error (or flip a
  // momentary connected:false into the signed-out card) — errors surface only
  // on user-driven loads, and the next poll self-corrects.
  const load = useCallback((background = false) => {
    let cancelled = false;
    if (!background) setState({ kind: "loading" });
    loadAccount(fetchersRef.current)
      .then((next) => {
        if (cancelled) return;
        if (background && next.kind !== "ready") return;
        setState(next);
      })
      .catch((error: unknown) => {
        if (cancelled || background) return;
        setState({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not load your Eliza Cloud account.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  // Hosted-agent statuses move (provisioning → running) — refresh in the
  // background while the view is mounted and healthy.
  useEffect(() => {
    if (state.kind !== "ready") return;
    const timer = window.setInterval(() => load(true), AGENT_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [state.kind, load]);

  if (state.kind === "loading") {
    return (
      <div
        className="flex h-full items-center justify-center bg-bg"
        data-testid="cloud-loading"
      >
        <p className="text-sm text-muted">Loading your Eliza Cloud account…</p>
      </div>
    );
  }

  if (state.kind === "signed-out") {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 bg-bg px-6 text-center"
        data-testid="cloud-signed-out"
      >
        <h1 className="text-lg font-semibold text-txt">Eliza Cloud</h1>
        <p className="max-w-sm text-sm text-muted">
          Connect to view credits, agents, API keys, and billing.
        </p>
        {navigationError ? (
          <p role="alert" className="text-sm text-danger">
            {navigationError}
          </p>
        ) : null}
        <Button type="button" onClick={() => navigateInternal("/settings")}>
          Connect in Settings
        </Button>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 bg-bg px-6 text-center"
        data-testid="cloud-error"
      >
        <p className="text-sm text-danger">{state.message}</p>
        <Button type="button" variant="outline" onClick={() => load()}>
          Retry
        </Button>
      </div>
    );
  }

  const { data } = state;
  return (
    <div className="h-full overflow-y-auto bg-bg" data-testid="cloud-ready">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-lg font-semibold text-txt">Eliza Cloud</h1>
          <Badge variant="outline" size="micro" tone="success">
            Connected
          </Badge>
        </div>
        {navigationError ? (
          <p role="alert" className="text-sm text-danger">
            {navigationError}
          </p>
        ) : null}
        <CreditsCard
          credits={data.credits}
          billing={data.billing}
          onOpen={openExternal}
        />
        <AgentsCard agents={data.agents} />
        <ApiKeysCard apiKeys={data.apiKeys} onOpen={openExternal} />
      </div>
    </div>
  );
}

export default CloudView;
