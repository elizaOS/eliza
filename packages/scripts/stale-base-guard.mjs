#!/usr/bin/env node
/**
 * Stale-base guard (#11376 final acceptance criterion).
 *
 * Blocks the PR #11271 failure mode: a PR whose commits carry stale file
 * contents (an old checkout committed onto a fresh-looking base) so that
 * merging it silently reverts work already merged on the target branch.
 * #11271's merge-base was only 8 minutes old — the staleness was inside the
 * PR's own tree — so a merge-base age check alone can never catch it. This
 * guard therefore runs a content-level detection plus a backstop:
 *
 * (Files the PR leaves untouched relative to its merge-base are safe by
 * construction: GitHub's squash/merge machinery three-way-merges, so a
 * base-side-only change always keeps the target branch's version. The
 * dangerous reverts are always inside the PR's own diff — verified against
 * the real #11271 squash, whose 304-file diff contained every revert.)
 *
 * 1. SILENT-REVERT DETECTION (the core). For every file the PR modifies or
 *    deletes, walk the target branch's first-parent history (bounded window)
 *    and flag the file when the PR's final blob is byte-identical to an OLDER
 *    historical blob — i.e. the PR discards newer merged work by restoring a
 *    previous version. A file is NOT flagged when the target's current blob
 *    is itself a re-occurrence of an even older blob than the one the PR
 *    restores (the "heal" case: develop is sitting on clobbered content and
 *    the PR restores the newer work — e.g. the #11427/#11430/#11433 re-land
 *    PRs). Files the PR adds are never flagged: no merged work can be lost by
 *    an addition.
 *
 *    Deletions of recently-added files match this shape too (the pre-add
 *    state is "absent"), but deliberate reworks legitimately delete young
 *    files (live example: PR #11523 deleting tests #11174 added hours
 *    earlier). A byte-identical *modification* revert, by contrast, is never
 *    produced by honest editing. So deletion findings only BLOCK when at
 *    least one modification-revert corroborates the stale-tree signature
 *    (a stale checkout reverts modified files en masse — #11271 had 200+);
 *    deletion-only findings surface as loud non-blocking notices.
 *
 * 2. STALENESS BACKSTOP. Fail when the merge-base is further behind the
 *    target tip than --max-behind-commits (first-parent) or
 *    --max-behind-hours (committer time).
 *
 * Override: the `stale-base-ack` label (--ack) downgrades failures to loud
 * warnings — for deliberate revert PRs.
 *
 * Plumbing-only (oid comparisons, no blob content reads): works in a blobless
 * (--filter=blob:none) shallow clone; the history walk stops gracefully at a
 * shallow boundary.
 *
 * Usage:
 *   node packages/scripts/stale-base-guard.mjs \
 *     --base <target-tip-ref> --head <pr-head-ref> \
 *     [--merge-base <ref>] [--window 1200] \
 *     [--max-behind-commits 200] [--max-behind-hours 72] \
 *     [--ack] [--github] [--summary <path>] [--json <path>] [--repo <dir>]
 *
 * Exit codes: 0 = pass (or acked), 1 = findings, 2 = usage/internal error.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const RAW_STATUS_CANDIDATES = new Set(["M", "D", "T"]);
const MAX_INLINE_ANNOTATIONS = 20;
const PATHSPEC_CHUNK = 500;

function parseArgs(argv) {
  const args = {
    window: 1200,
    maxBehindCommits: 200,
    maxBehindHours: 72,
    ack: false,
    github: false,
    repo: process.cwd(),
    json: null,
    summary: null,
    base: null,
    head: null,
    mergeBase: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[i];
    };
    switch (a) {
      case "--base":
        args.base = next();
        break;
      case "--head":
        args.head = next();
        break;
      case "--merge-base":
        args.mergeBase = next();
        break;
      case "--window":
        args.window = Number(next());
        break;
      case "--max-behind-commits":
        args.maxBehindCommits = Number(next());
        break;
      case "--max-behind-hours":
        args.maxBehindHours = Number(next());
        break;
      case "--ack":
        args.ack = true;
        break;
      case "--github":
        args.github = true;
        break;
      case "--json":
        args.json = next();
        break;
      case "--summary":
        args.summary = next();
        break;
      case "--repo":
        args.repo = next();
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!args.base || !args.head) {
    throw new Error("--base and --head are required");
  }
  for (const [name, v] of [
    ["--window", args.window],
    ["--max-behind-commits", args.maxBehindCommits],
    ["--max-behind-hours", args.maxBehindHours],
  ]) {
    if (!Number.isFinite(v) || v < 0)
      throw new Error(`${name} must be a non-negative number`);
  }
  return args;
}

function git(repo, gitArgs, { allowFail = false } = {}) {
  const res = spawnSync("git", gitArgs, {
    cwd: repo,
    encoding: "buffer",
    maxBuffer: 1024 * 1024 * 512,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    if (allowFail) return null;
    throw new Error(
      `git ${gitArgs.join(" ")} exited ${res.status}: ${res.stderr.toString("utf8").trim()}`,
    );
  }
  return res.stdout;
}

function gitText(repo, gitArgs, opts) {
  const out = git(repo, gitArgs, opts);
  return out === null ? null : out.toString("utf8").trim();
}

const isNullOid = (oid) => /^0+$/.test(oid);
const oidEq = (a, b) => {
  const aNull = isNullOid(a);
  const bNull = isNullOid(b);
  if (aNull || bNull) return aNull && bNull;
  return a === b;
};

/** Parse `git {diff,log} --raw -z --no-abbrev` token streams. */
function splitNul(buf) {
  const tokens = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      tokens.push(buf.subarray(start, i).toString("utf8"));
      start = i + 1;
    }
  }
  if (start < buf.length) tokens.push(buf.subarray(start).toString("utf8"));
  return tokens;
}

