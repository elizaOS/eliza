/**
 * Presents the installable contribution skill, latest work snapshot, and public
 * outcome ledger. GitHub-derived data is validated at the browser boundary so
 * a broken refresh renders as an error instead of a healthy-looking empty page.
 */

import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleAlert,
  Clipboard,
  ExternalLink,
  GitPullRequest,
  RotateCcw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { createInstallCommand } from "./lib/install-command";
import {
  assertLeaderboardSnapshot,
  type LeaderboardEntry,
  type LeaderboardSnapshot,
  type ScoreEvent,
  type WorkItem,
} from "./lib/leaderboard";

type InstallOptionId = "prompt" | "codex" | "claude";

interface InstallOption {
  id: InstallOptionId;
  label: string;
  command: string;
  note: string;
}

function currentSiteOrigin(): string {
  const origin = new URL(window.location.origin).origin.replace(/\/+$/u, "");
  if (!origin.startsWith("https://") && !origin.startsWith("http://")) {
    throw new Error(
      `[ElizaComputer] unsupported site origin protocol: ${origin}`,
    );
  }
  return origin;
}

function createInstallOptions(origin: string): readonly InstallOption[] {
  return [
    {
      id: "prompt",
      label: "No install",
      command: `Read ${origin}/mission.md and follow it exactly.`,
      note: "For agents that can read a public URL and use GitHub.",
    },
    {
      id: "codex",
      label: "Codex",
      command: createInstallCommand(
        origin,
        `\${CODEX_HOME:-\${HOME}/.codex}/skills`,
      ),
      note: "Verifies the GitHub revision, installs atomically, and keeps a rollback version.",
    },
    {
      id: "claude",
      label: "Claude Code",
      command: createInstallCommand(origin, `\${HOME}/.claude/skills`),
      note: "Verifies the revision and installs atomically without changing project instructions.",
    },
  ];
}

const WORKFLOW = [
  {
    number: "01",
    title: "Choose",
    body: "Read the issue or pull request, current discussion, and local rules. Claim one bounded job.",
  },
  {
    number: "02",
    title: "Finish",
    body: "Implement or review the real path. Add the tests needed to prove it works.",
  },
  {
    number: "03",
    title: "Prove",
    body: "Attach applicable logs, screenshots, video, trajectories, and outputs. Inspect every artifact.",
  },
  {
    number: "04",
    title: "Report",
    body: "Sync with develop, name the exact model and client in each GitHub message, and leave approval to another reviewer.",
  },
] as const;

type DataState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: LeaderboardSnapshot };

const LEDGER_REQUEST_TIMEOUT_MS = 12_000;
const LEDGER_AUTOMATIC_RETRIES = 1;
const SCORE_EVENT_PAGE_SIZE = 25;

function ExternalAnchor({
  children,
  className,
  href,
}: {
  children: ReactNode;
  className?: string;
  href: string;
}) {
  return (
    <a className={className} href={href} rel="noreferrer" target="_blank">
      {children}
    </a>
  );
}

function formatDate(value: string, includeTime = false): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    hour: includeTime ? "2-digit" : undefined,
    minute: includeTime ? "2-digit" : undefined,
    month: "short",
    timeZone: "UTC",
    timeZoneName: includeTime ? "short" : undefined,
    year: "numeric",
  }).format(date);
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: value >= 1000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function useLeaderboard(): [DataState, () => void] {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DataState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    let activeController: AbortController | null = null;
    let retryTimer: number | null = null;
    setState({ status: "loading" });

    const load = async (automaticAttempt: number): Promise<void> => {
      const controller = new AbortController();
      activeController = controller;
      const timeout = window.setTimeout(
        () => controller.abort(new Error("data request timed out")),
        LEDGER_REQUEST_TIMEOUT_MS,
      );
      try {
        const response = await fetch(
          `/data/leaderboard.json?attempt=${attempt}&retry=${automaticAttempt}`,
          {
            cache: "no-store",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          throw new Error(`data request returned ${response.status}`);
        }
        const data: unknown = await response.json();
        assertLeaderboardSnapshot(data);
        if (active) {
          setState({ status: "ready", snapshot: data });
        }
      } catch (error: unknown) {
        if (!active) {
          return;
        }
        if (automaticAttempt < LEDGER_AUTOMATIC_RETRIES) {
          retryTimer = window.setTimeout(
            () => void load(automaticAttempt + 1),
            500,
          );
          return;
        }
        // error-policy:J1 The browser data boundary renders transport, parse, timeout, and contract failures explicitly.
        setState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "the contribution data could not be read",
        });
      } finally {
        window.clearTimeout(timeout);
      }
    };
    void load(0);

    return () => {
      active = false;
      activeController?.abort();
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return [state, retry];
}

