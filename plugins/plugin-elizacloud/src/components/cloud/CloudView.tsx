/**
 * CloudView — the in-app "Cloud" launcher view: the user's Eliza Cloud account
 * at a glance (credits + top-up, hosted agents with status, API-key inventory,
 * billing summary) rendered app-native in the dark launcher aesthetic.
 *
 * Served as this plugin's `cloud` view bundle (`vite.config.views.ts`) and
 * mounted by the shell's DynamicViewLoader at `/cloud`, so it may import ONLY
 * host-external specifiers (react, `@elizaos/ui/api`) — console surfaces under
 * `@elizaos/ui/cloud/*` are not in the host-external map and cannot be reused
 * here. Data comes from the host `client` singleton's cloud wrappers, which
 * already handle steward-token auth, direct-cloud base resolution, and native
 * transport.
 *
 * State machine honors the repo three-state rule: loading / signed-out
 * (designed connect CTA) / error (with retry) / ready — and inside ready each
 * secondary section (agents, keys, billing) degrades to its own designed
 * "unavailable" note on fetch failure rather than a healthy-empty render.
 */

// Narrow host-external subpath: the `@elizaos/ui` barrel would drag every chat
// widget into the jsdom test graph for one singleton (the birdclaw lesson).
import { client } from "@elizaos/ui/api";
import type {
  CloudApiKeys,
  CloudBillingSummary,
  CloudCompatAgent,
  CloudCredits,
  CloudStatus,
} from "@elizaos/ui/api";
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

/** In-shell navigation: pushState + popstate, the launcher tile convention. */
function navigateTo(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// ---------------------------------------------------------------------------
// Load-state machine.
// ---------------------------------------------------------------------------

/** A secondary section either has data or a designed unavailable message. */
type Section<T> = { data: T; error: null } | { data: null; error: string };

interface ReadyData {
  status: CloudStatus;
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
        ? { data: agents.value.data ?? [], error: null }
        : { data: null, error: agents.value.error ?? "Agents are unavailable right now." }
      : { data: null, error: "Agents are unavailable right now." };

  return {
    kind: "ready",
    data: {
      status,
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

function Card(props: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card px-4 py-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-txt">{props.title}</h2>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}

function SectionNote(props: { message: string }) {
  return <p className="text-sm text-muted">{props.message}</p>;
}

function ExternalLink(props: { href: string; children: ReactNode }) {
  return (
    <a
      className="text-sm font-medium text-accent hover:underline"
      href={props.href}
      target="_blank"
      rel="noreferrer"
    >
      {props.children}
    </a>
  );
}

function agentStatusClass(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "running") return "text-ok";
  if (normalized === "error") return "text-danger";
  if (normalized === "provisioning" || normalized === "pending") return "text-warn";
  return "text-muted";
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

function AccountCard(props: { status: CloudStatus }) {
  const { status } = props;
  return (
    <Card
      title="Account"
      action={
        <span className="rounded-md bg-accent/12 px-2 py-0.5 text-xs font-medium text-accent">
          Connected
        </span>
      }
    >
      <dl className="space-y-1 text-sm">
        {status.organizationId ? (
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Organization</dt>
            <dd className="truncate text-txt" data-testid="cloud-org-id">
              {status.organizationId}
            </dd>
          </div>
        ) : null}
        {status.userId ? (
          <div className="flex justify-between gap-2">
            <dt className="text-muted">User</dt>
            <dd className="truncate text-txt">{status.userId}</dd>
          </div>
        ) : null}
      </dl>
    </Card>
  );
}

function CreditsCard(props: {
  credits: Section<CloudCredits>;
  billing: Section<CloudBillingSummary>;
}) {
  const { credits, billing } = props;
  if (!credits.data) {
    return (
      <Card title="Credits">
        <SectionNote message={credits.error} />
      </Card>
    );
  }
  const topUpUrl = credits.data.topUpUrl ?? billing.data?.topUpUrl;
  return (
    <Card
      title="Credits"
      action={topUpUrl ? <ExternalLink href={topUpUrl}>Top up</ExternalLink> : undefined}
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
    </Card>
  );
}

function AgentsCard(props: { agents: Section<CloudCompatAgent[]> }) {
  const { agents } = props;
  return (
    <Card title="Hosted agents">
      {agents.data === null ? (
        <SectionNote message={agents.error} />
      ) : agents.data.length === 0 ? (
        <SectionNote message="No hosted agents yet. Ask me to create one, or provision from the console." />
      ) : (
        <ul className="space-y-2" data-testid="cloud-agent-list">
          {agents.data.map((agent) => (
            <li
              key={agent.agent_id}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2"
            >
              <span className="truncate text-sm text-txt">{agent.agent_name}</span>
              <span className={`text-xs font-medium ${agentStatusClass(agent.status)}`}>
                {agent.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ApiKeysCard(props: { apiKeys: Section<CloudApiKeys> }) {
  const { apiKeys } = props;
  if (apiKeys.data === null) {
    return (
      <Card title="API keys">
        <SectionNote message={apiKeys.error} />
      </Card>
    );
  }
  const { keys, manageUrl, reason } = apiKeys.data;
  return (
    <Card
      title="API keys"
      action={<ExternalLink href={manageUrl}>Manage</ExternalLink>}
    >
      {keys === null ? (
        <SectionNote
          message={
            reason === "session-required"
              ? "API keys can only be listed from a signed-in session — manage them in the console."
              : "Sign in to Eliza Cloud to see your API keys."
          }
        />
      ) : (
        <p className="text-sm text-txt" data-testid="cloud-api-key-count">
          {keys.length === 1 ? "1 API key" : `${keys.length} API keys`}
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// View.
// ---------------------------------------------------------------------------

export interface CloudViewProps {
  /** Test/host injection seam. Defaults to the host `client` cloud wrappers. */
  fetchers?: CloudViewFetchers;
}

export function CloudView(props: CloudViewProps = {}): ReactNode {
  const fetchers = props.fetchers ?? defaultFetchers;
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const fetchersRef = useRef(fetchers);
  fetchersRef.current = fetchers;

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
      <div className="flex h-full items-center justify-center bg-bg" data-testid="cloud-loading">
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
          Connect your Eliza Cloud account to see credits, hosted agents, API
          keys, and billing here.
        </p>
        <button
          type="button"
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white"
          onClick={() => navigateTo("/settings")}
        >
          Connect in Settings
        </button>
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
        <button
          type="button"
          className="rounded-md border border-border bg-surface px-4 py-2 text-sm font-medium text-txt"
          onClick={() => load()}
        >
          Retry
        </button>
      </div>
    );
  }

  const { data } = state;
  return (
    <div className="h-full overflow-y-auto bg-bg" data-testid="cloud-ready">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-6">
        <h1 className="text-lg font-semibold text-txt">Eliza Cloud</h1>
        <AccountCard status={data.status} />
        <CreditsCard credits={data.credits} billing={data.billing} />
        <AgentsCard agents={data.agents} />
        <ApiKeysCard apiKeys={data.apiKeys} />
      </div>
    </div>
  );
}

export default CloudView;