function parseRawHeader(token) {
  // ":<oldmode> <newmode> <oldoid> <newoid> <status>" (status has no score with --no-renames)
  const parts = token.replace(/^\n/, "").slice(1).split(" ");
  if (parts.length < 5) return null;
  return {
    oldMode: parts[0],
    newMode: parts[1],
    oldOid: parts[2],
    newOid: parts[3],
    status: parts[4].trim(),
  };
}

/** git diff --raw between two commits -> [{status, oldOid, newOid, path}] */
function diffRaw(repo, from, to) {
  const buf = git(repo, [
    "diff",
    "--raw",
    "-z",
    "--no-abbrev",
    "--no-renames",
    from,
    to,
  ]);
  const tokens = splitNul(buf);
  const entries = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const header = parseRawHeader(tokens[i]);
    if (!header)
      throw new Error(
        `unparseable raw diff header: ${JSON.stringify(tokens[i])}`,
      );
    entries.push({ ...header, path: tokens[i + 1] });
  }
  return entries;
}

/**
 * First-parent history walk of `tip` (bounded by `window` commits) restricted
 * to `paths`. Returns Map(path -> [{sha, ct, oldOid, newOid}] newest-first).
 */
function historyWalk(repo, tip, window, paths) {
  const byPath = new Map(paths.map((p) => [p, []]));
  // Bound the walk: use tip~window..tip when that commit exists; otherwise
  // (short or shallow history) walk everything available — `git log` stops at
  // a shallow boundary on its own.
  const boundary = gitText(
    repo,
    ["rev-parse", "--verify", "--quiet", `${tip}~${window}`],
    {
      allowFail: true,
    },
  );
  const range = boundary ? `${tip}~${window}..${tip}` : tip;
  for (let i = 0; i < paths.length; i += PATHSPEC_CHUNK) {
    const chunk = paths.slice(i, i + PATHSPEC_CHUNK);
    const buf = git(repo, [
      "log",
      "--first-parent",
      "--no-abbrev",
      "--no-renames",
      "--raw",
      "-z",
      "--format=\u0001%H %ct",
      range,
      "--",
      ...chunk.map((p) => `:(literal)${p}`),
    ]);
    let current = null;
    const tokens = splitNul(buf);
    for (let t = 0; t < tokens.length; t++) {
      const token = tokens[t];
      if (token.startsWith("\u0001")) {
        // Token may be "\x01<sha> <ct>" possibly followed by "\n" remnants.
        const [sha, ct] = token.slice(1).trim().split(" ");
        current = { sha, ct: Number(ct) };
        continue;
      }
      const header = parseRawHeader(token);
      if (!header)
        throw new Error(`unparseable raw log header: ${JSON.stringify(token)}`);
      const path = tokens[t + 1];
      t += 1;
      if (!current) throw new Error("raw log entry before any commit header");
      const list = byPath.get(path);
      if (list) {
        list.push({
          sha: current.sha,
          ct: current.ct,
          oldOid: header.oldOid,
          newOid: header.newOid,
        });
      }
    }
  }
  return byPath;
}

function parseCommit(repo, sha) {
  const raw = gitText(repo, ["cat-file", "commit", sha]);
  const [headers, message = ""] = raw.split(/\n\n/, 2);
  const committer = headers
    .split("\n")
    .find((line) => line.startsWith("committer "));
  if (!committer) throw new Error(`commit ${sha} has no committer header`);
  const match = committer.match(/ (\d+) ([+-]\d{4})$/);
  if (!match) throw new Error(`commit ${sha} has invalid committer header`);
  const subject = message.split("\n")[0] ?? "";
  return {
    sha,
    ct: Number(match[1]),
    date: formatGitIso(match[1], match[2]),
    subject,
  };
}

