/**
 * Exercises the user-visible data states and install interaction with a
 * contract-valid snapshot rather than bypassing the production validator.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { snapshotFixture } from "./fixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mockFetch(response: Response) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => response.clone());
}

describe("App", () => {
  it("renders validated queue, score breakdown, and model provenance", async () => {
    mockFetch(
      new Response(JSON.stringify(snapshotFixture()), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );

    render(<App />);

    expect(
      screen.getByRole("heading", {
        name: /earn money contributing to open source/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/\$10,000 monthly pool, paid in USDC/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /set payout address/i }),
    ).toHaveAttribute("href", "https://eliza.app/profile/edit");
    expect(
      screen.getByText(/public Solana or Ethereum address to receive USDC/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/README comment that is hidden when rendered/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/address is still public/i)).toBeInTheDocument();
    expect(screen.getByText(/never share a private key/i)).toBeInTheDocument();
    expect(screen.getByText(/seed phrase/i)).toBeInTheDocument();
    expect(
      screen.getByText(/leaderboard points do not determine payouts/i),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Launch the eliza.army contribution protocol"),
    ).toBeInTheDocument();
    expect(screen.getByText("7-day proof review")).toBeInTheDocument();
    expect(
      screen.getByText(
        /complete verification coverage 1 merged PRs \+ 1 closed issues/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /evidence verification complete: 1 sources, 3 artifacts/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("@finish-line")).toBeInTheDocument();
    expect(screen.getByText("openai/gpt-5")).toBeInTheDocument();
    expect(screen.getByText("24")).toBeInTheDocument();
    expect(screen.getByText("self-reported")).toBeInTheDocument();
  });

  it("explains bounded evidence verification without hiding retained scores", async () => {
    const snapshot = snapshotFixture();
    snapshot.source.evidenceVerification = {
      status: "suppressed-limit",
      sourceCount: 65,
      artifactCount: 70,
      maxSources: 64,
      maxArtifacts: 64,
    };
    mockFetch(
      new Response(JSON.stringify(snapshot), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );

    render(<App />);

    expect(
      await screen.findByText(
        /evidence verification limited \(65 sources, 70 artifacts\) — verified proof within the bound still scores/i,
      ),
    ).toBeInTheDocument();
  });

  it("qualifies the reward in detached social metadata", () => {
    const indexHtml = readFileSync(resolve("index.html"), "utf8");

    expect(indexHtml).toContain(
      "Accepted elizaOS work can earn from a $10,000 monthly pool paid in USDC.",
    );
    expect(indexHtml).not.toContain(
      "offers $10,000 in USDC to contributors each month",
    );
  });

  it("switches install clients and reports successful copy", async () => {
    mockFetch(
      new Response(JSON.stringify(snapshotFixture()), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
    expect(screen.getByText(/SKILLS_ROOT=/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const command = writeText.mock.calls[0][0];
    expect(command).toContain("set -eu");
    expect(command).toContain("trap 'exit 1' HUP INT TERM");
    expect(command).toContain("http://localhost:3000");
    expect(command).toContain("https://api.github.com");
    expect(command).toContain("https://raw.githubusercontent.com");
    expect(command).not.toContain("GITHUB_API_ORIGIN");
    expect(command).not.toContain("GITHUB_RAW_ORIGIN");
    expect(command).toContain("python3 is required");
    expect(command).toContain("max_archive_bytes = 10_485_760");
    expect(command).toContain("max_archive_entries = 33");
    expect(command).toContain("max_source_files = 32");
    expect(command).toContain("max_entry_bytes = 1_048_576");
    expect(command).toContain("max_total_bytes = 4_194_304");
    expect(command).toContain("zlib.decompressobj(-zlib.MAX_WBITS)");
    expect(command).toContain("local and central archive metadata disagree");
    expect(command).toContain("actual extracted size exceeds limit");
    expect(command).toContain(
      "archive size or CRC metadata does not match payload",
    );
    expect(command).toContain("skill provenance file manifest is incomplete");
    expect(command).toContain("working-tree provenance cannot be installed");
    expect(command).toContain("git/ref/heads/develop");
    expect(command).toContain("eliza-army-release-candidate");
    expect(command).toContain("GitHub's canonical skill file list");
    expect(command).toContain("compare_is_ancestor");
    expect(command).toContain("another skill install, update, or rollback");
    expect(command).toContain("os.replace(temporary_link, target_path)");
    expect(command).toContain("ELIZA_ARMY_SKILL_OPERATION");
    expect(command).toContain("ELIZA_ARMY_SKILL_REVISION");
    expect(command).toContain(
      `SKILLS_ROOT="\${CODEX_HOME:-\${HOME}/.codex}/skills"`,
    );
    expect(command).not.toContain('SKILLS_ROOT="\\${CODEX_HOME');
    expect(
      screen.getByRole("link", { name: /install guide/i }),
    ).toHaveAttribute("href", "/codex.md");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeVisible();
  });

  it("does not label ordinary discussion as missing model attribution", async () => {
    const snapshot = snapshotFixture();
    snapshot.workQueue.issues[0].model = {
      status: "missing",
      identifiers: [],
      machineMarkerCount: 0,
      invalidMarkerCount: 0,
      eligibleSourceCount: 0,
      validSourceCount: 0,
      missingSourceCount: 0,
      invalidSourceCount: 0,
      humanOnlySourceCount: 0,
      provenance: "none",
    };
    mockFetch(
      new Response(JSON.stringify(snapshot), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );

    render(<App />);

    expect(
      await screen.findByText("no attribution-eligible activity"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/model missing 0\/0/i)).not.toBeInTheDocument();
  });

  it("does not render work excluded by the shared candidate safety contract", async () => {
    const snapshot = snapshotFixture();
    const candidate = snapshot.workQueue.issues[0];
    snapshot.workQueue.issues.push({
      ...structuredClone(candidate),
      id: "I_bot",
      number: 17328,
      title: "Automated issue that must not be advertised",
      url: "https://github.com/elizaOS/eliza/issues/17328",
      author: {
        id: "BOT_fixture",
        login: "automation-bot",
        avatarUrl: "https://avatars.githubusercontent.com/u/2?v=4",
        url: "https://github.com/apps/automation-bot",
        kind: "Bot",
      },
      selection: {
        status: "excluded",
        reasons: ["bot-authored"],
      },
    });
    snapshot.source.counts.openIssues = 2;
    mockFetch(
      new Response(JSON.stringify(snapshot), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );

    render(<App />);

    expect(
      await screen.findByText("Launch the eliza.army contribution protocol"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Automated issue that must not be advertised"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /issues 1/i })).toBeVisible();
  });

  it("renders an observable error and retries instead of fabricating empty data", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("still unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(snapshotFixture()), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      );

    render(<App />);

    const alerts = await screen.findAllByRole("alert");
    expect(alerts[0]).toHaveTextContent("did not load");
    expect(alerts[0]).toHaveTextContent("Try again");
    fireEvent.click(screen.getAllByRole("button", { name: /retry/i })[0]);

    expect(
      await screen.findByText("Launch the eliza.army contribution protocol"),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects a structurally invalid snapshot at the browser boundary", async () => {
    mockFetch(
      new Response(
        JSON.stringify({
          ...snapshotFixture(),
          repository: "another/repository",
        }),
        { status: 200 },
      ),
    );

    render(<App />);

    const alerts = await screen.findAllByRole("alert");
    expect(alerts[0]).toHaveTextContent(
      "snapshot.repository must be elizaOS/eliza",
    );
    expect(screen.queryByText("@finish-line")).not.toBeInTheDocument();
  });

  it("times out stalled requests, retries once, and exposes the failure", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("fetch signal is required"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(signal.reason ?? new Error("request aborted")),
            { once: true },
          );
        }),
    );

    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(12_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole("alert")[0]).toHaveTextContent(
      "data request timed out",
    );
  });

  it("ages a current snapshot to delayed while the page remains open", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-07-31T12:00:00.000Z");
    vi.setSystemTime(now);
    const snapshot = snapshotFixture();
    const almostStale = new Date(
      now.getTime() - (8 * 60 - 1) * 60_000,
    ).toISOString();
    snapshot.generatedAt = almostStale;
    snapshot.sourceUpdatedAt = almostStale;
    snapshot.source.fetchedAt = almostStale;
    for (const item of [
      ...snapshot.workQueue.issues,
      ...snapshot.workQueue.pullRequests,
    ]) {
      item.createdAt = almostStale;
      item.updatedAt = almostStale;
    }
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => structuredClone(snapshot),
    } as Response);

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Latest GitHub snapshot")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60_000);
    });
    expect(screen.getByText("Snapshot update delayed")).toBeInTheDocument();
  });

  it("progressively reveals a large score ledger in bounded pages", async () => {
    const snapshot = snapshotFixture();
    const leader = snapshot.leaders[0];
    snapshot.ledger = Array.from({ length: 30 }, (_, index) => ({
      id: `PR_fixture:evidence:fixture-${index}`,
      actor: leader.actor,
      category: "evidence" as const,
      points: 1,
      source: {
        id: "PR_fixture",
        kind: "pull-request" as const,
        number: 17327,
        title: `Evidence event ${index + 1}`,
        url: "https://github.com/elizaOS/eliza/pull/17327",
      },
      reason: "Concrete screenshot evidence was attached.",
    }));
    leader.score = 30;
    leader.points = {
      mergedPullRequests: 0,
      resolvedIssues: 0,
      materialTestChanges: 0,
      evidence: 30,
      substantiveReviews: 0,
    };
    leader.acceptedOutcomes = {
      mergedPullRequests: 0,
      resolvedIssues: 0,
      materialTestChanges: 0,
      evidenceCategories: 30,
      substantiveReviews: 0,
    };
    mockFetch(
      new Response(JSON.stringify(snapshot), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );

    render(<App />);
    const summary = await screen.findByText("30 linked score events");
    fireEvent.click(summary);
    const evidence = summary.closest("details");
    if (!evidence) {
      throw new Error("score evidence details are missing");
    }
    fireEvent(evidence, new Event("toggle", { bubbles: true }));
    await waitFor(() =>
      expect(within(evidence).getAllByRole("link")).toHaveLength(25),
    );
    fireEvent.click(
      within(evidence).getByRole("button", { name: "Show 5 more" }),
    );
    expect(within(evidence).getAllByRole("link")).toHaveLength(30);
  });
});
