/**
 * Exercises the cloud deploy freshness guard (#14083): stale zombie-run deploys
 * must be skipped, but every ambiguous signal must fail open and deploy.
 */
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decideDeployFreshness,
  fetchServedCommit,
  parseServedCommit,
} from "../cloud/deploy-freshness-guard.mjs";
import { isAncestor } from "../cloud/deploy-freshness-guard-cli.mjs";

const RUN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SERVED = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("decideDeployFreshness — the narrow SKIP case", () => {
  it("SKIPS when the run SHA is an ancestor of the served commit (stale zombie run)", () => {
    const result = decideDeployFreshness({
      runSha: RUN,
      servedCommit: SERVED,
      isAncestor: () => true,
    });
    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("stale_run");
    expect(result.runSha).toBe(RUN);
    expect(result.servedCommit).toBe(SERVED);
  });
});

describe("decideDeployFreshness — fail-open (DEPLOY) on every ambiguous state", () => {
  it("deploys when the run SHA is NOT an ancestor (run is newer/divergent)", () => {
    const result = decideDeployFreshness({
      runSha: RUN,
      servedCommit: SERVED,
      isAncestor: () => false,
    });
    expect(result.decision).toBe("deploy");
    expect(result.reason).toBe("run_is_newer");
  });

  it("deploys when ancestry is undeterminable (unrelated histories / git error)", () => {
    const result = decideDeployFreshness({
      runSha: RUN,
      servedCommit: SERVED,
      isAncestor: () => null,
    });
    expect(result.decision).toBe("deploy");
    expect(result.reason).toBe("ancestry_unknown");
  });

  it("deploys when isAncestor THROWS (never lets a git crash block a deploy)", () => {
    const result = decideDeployFreshness({
      runSha: RUN,
      servedCommit: SERVED,
      isAncestor: () => {
        throw new Error("git blew up");
      },
    });
    expect(result.decision).toBe("deploy");
    expect(result.reason).toBe("ancestry_unknown");
  });

  it("deploys when there is no served commit (first deploy / unstamped build)", () => {
    const result = decideDeployFreshness({
      runSha: RUN,
      servedCommit: null,
      isAncestor: () => {
        throw new Error("should not be called");
      },
    });
    expect(result.decision).toBe("deploy");
    expect(result.reason).toBe("no_served_commit");
  });

  it("deploys when there is no run SHA", () => {
    const result = decideDeployFreshness({
      runSha: "   ",
      servedCommit: SERVED,
      isAncestor: () => {
        throw new Error("should not be called");
      },
    });
    expect(result.decision).toBe("deploy");
    expect(result.reason).toBe("no_run_sha");
  });

  it("deploys (idempotent) when run SHA equals served commit — never skip a same-commit redeploy", () => {
    const result = decideDeployFreshness({
      runSha: RUN,
      servedCommit: RUN,
      isAncestor: () => {
        throw new Error("should not be called");
      },
    });
    expect(result.decision).toBe("deploy");
    expect(result.reason).toBe("same_commit");
  });
});

describe("decideDeployFreshness — force bypass", () => {
  it("deploys with --force even when the run SHA is stale (intentional rollback)", () => {
    const result = decideDeployFreshness({
      runSha: RUN,
      servedCommit: SERVED,
      force: true,
      isAncestor: () => true, // would otherwise SKIP
    });
    expect(result.decision).toBe("deploy");
    expect(result.reason).toBe("forced");
  });

  it("force short-circuits before touching isAncestor", () => {
    let called = false;
    const result = decideDeployFreshness({
      runSha: RUN,
      servedCommit: SERVED,
      force: true,
      isAncestor: () => {
        called = true;
        return true;
      },
    });
    expect(result.decision).toBe("deploy");
    expect(called).toBe(false);
  });
});