function InstallConsole() {
  const siteOrigin = useMemo(currentSiteOrigin, []);
  const installOptions = useMemo(
    () => createInstallOptions(siteOrigin),
    [siteOrigin],
  );
  const [selectedId, setSelectedId] = useState<InstallOptionId>("prompt");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const selected = installOptions.find((option) => option.id === selectedId);
  if (!selected) {
    throw new Error(`[ElizaComputer] unknown install option: ${selectedId}`);
  }

  useEffect(() => {
    if (copyState !== "copied") {
      return;
    }
    const resetTimer = window.setTimeout(() => setCopyState("idle"), 1800);
    return () => window.clearTimeout(resetTimer);
  }, [copyState]);

  const selectOption = useCallback(
    (option: InstallOption, focusTarget: boolean): void => {
      setSelectedId(option.id);
      setCopyState("idle");
      if (!focusTarget) {
        return;
      }
      const target = document.getElementById(`install-tab-${option.id}`);
      if (!(target instanceof HTMLButtonElement)) {
        throw new Error(
          `[ElizaComputer] install tab ${option.id} is missing from the document`,
        );
      }
      target.focus();
    },
    [],
  );

  const handleTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>): void => {
      const currentIndex = installOptions.findIndex(
        (option) => event.currentTarget.id === `install-tab-${option.id}`,
      );
      if (currentIndex === -1) {
        throw new Error(
          `[ElizaComputer] unknown install tab: ${event.currentTarget.id}`,
        );
      }

      let targetIndex: number;
      switch (event.key) {
        case "ArrowLeft":
          targetIndex =
            (currentIndex - 1 + installOptions.length) % installOptions.length;
          break;
        case "ArrowRight":
          targetIndex = (currentIndex + 1) % installOptions.length;
          break;
        case "Home":
          targetIndex = 0;
          break;
        case "End":
          targetIndex = installOptions.length - 1;
          break;
        default:
          return;
      }

      event.preventDefault();
      const targetOption = installOptions[targetIndex];
      if (!targetOption) {
        throw new Error(
          `[ElizaComputer] install tab index ${targetIndex} is unavailable`,
        );
      }
      selectOption(targetOption, true);
    },
    [installOptions, selectOption],
  );

  const copyCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(selected.command);
      setCopyState("copied");
    } catch {
      // error-policy:J4 Clipboard denial keeps the complete command visible for manual copying.
      setCopyState("error");
    }
  }, [selected]);

  return (
    <div className="install-console" id="install">
      <div className="console-bar">
        <span className="status-lamp" aria-hidden="true" />
        <span>contribution terminal</span>
        <span className="console-host">{siteOrigin}</span>
      </div>
      <div
        aria-label="Install method"
        aria-orientation="horizontal"
        className="install-tabs"
        role="tablist"
      >
        {installOptions.map((option) => (
          <button
            aria-controls="install-panel"
            aria-selected={selected.id === option.id}
            className="install-tab"
            id={`install-tab-${option.id}`}
            key={option.id}
            onClick={() => selectOption(option, false)}
            onKeyDown={handleTabKeyDown}
            role="tab"
            tabIndex={selected.id === option.id ? 0 : -1}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={`install-tab-${selected.id}`}
        className="install-panel"
        id="install-panel"
        role="tabpanel"
      >
        <section
          aria-label={`${selected.label} command`}
          className="install-command"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard focus is required to scroll long commands without a pointer.
          tabIndex={0}
        >
          <pre>
            <code>{selected.command}</code>
          </pre>
        </section>
        <button className="copy-button" onClick={copyCommand} type="button">
          {copyState === "copied" ? (
            <Check aria-hidden="true" />
          ) : (
            <Clipboard aria-hidden="true" />
          )}
          {copyState === "copied"
            ? "Copied"
            : copyState === "error"
              ? "Copy failed"
              : "Copy"}
        </button>
      </div>
      <p
        aria-atomic="true"
        aria-live="polite"
        className={`console-note ${copyState}`}
      >
        {copyState === "copied"
          ? `${selected.label} command copied to the clipboard.`
          : copyState === "error"
            ? "Clipboard access was unavailable. Select the command and copy it manually."
            : selected.note}
      </p>
      <div className="console-links">
        <a href="/codex.md">
          Install guide <ArrowUpRight aria-hidden="true" />
        </a>
        <a href="/skill.md">
          Read skill <ArrowUpRight aria-hidden="true" />
        </a>
        <a href="/downloads/contribute-to-eliza.skill" download>
          Download .skill <ArrowDownToLine aria-hidden="true" />
        </a>
        <ExternalAnchor href="https://github.com/elizaOS/eliza/tree/develop/packages/skills/skills/contribute-to-eliza">
          Inspect source <ArrowUpRight aria-hidden="true" />
        </ExternalAnchor>
      </div>
    </div>
  );
}

function OutcomeBreakdown({
  entry,
  events,
}: {
  entry: LeaderboardEntry;
  events: ScoreEvent[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [visibleEventCount, setVisibleEventCount] = useState(
    SCORE_EVENT_PAGE_SIZE,
  );
  const visibleEvents = events.slice(0, visibleEventCount);
  const outcomes = [
    ["Merged PRs", entry.acceptedOutcomes.mergedPullRequests],
    ["Resolved issues", entry.acceptedOutcomes.resolvedIssues],
    ["Material test changes", entry.acceptedOutcomes.materialTestChanges],
    ["Evidence categories", entry.acceptedOutcomes.evidenceCategories],
    ["Substantive reviews", entry.acceptedOutcomes.substantiveReviews],
  ] as const;
  return (
    <div>
      <ul className="outcome-breakdown">
        {outcomes.map(([label, value]) => (
          <li key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </li>
        ))}
      </ul>
      <details
        className="score-evidence"
        onToggle={(event) => {
          setExpanded(event.currentTarget.open);
          if (!event.currentTarget.open) {
            setVisibleEventCount(SCORE_EVENT_PAGE_SIZE);
          }
        }}
      >
        <summary>
          {events.length} linked score{" "}
          {events.length === 1 ? "event" : "events"}
        </summary>
        {expanded && events.length > 0 ? (
          <>
            <ol>
              {visibleEvents.map((event) => (
                <li key={event.id}>
                  <ExternalAnchor href={event.source.url}>
                    <strong>+{event.points}</strong>
                    <span>
                      {event.source.kind === "pull-request"
                        ? "PR"
                        : event.source.kind === "review"
                          ? "Review"
                          : "Issue"}{" "}
                      #{event.source.number}: {event.source.title}
                    </span>
                    <ArrowUpRight aria-hidden="true" />
                  </ExternalAnchor>
                  <p>{event.reason}</p>
                </li>
              ))}
            </ol>
            {visibleEvents.length < events.length ? (
              <button
                className="load-score-events"
                onClick={() =>
                  setVisibleEventCount((count) =>
                    Math.min(count + SCORE_EVENT_PAGE_SIZE, events.length),
                  )
                }
                type="button"
              >
                Show{" "}
                {Math.min(
                  SCORE_EVENT_PAGE_SIZE,
                  events.length - visibleEvents.length,
                )}{" "}
                more
              </button>
            ) : null}
          </>
        ) : expanded ? (
          <p className="missing-score-evidence">
            No score evidence is present in this snapshot.
          </p>
        ) : null}
      </details>
    </div>
  );
}

function Leaderboard({ snapshot }: { snapshot: LeaderboardSnapshot }) {
  const eventsByActor = useMemo(() => {
    const index = new Map<string, ScoreEvent[]>();
    for (const event of snapshot.ledger) {
      const events = index.get(event.actor.id) ?? [];
      events.push(event);
      index.set(event.actor.id, events);
    }
    return index;
  }, [snapshot.ledger]);
  if (snapshot.leaders.length === 0) {
    return (
      <div className="empty-state">
        <Sparkles aria-hidden="true" />
        <h3>No accepted work in this window.</h3>
        <p>Finish a contribution with proof to appear here.</p>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="leaderboard-table">
        <caption className="sr-only">
          elizaOS contribution leaders from 30-day merged outcomes and seven-day
          verified contribution bonuses
        </caption>
        <thead>
          <tr>
            <th id="leaderboard-rank" scope="col">
              Rank
            </th>
            <th id="leaderboard-contributor" scope="col">
              Contributor
            </th>
            <th id="leaderboard-outcomes" scope="col">
              Accepted outcomes
            </th>
            <th id="leaderboard-model" scope="col">
              Reported model
            </th>
            <th id="leaderboard-score" scope="col">
              Score
            </th>
          </tr>
        </thead>
        <tbody>
          {snapshot.leaders.slice(0, 25).map((entry) => (
            <tr key={entry.actor.id}>
              <td className="rank-cell" headers="leaderboard-rank">
                <span aria-hidden="true" className="mobile-cell-label">
                  Rank
                </span>
                <span>{String(entry.rank).padStart(2, "0")}</span>
              </td>
              <td headers="leaderboard-contributor">
                <span aria-hidden="true" className="mobile-cell-label">
                  Contributor
                </span>
                <ExternalAnchor className="contributor" href={entry.actor.url}>
                  <img
                    alt=""
                    height="40"
                    loading="lazy"
                    src={entry.actor.avatarUrl}
                    width="40"
                  />
                  <span>
                    <strong>@{entry.actor.login}</strong>
                    <small>GitHub profile</small>
                  </span>
                  <ExternalLink aria-hidden="true" />
                </ExternalAnchor>
              </td>
              <td headers="leaderboard-outcomes">
                <span aria-hidden="true" className="mobile-cell-label">
                  Accepted outcomes
                </span>
                <OutcomeBreakdown
                  entry={entry}
                  events={eventsByActor.get(entry.actor.id) ?? []}
                />
              </td>
              <td headers="leaderboard-model">
                <span aria-hidden="true" className="mobile-cell-label">
                  Reported model
                </span>
                {entry.reportedModels.length > 0 ? (
                  <div className="model-list">
                    {entry.reportedModels.map((model) => (
                      <code key={model}>{model}</code>
                    ))}
                    <small>self-reported</small>
                  </div>
                ) : (
                  <span className="missing-value">Not reported</span>
                )}
              </td>
              <td className="score-cell" headers="leaderboard-score">
                <span aria-hidden="true" className="mobile-cell-label">
                  Score
                </span>
                <strong>{entry.score}</strong>
                <span>pts</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorkQueue({ snapshot }: { snapshot: LeaderboardSnapshot }) {
  const [kind, setKind] = useState<"issues" | "pullRequests">("issues");
  const candidateCounts = {
    issues: snapshot.workQueue.issues.filter(
      (item) => item.selection.status === "candidate",
    ).length,
    pullRequests: snapshot.workQueue.pullRequests.filter(
      (item) => item.selection.status === "candidate",
    ).length,
  };
  const items = snapshot.workQueue[kind]
    .filter((item) => item.selection.status === "candidate")
    .slice(0, 8);

  return (
    <div className="queue-shell">
      <fieldset className="queue-tabs">
        <legend className="sr-only">Work queue type</legend>
        <button
          aria-pressed={kind === "issues"}
          onClick={() => setKind("issues")}
          type="button"
        >
          Issues <span>{candidateCounts.issues}</span>
        </button>
        <button
          aria-pressed={kind === "pullRequests"}
          onClick={() => setKind("pullRequests")}
          type="button"
        >
          Pull requests <span>{candidateCounts.pullRequests}</span>
        </button>
      </fieldset>
      {items.length === 0 ? (
        <div className="empty-state compact">
          <Check aria-hidden="true" />
          <h3>Nothing unclaimed is ready.</h3>
          <p>Check GitHub for the full queue.</p>
        </div>
      ) : (
        <ol className="work-list">
          {items.map((item) => (
            <WorkQueueItem item={item} key={item.id} />
          ))}
        </ol>
      )}
      <ExternalAnchor
        className="text-link"
        href={`https://github.com/elizaOS/eliza/${kind === "issues" ? "issues" : "pulls"}?q=is%3Aopen+sort%3Aupdated-desc`}
      >
        Inspect the full queue on GitHub <ArrowUpRight aria-hidden="true" />
      </ExternalAnchor>
    </div>
  );
}

function WorkQueueItem({ item }: { item: WorkItem }) {
  const evidenceLabel =
    item.evidence.status === "complete"
      ? "evidence complete"
      : item.evidence.status === "partial"
        ? `${item.evidence.points}/${item.evidence.maxPoints} evidence points`
        : "evidence missing";
  const modelLabel = {
    complete: `model coverage ${item.model.validSourceCount}/${item.model.eligibleSourceCount}`,
    invalid: `invalid attribution ${item.model.validSourceCount}/${item.model.eligibleSourceCount}`,
    missing:
      item.model.eligibleSourceCount === 0
        ? "no attribution-eligible activity"
        : `model missing ${item.model.validSourceCount}/${item.model.eligibleSourceCount}`,
    partial: `model coverage ${item.model.validSourceCount}/${item.model.eligibleSourceCount}`,
  }[item.model.status];
  const claimKind =
    item.claim.kind === null
      ? item.kind === "pull-request"
        ? "review"
        : "implementation"
      : item.claim.kind;
  const claimantNames = item.claim.actors
    .map((actor) => `@${actor.login}`)
    .join(", ");
  const claimLabel =
    item.claim.status === "claimed"
      ? `${claimKind} claimed${claimantNames.length > 0 ? ` by ${claimantNames}` : ""}`
      : `${claimKind} unclaimed`;

  return (
    <li>
      <ExternalAnchor href={item.url}>
        <div className="work-number">
          {item.kind === "pull-request" ? (
            <GitPullRequest aria-hidden="true" />
          ) : (
            <span aria-hidden="true">#</span>
          )}
          {item.number}
        </div>
        <div className="work-copy">
          <h3>{item.title}</h3>
          <div className="work-meta">
            <span className={`state-token ${item.claim.status}`}>
              {claimLabel}
            </span>
            <span className={`state-token ${item.actionability}`}>
              {item.actionability}
            </span>
            <span className={`state-token priority-${item.priority}`}>
              {item.priority} priority
            </span>
            <span className={`state-token ${item.evidence.status}`}>
              {evidenceLabel}
            </span>
            <span className={`state-token ${item.model.status}`}>
              {modelLabel}
            </span>
          </div>
          <div className="work-context">
            <time dateTime={item.updatedAt}>
              Updated {formatDate(item.updatedAt)}
            </time>
            <span>
              {item.commentCount}{" "}
              {item.commentCount === 1 ? "comment" : "comments"}
            </span>
            {item.claim.claimedAt ? (
              <time dateTime={item.claim.claimedAt}>
                Claimed {formatDate(item.claim.claimedAt)}
              </time>
            ) : null}
            {item.labels.slice(0, 3).map((label) => (
              <span className="work-label" key={label}>
                {label}
              </span>
            ))}
            {item.labels.length > 3 ? (
              <span>+{item.labels.length - 3} labels</span>
            ) : null}
          </div>
        </div>
        <ArrowUpRight aria-hidden="true" className="work-arrow" />
      </ExternalAnchor>
    </li>
  );
}

function Methodology({ snapshot }: { snapshot: LeaderboardSnapshot }) {
  return (
    <div className="methodology-grid">
      <div>
        <h3>What earns points</h3>
        <ol className="scoring-list">
          {snapshot.methodology.scoringRules.map((rule) => (
            <li key={rule.id}>
              <div>
                <strong>{rule.points}</strong>
                <span>{rule.id.replaceAll("-", " ")}</span>
              </div>
              <p>{rule.qualification}</p>
              <small>{rule.cap}</small>
            </li>
          ))}
        </ol>
      </div>
      <div className="methodology-notes">
        <div>
          <h3>Not scored</h3>
          <ul>
            {snapshot.methodology.nonScoringActivity.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3>Excluded</h3>
          <ul>
            {snapshot.methodology.exclusions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div className="provenance-note">
          <ShieldCheck aria-hidden="true" />
          <div>
            <h3>Model provenance</h3>
            <p>{snapshot.methodology.provenancePolicy}</p>
            <p className="provenance-stats">
              <strong>{snapshot.attributionCoverage.status}</strong> ·{" "}
              {snapshot.attributionCoverage.validSourceCount}/
              {snapshot.attributionCoverage.eligibleSourceCount} eligible
              sources attributed ·{" "}
              {snapshot.attributionCoverage.humanOnlySourceCount} declared
              human-only
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function DataError({
  announce = false,
  message,
  retry,
}: {
  announce?: boolean;
  message: string;
  retry: () => void;
}) {
  return (
    <div
      className="data-state error-state"
      role={announce ? "alert" : undefined}
    >
      <CircleAlert aria-hidden="true" />
      <div>
        <h3>The contribution snapshot did not load.</h3>
        <p>{message}. Try again.</p>
      </div>
      <button onClick={retry} type="button">
        <RotateCcw aria-hidden="true" /> Retry
      </button>
    </div>
  );
}

export function App() {
  const [dataState, retry] = useLeaderboard();
  const [clock, setClock] = useState(() => Date.now());
  const snapshot =
    dataState.status === "ready" ? dataState.snapshot : undefined;
  useEffect(() => {
    const updateClock = (): void => setClock(Date.now());
    const interval = window.setInterval(updateClock, 60_000);
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== "visible") {
        return;
      }
      const now = Date.now();
      setClock(now);
      if (
        snapshot &&
        now - Date.parse(snapshot.generatedAt) > 8 * 60 * 60 * 1000
      ) {
        retry();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [retry, snapshot]);
  const freshness = useMemo(() => {
    if (!snapshot) {
      return undefined;
    }
    const ageHours =
      (clock - Date.parse(snapshot.generatedAt)) / (60 * 60 * 1000);
    return ageHours > 8 ? "stale" : "fresh";
  }, [clock, snapshot]);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="site-header">
        <a aria-label="eliza.army home" className="wordmark" href="/">
          <img
            alt="eliza"
            height="30"
            src="/brand/logos/eliza_logotext.svg"
            width="122"
          />
          <span>.army</span>
        </a>
        <nav aria-label="Primary">
          <a href="#install">Install</a>
          <a href="#work">Work queue</a>
          <a href="#leaders">Leaderboard</a>
          <ExternalAnchor href="https://eliza.app/profile/edit">
            Payout address <ArrowUpRight aria-hidden="true" />
          </ExternalAnchor>
        </nav>
      </header>

      <main id="main">
        <section className="hero">
          <div className="trace" aria-hidden="true" />
          <div className="hero-copy">
            <p className="eyebrow">
              <span className="status-lamp" aria-hidden="true" />
              $10,000 monthly pool, paid in USDC
            </p>
            <h1>
              Earn money contributing to <em>open source.</em>
            </h1>
            <p className="hero-lede">
              Accepted elizaOS work can earn from the pool. Use your coding
              agent to finish issues and review pull requests.
            </p>
            <div className="hero-actions">
              <a className="button primary" href="#install">
                Run the skill <ArrowRight aria-hidden="true" />
              </a>
              <ExternalAnchor
                className="button secondary"
                href="https://eliza.app/profile/edit"
              >
                Set payout address <ArrowUpRight aria-hidden="true" />
              </ExternalAnchor>
            </div>
            <div className="wallet-note">
              <p>Add a public Solana or Ethereum address to receive USDC.</p>
              <small>
                The editor creates a README comment that is hidden when
                rendered; the address is still public. Never share a private key
                or seed phrase. Leaderboard points do not determine payouts.
              </small>
            </div>
          </div>
          <InstallConsole />
        </section>

        <section className="live-strip" aria-label="Snapshot status">
          {snapshot ? (
            <>
              <span className={`status-lamp ${freshness}`} aria-hidden="true" />
              <strong>
                {freshness === "fresh"
                  ? "Latest GitHub snapshot"
                  : "Snapshot update delayed"}
              </strong>
              <span>{snapshot.window.days}-day merged outcomes</span>
              <span>
                {snapshot.source.verificationWindow.days}-day proof review
              </span>
              <span>
                {compactNumber(snapshot.source.counts.openIssues)} open issues
              </span>
              <span>
                {compactNumber(snapshot.source.counts.openPullRequests)} open
                PRs
              </span>
              <span>Updated {formatDate(snapshot.generatedAt, true)}</span>
            </>
          ) : dataState.status === "error" ? (
            <>
              <span className="status-lamp failure" aria-hidden="true" />
              <strong>Snapshot unavailable</strong>
              <span>The installable skill remains available.</span>
            </>
          ) : (
            <>
              <span className="status-lamp loading" aria-hidden="true" />
              <strong>Loading the GitHub ledger</strong>
              <span>Validating the current snapshot…</span>
            </>
          )}
        </section>

        <section className="section workflow-section" id="workflow">
          <div className="section-heading">
            <h2>Ship work maintainers can merge.</h2>
            <p>Finish a scoped issue or independently review an open PR.</p>
          </div>
          <ol className="workflow-list">
            {WORKFLOW.map((step) => (
              <li key={step.number}>
                <span>{step.number}</span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="section" id="work">
          <div className="section-heading split">
            <div>
              <h2>Pick unfinished work.</h2>
            </div>
            <p>
              Shows contributor-ready work that was unclaimed at the last
              refresh. Confirm on GitHub before claiming.
            </p>
          </div>
          {dataState.status === "loading" ? (
            <div className="data-state loading-state" aria-live="polite">
              <span className="loader" aria-hidden="true" />
              <div>
                <h3>Loading work…</h3>
              </div>
            </div>
          ) : dataState.status === "error" ? (
            <DataError announce message={dataState.message} retry={retry} />
          ) : (
            <WorkQueue snapshot={dataState.snapshot} />
          )}
        </section>

        <section className="section leaderboard-section" id="leaders">
          <div className="section-heading split">
            <div>
              <h2>Accepted work, counted.</h2>
            </div>
            <p>
              Points come from merged PRs, resolved issues, tests, evidence, and
              substantive reviews. Every point links to GitHub.
            </p>
          </div>
          {dataState.status === "loading" ? (
            <div className="data-state loading-state" aria-live="polite">
              <span className="loader" aria-hidden="true" />
              <div>
                <h3>Loading accepted work…</h3>
              </div>
            </div>
          ) : dataState.status === "error" ? (
            <DataError message={dataState.message} retry={retry} />
          ) : (
            <Leaderboard snapshot={dataState.snapshot} />
          )}
        </section>

        <section className="section methodology-section" id="methodology">
          <div className="section-heading split">
            <div>
              <h2>How points work.</h2>
            </div>
            <p>
              Accepted outcomes score. Raw activity and model choice do not.
            </p>
          </div>
          {snapshot ? (
            <>
              <Methodology snapshot={snapshot} />
              <details className="methodology-footer">
                <summary>Data coverage</summary>
                <p>
                  Complete outcome coverage{" "}
                  {compactNumber(snapshot.source.counts.mergedPullRequests)}{" "}
                  merged PRs / {snapshot.window.days} days · complete
                  verification coverage{" "}
                  {compactNumber(
                    snapshot.source.counts.detailedMergedPullRequests,
                  )}{" "}
                  merged PRs +{" "}
                  {compactNumber(snapshot.source.counts.detailedClosedIssues)}{" "}
                  closed issues / {snapshot.source.verificationWindow.days} days
                  {" · "}
                  {snapshot.source.evidenceVerification.status ===
                  "suppressed-limit" ? (
                    <strong>
                      Evidence verification limited (
                      {snapshot.source.evidenceVerification.sourceCount}{" "}
                      sources,{" "}
                      {snapshot.source.evidenceVerification.artifactCount}{" "}
                      artifacts) — verified proof within the bound still scores
                    </strong>
                  ) : (
                    <>
                      evidence verification complete:{" "}
                      {snapshot.source.evidenceVerification.sourceCount}{" "}
                      sources,{" "}
                      {snapshot.source.evidenceVerification.artifactCount}{" "}
                      artifacts
                    </>
                  )}
                  · rule <code>{snapshot.ruleVersion}</code> · source cutoff{" "}
                  {formatDate(snapshot.source.cutoffAt, true)} ·{" "}
                  {snapshot.source.requestCount} GitHub GraphQL requests ·{" "}
                  {snapshot.invalidAttributionMarkers.length} invalid
                  attribution markers
                </p>
              </details>
            </>
          ) : dataState.status === "error" ? (
            <DataError message={dataState.message} retry={retry} />
          ) : (
            <div className="data-state loading-state" aria-live="polite">
              <span className="loader" aria-hidden="true" />
              <div>
                <h3>Loading the published scoring contract…</h3>
                <p>The rules ship inside the validated snapshot.</p>
              </div>
            </div>
          )}
        </section>
      </main>

      <footer>
        <div>
          <a aria-label="eliza.army home" className="wordmark" href="/">
            <img
              alt="eliza"
              height="30"
              src="/brand/logos/eliza_logotext.svg"
              width="122"
            />
            <span>.army</span>
          </a>
        </div>
        <div className="footer-links">
          <a href="/skill.md">Raw skill</a>
          <a href="/skill-manifest.json">Checksum + revision</a>
          <ExternalAnchor href="https://github.com/elizaOS/eliza/blob/develop/CONTRIBUTING.md">
            Contributing guide
          </ExternalAnchor>
          <ExternalAnchor href="https://github.com/elizaOS/eliza/blob/develop/LICENSE">
            MIT license
          </ExternalAnchor>
        </div>
      </footer>
    </>
  );
}
