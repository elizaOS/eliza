/**
 * Exercises the read-only exact-SHA release-authority check (#27229) against
 * real local HTTP servers: healthy-but-unattested, split, and off-canonical
 * trees must fail closed; one attested exact tree passes.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  checkReleaseAuthority,
  decideReleaseAuthority,
  ReleaseAuthorityError,
} from "../release-authority-drift.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

type Server = ReturnType<typeof Bun.serve>;
const servers: Server[] = [];

function serveStamp(body: string | null, status = 200): string {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (
        body === null ||
        (pathname !== "/api/health" &&
          pathname !== "/eliza-renderer-build.json")
      ) {
        return new Response("not found", { status: 404 });
      }
      return new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function target(workerCommit: string | null, pagesCommits: string[]) {
  return {
    canonicalRef: "refs/heads/staging",
    worker: serveStamp(
      workerCommit === null
        ? null
        : JSON.stringify({ commit: workerCommit, environment: "staging" }),
    ),
    pages: pagesCommits.map((commit) =>
      serveStamp(
        JSON.stringify({ schema: "elizaos.renderer.build/v1", commit }),
      ),
    ),
  };
}

describe("checkReleaseAuthority over live HTTP stamps", () => {
  it("passes one exact attested tree", async () => {
    const report = await checkReleaseAuthority({
      environment: "staging",
      expectedSha: A,
      target: target(A, [A, A]),
      isOnCanonical: (commit, ref) =>
        commit === A && ref === "refs/heads/staging",
    });
    expect(report.ok).toBe(true);
    expect(report.reasons).toEqual([]);
    expect(report.servedCommit).toBe(A);
    expect(report.onCanonical).toBe(true);
  });

  it("fails a Pages/Worker split even when every surface is healthy", async () => {
    const report = await checkReleaseAuthority({
      environment: "staging",
      target: target(A, [A, B]),
      isOnCanonical: () => true,
    });
    expect(report.ok).toBe(false);
    expect(report.reasons).toContain("pages_worker_split");
    expect(report.servedCommit).toBeNull();
  });

  it("fails an unattested upload that is off the canonical branch", async () => {
    const report = await checkReleaseAuthority({
      environment: "staging",
      target: target(B, [B, B]),
      isOnCanonical: () => false,
    });
    expect(report.ok).toBe(false);
    expect(report.reasons).toEqual(["served_commit_off_canonical"]);
  });

  it("fails closed when canonical membership cannot be proven", async () => {
    const report = await checkReleaseAuthority({
      environment: "staging",
      target: target(A, [A]),
      isOnCanonical: () => {
        throw new Error("remote unavailable");
      },
    });
    expect(report.ok).toBe(false);
    expect(report.reasons).toEqual(["canonical_membership_unknown"]);
  });

  it("fails when the served tree is not the expected release", async () => {
    const report = await checkReleaseAuthority({
      environment: "staging",
      expectedSha: B,
      target: target(A, [A]),
      isOnCanonical: () => true,
    });
    expect(report.reasons).toEqual(["served_commit_not_expected"]);
  });

  it("fails when a stamp is missing instead of treating it as healthy", async () => {
    const report = await checkReleaseAuthority({
      environment: "staging",
      target: target(null, [A]),
      isOnCanonical: () => true,
    });
    expect(report.ok).toBe(false);
    expect(report.reasons).toContain("worker_commit_missing");
    expect(report.reasons).toContain("worker_environment_mismatch");
  });

  it("rejects an unsupported environment with a typed error", async () => {
    await expect(
      checkReleaseAuthority({
        // @ts-expect-error deliberately unsupported
        environment: "preview",
      }),
    ).rejects.toBeInstanceOf(ReleaseAuthorityError);
  });
});

describe("decideReleaseAuthority", () => {
  it("records only commits, hostnames and closed reason codes", () => {
    const report = decideReleaseAuthority({
      environment: "staging",
      worker: {
        url: "https://api-staging.eliza.app",
        commit: A,
        environment: "production",
      },
      pages: [{ url: "https://staging.eliza.app", commit: A }],
      onCanonical: true,
    });
    expect(report.reasons).toEqual(["worker_environment_mismatch"]);
    expect(Object.keys(report).sort()).toEqual(
      [
        "environment",
        "expectedSha",
        "ok",
        "onCanonical",
        "pages",
        "reasons",
        "schema",
        "servedCommit",
        "worker",
      ].sort(),
    );
  });
});