describe("parseServedCommit", () => {
  it("extracts the commit from a valid renderer manifest body", () => {
    const body = JSON.stringify({
      schema: "elizaos.renderer.build/v1",
      buildId: "deadbeef",
      commit: SERVED,
    });
    expect(parseServedCommit(body)).toBe(SERVED);
  });

  it("trims surrounding whitespace on the commit", () => {
    expect(parseServedCommit(JSON.stringify({ commit: `  ${SERVED}  ` }))).toBe(
      SERVED,
    );
  });

  it("returns null for a manifest with no commit field (unstamped build)", () => {
    expect(parseServedCommit(JSON.stringify({ buildId: "x" }))).toBeNull();
  });

  it("returns null for a blank/whitespace commit", () => {
    expect(parseServedCommit(JSON.stringify({ commit: "   " }))).toBeNull();
    expect(parseServedCommit(JSON.stringify({ commit: null }))).toBeNull();
  });

  it("returns null for unparseable / empty / non-object bodies (SPA index.html fallthrough)", () => {
    expect(parseServedCommit("<!doctype html><html></html>")).toBeNull();
    expect(parseServedCommit("")).toBeNull();
    expect(parseServedCommit("   ")).toBeNull();
    expect(parseServedCommit(JSON.stringify("a string"))).toBeNull();
    expect(parseServedCommit(JSON.stringify(42))).toBeNull();
    // @ts-expect-error deliberately wrong type
    expect(parseServedCommit(undefined)).toBeNull();
  });
});

describe("fetchServedCommit — fail-open network boundary", () => {
  it("returns the commit on a 200 with a valid manifest", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      text: async () => JSON.stringify({ commit: SERVED }),
    })) as unknown as typeof fetch;
    expect(
      await fetchServedCommit("https://staging.elizacloud.ai", { fetchImpl }),
    ).toBe(SERVED);
  });

  it("requests the manifest at /eliza-renderer-build.json and strips trailing slashes", async () => {
    let requested = "";
    const fetchImpl = (async (url: string) => {
      requested = url;
      return { ok: true, text: async () => JSON.stringify({ commit: SERVED }) };
    }) as unknown as typeof fetch;
    await fetchServedCommit("https://staging.elizacloud.ai///", { fetchImpl });
    expect(requested).toBe(
      "https://staging.elizacloud.ai/eliza-renderer-build.json",
    );
  });

  it("can request the Worker health stamp path", async () => {
    let requested = "";
    const fetchImpl = (async (url: string) => {
      requested = url;
      return { ok: true, text: async () => JSON.stringify({ commit: SERVED }) };
    }) as unknown as typeof fetch;
    await fetchServedCommit("https://api-staging.elizacloud.ai", {
      fetchImpl,
      stampPath: "/api/health",
    });
    expect(requested).toBe("https://api-staging.elizacloud.ai/api/health");
  });

  it("returns null on a non-OK response (404 -> deploy, don't block)", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      text: async () => "not found",
    })) as unknown as typeof fetch;
    expect(
      await fetchServedCommit("https://staging.elizacloud.ai", { fetchImpl }),
    ).toBeNull();
  });

  it("returns null when fetch throws (network error / timeout)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(
      await fetchServedCommit("https://staging.elizacloud.ai", { fetchImpl }),
    ).toBeNull();
  });

  it("returns null for a blank base URL", async () => {
    expect(await fetchServedCommit("")).toBeNull();
  });
});

describe("isAncestor — shallow checkout hydration", () => {
  it("detects an old stale run beyond the initial shallow fetch depth", () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-freshness-guard-"));
    const origin = join(root, "origin");
    const clone = join(root, "clone");
    const previousCwd = process.cwd();

    try {
      execFileSync("git", ["init", origin], { stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: origin,
      });
      execFileSync("git", ["config", "user.name", "Deploy Guard Test"], {
        cwd: origin,
      });

      const commits: string[] = [];
      for (let i = 0; i < 70; i += 1) {
        writeFileSync(join(origin, "stamp.txt"), `${i}\n`);
        execFileSync("git", ["add", "stamp.txt"], { cwd: origin });
        execFileSync("git", ["commit", "-m", `commit ${i}`], {
          cwd: origin,
          stdio: "ignore",
        });
        commits.push(
          execFileSync("git", ["rev-parse", "HEAD"], { cwd: origin })
            .toString()
            .trim(),
        );
      }

      execFileSync("git", ["clone", "--depth=1", `file://${origin}`, clone], {
        stdio: "ignore",
      });
      process.chdir(clone);

      expect(isAncestor(commits[0], commits.at(-1) ?? "")).toBe(true);
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});