function formatGitIso(timestamp, tz) {
  const offsetMinutes = Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5));
  const signedOffsetMinutes = tz.startsWith("-")
    ? -offsetMinutes
    : offsetMinutes;
  const localMs = Number(timestamp) * 1000 + signedOffsetMinutes * 60 * 1000;
  return `${new Date(localMs).toISOString().replace(".000Z", "")}${tz.slice(0, 3)}:${tz.slice(3)}`;
}

function commitMeta(repo, sha) {
  const parsed = parseCommit(repo, sha);
  return { ...parsed, shortSha: parsed.sha.slice(0, 10) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo;

  const base = gitText(repo, [
    "rev-parse",
    "--verify",
    `${args.base}^{commit}`,
  ]);
  const head = gitText(repo, [
    "rev-parse",
    "--verify",
    `${args.head}^{commit}`,
  ]);
  const mergeBase = args.mergeBase
    ? gitText(repo, ["rev-parse", "--verify", `${args.mergeBase}^{commit}`])
    : gitText(repo, ["merge-base", base, head], { allowFail: true });
  if (!mergeBase) {
    // No merge-base in the fetched history: the branch point is beyond the
    // fetch window — that alone is a (severe) staleness failure.
    return report(args, {
      base,
      head,
      mergeBase: null,
      staleness: {
        behindCommits: null,
        behindHours: null,
        failed: true,
        reason:
          "no merge-base found in the available history — the PR branch point is far behind the target branch",
      },
      revertFindings: [],
      deletionNotices: [],
    });
  }

  // --- Staleness backstop -------------------------------------------------
  const behindCommits = Number(
    gitText(repo, [
      "rev-list",
      "--count",
      "--first-parent",
      `${mergeBase}..${base}`,
    ]),
  );
  const ctOf = (sha) => parseCommit(repo, sha).ct;
  const behindHours = Math.max(0, (ctOf(base) - ctOf(mergeBase)) / 3600);
  const staleReasons = [];
  if (behindCommits > args.maxBehindCommits) {
    staleReasons.push(
      `merge-base is ${behindCommits} first-parent commits behind the target tip (limit ${args.maxBehindCommits})`,
    );
  }
  if (behindHours > args.maxBehindHours) {
    staleReasons.push(
      `merge-base is ${behindHours.toFixed(1)}h behind the target tip (limit ${args.maxBehindHours}h)`,
    );
  }
  const staleness = {
    behindCommits,
    behindHours: Number(behindHours.toFixed(2)),
    failed: staleReasons.length > 0,
    reason: staleReasons.join("; ") || null,
  };

  // --- Silent-revert detection ---------------------------------------------
  const prDiff = diffRaw(repo, mergeBase, head);
  const candidates = prDiff.filter((e) => RAW_STATUS_CANDIDATES.has(e.status));
  const history = historyWalk(
    repo,
    mergeBase,
    args.window,
    candidates.map((c) => c.path),
  );
  const revertFindings = [];
  for (const entry of candidates) {
    const changes = history.get(entry.path) ?? [];
    if (changes.length === 0) continue; // last change predates the window
    const cur = entry.oldOid; // blob at merge-base
    const prBlob = entry.newOid; // blob at PR head (all-zero when deleted)
    // olds[i] = the content the file had BEFORE changes[i] (newest-first).
    const idx = changes.findIndex((c) => oidEq(c.oldOid, prBlob));
    if (idx === -1) continue; // novel content — a normal edit
    // Heal case: the target's current blob is itself a re-occurrence of
    // content OLDER than what the PR restores (target sits on clobbered
    // content; the PR moves the file forward again).
    const heals = changes.slice(idx + 1).some((c) => oidEq(c.oldOid, cur));
    if (heals) continue;
    revertFindings.push({
      path: entry.path,
      status: entry.status,
      prBlob: isNullOid(prBlob) ? null : prBlob,
      discards: changes.slice(0, idx + 1).map((c) => commitMeta(repo, c.sha)),
    });
  }

  // Deletions only block when a modification-revert corroborates the
  // stale-tree signature; alone they are loud notices (see header comment).
  const corroborated = revertFindings.some((f) => f.status !== "D");
  const deletionNotices = corroborated
    ? []
    : revertFindings.filter((f) => f.status === "D");
  const blockingFindings = corroborated ? revertFindings : [];

  return report(args, {
    base,
    head,
    mergeBase,
    staleness,
    revertFindings: blockingFindings,
    deletionNotices,
  });
}

function report(args, result) {
  const { staleness, revertFindings, deletionNotices } = result;
  const failed = staleness.failed || revertFindings.length > 0;
  const verdict = !failed ? "pass" : args.ack ? "acked" : "fail";
  const out = { ...result, ack: args.ack, verdict };
  if (args.json) writeFileSync(args.json, `${JSON.stringify(out, null, 2)}\n`);

  const emit = (line) => process.stdout.write(`${line}\n`);
  const annotate = (kind, msg) => {
    if (args.github) emit(`::${kind}::${msg.replaceAll("\n", "%0A")}`);
    else emit(`${kind.toUpperCase()}: ${msg}`);
  };
  const level = args.ack ? "warning" : "error";

  emit(
    `stale-base guard: base=${result.base?.slice(0, 10)} head=${result.head?.slice(0, 10)} merge-base=${result.mergeBase ? result.mergeBase.slice(0, 10) : "NONE"} behind=${staleness.behindCommits ?? "?"} commits / ${staleness.behindHours ?? "?"}h`,
  );

  if (staleness.failed) {
    annotate(
      level,
      `stale-base guard — STALE BASE: ${staleness.reason}. Rebase onto the target branch (git fetch origin && git rebase), re-verify, and force-push with --force-with-lease.`,
    );
  }
  for (const f of revertFindings.slice(0, MAX_INLINE_ANNOTATIONS)) {
    const newest = f.discards[0];
    annotate(
      level,
      `stale-base guard — SILENT REVERT: this PR sets \`${f.path}\` back to a blob the target branch already moved past, discarding ${f.discards.length} merged change(s) — newest: ${newest.shortSha} "${newest.subject}" (${newest.date}). This is the #11271 failure mode (stale checkout committed over merged work). Rebase/restore the file, or apply the \`stale-base-ack\` label if the revert is deliberate.`,
    );
  }
  if (revertFindings.length > MAX_INLINE_ANNOTATIONS) {
    annotate(
      level,
      `stale-base guard: ${revertFindings.length - MAX_INLINE_ANNOTATIONS} more silent-revert findings — see the step summary.`,
    );
  }
  for (const f of deletionNotices.slice(0, MAX_INLINE_ANNOTATIONS)) {
    annotate(
      "notice",
      `stale-base guard: this PR deletes \`${f.path}\`, which the target branch added/changed recently (${f.discards[0].shortSha} "${f.discards[0].subject}"). Not blocking — no stale-tree corroboration — but confirm the deletion is intended.`,
    );
  }
  if (verdict === "acked") {
    annotate(
      "warning",
      "stale-base guard: failures OVERRIDDEN by the `stale-base-ack` label. Merged work MAY be silently discarded — a human has asserted the reverts above are deliberate.",
    );
  }
  if (verdict === "pass")
    emit("stale-base guard: PASS — no silent reverts, base is fresh.");

  if (args.summary) {
    const lines = [
      "## Stale-base guard",
      "",
      `Verdict: **${verdict.toUpperCase()}**`,
      "",
      `- base: \`${result.base}\``,
      `- head: \`${result.head}\``,
      `- merge-base: \`${result.mergeBase ?? "none found"}\` (${staleness.behindCommits ?? "?"} commits / ${staleness.behindHours ?? "?"}h behind target tip)`,
      "",
    ];
    if (staleness.failed)
      lines.push(`⛔ **Stale base**: ${staleness.reason}`, "");
    if (revertFindings.length > 0) {
      lines.push(
        `⛔ **Silent reverts** (${revertFindings.length} file(s) set back to pre-merge blobs):`,
        "",
        "| File | Discarded merged change(s) |",
        "| --- | --- |",
      );
      for (const f of revertFindings) {
        const discards = f.discards
          .map((d) => `${d.shortSha} ${d.subject.replaceAll("|", "\\|")}`)
          .join("<br>");
        lines.push(`| \`${f.path}\` | ${discards} |`);
      }
      lines.push("");
    }
    if (deletionNotices.length > 0) {
      lines.push(
        `ℹ️ Non-blocking: deletes recently-added file(s) — confirm intended: ${deletionNotices.map((f) => `\`${f.path}\``).join(", ")}`,
        "",
      );
    }
    if (verdict === "acked") {
      lines.push(
        "⚠️ Overridden by the `stale-base-ack` label — reverts asserted deliberate.",
        "",
      );
    }
    appendFileSync(args.summary, `${lines.join("\n")}\n`);
  }

  process.exitCode = verdict === "fail" ? 1 : 0;
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `stale-base-guard: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 2;
}
