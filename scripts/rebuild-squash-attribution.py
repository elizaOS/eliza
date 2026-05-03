#!/usr/bin/env python3
"""
Rewrite a branch's history into one empty commit per original commit, plus a
single trailing commit containing the entire current source tree and
CONTRIBUTIONS.md.

Each attribution commit preserves the original commit's author name, author
email, author date, committer name, committer email, committer date, and
message. The trees are empty -- no source code lives in any historical commit.

This keeps GitHub contribution graphs intact (graph credit is keyed off author
email + author date, both preserved) while removing all historical code from
the branch. The full pre-squash history must be preserved separately on
<source>-full-commits before running this script.

Usage:
  scripts/rebuild-squash-attribution.py [--source develop]
                                        [--target develop-squashed]
                                        [--yes]
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

REPO_URL_RE = re.compile(r"github\.com[:/](.+?)(?:\.git)?$")


def run(cmd: list[str], **kwargs) -> str:
    return subprocess.run(
        cmd, check=True, capture_output=True, text=True, **kwargs
    ).stdout


def parse_remote_url(url: str) -> str | None:
    m = REPO_URL_RE.search(url)
    return f"https://github.com/{m.group(1)}" if m else None


def fmt_date(iso: str) -> str:
    """Convert ISO 8601 to fast-import 'unix_ts +HHMM' format."""
    if iso.endswith("Z"):
        iso = iso[:-1] + "+00:00"
    dt = datetime.fromisoformat(iso)
    ts = int(dt.timestamp())
    tzd = dt.utcoffset()
    secs = int(tzd.total_seconds()) if tzd else 0
    sign = "+" if secs >= 0 else "-"
    secs = abs(secs)
    return f"{ts} {sign}{secs // 3600:02d}{(secs % 3600) // 60:02d}"


def sanitize(name: str) -> str:
    """fast-import accepts UTF-8 names but '<' and '>' near the email delimiters
    can confuse parsers; replace them and strip embedded newlines."""
    return name.replace("<", "(").replace(">", ")").replace("\n", " ").replace("\r", " ")


def get_commits(branch: str) -> list[dict]:
    fmt = "%H%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%B%x1e"
    proc = subprocess.run(
        ["git", "log", "--reverse", "--topo-order", f"--format={fmt}", branch],
        capture_output=True, check=True,
    )
    raw = proc.stdout.decode("utf-8", errors="replace")
    commits = []
    for rec in raw.split("\x1e"):
        rec = rec.lstrip("\n")
        if not rec.strip():
            continue
        fields = rec.split("\x1f")
        if len(fields) < 8:
            continue
        commits.append({
            "hash": fields[0].strip(),
            "author_name": fields[1],
            "author_email": fields[2].strip(),
            "author_iso": fields[3].strip(),
            "committer_name": fields[4],
            "committer_email": fields[5].strip(),
            "committer_iso": fields[6].strip(),
            "message": fields[7],
        })
    return commits


def build_contributions_md(commits: list[dict], gh_url: str | None, source: str) -> str:
    lines = [
        "# Contributions",
        "",
        f"Each commit on this branch is an empty attribution commit preserving the",
        f"original author, date, and message of a commit on `{source}`. Source code",
        f"lives only in the single trailing commit. The complete pre-squash history",
        f"is preserved on branch `{source}-full-commits`.",
        "",
        "Original commit hashes, oldest first:",
        "",
    ]
    for c in commits:
        h = c["hash"]
        short = h[:12]
        date = c["author_iso"][:10]
        an = sanitize(c["author_name"])
        subject = c["message"].strip().split("\n", 1)[0]
        if gh_url:
            lines.append(f"- [`{short}`]({gh_url}/commit/{h}) {date} {an}: {subject}")
        else:
            lines.append(f"- `{short}` {date} {an}: {subject}")
    return "\n".join(lines) + "\n"


def write_blob(content: str) -> str:
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False, encoding="utf-8") as f:
        f.write(content)
        path = f.name
    try:
        return run(["git", "hash-object", "-w", "--", path]).strip()
    finally:
        os.unlink(path)


def build_final_tree(source_tree: str, contrib_blob: str, contrib_path: str = "CONTRIBUTIONS.md") -> str:
    with tempfile.NamedTemporaryFile(prefix="idx-", delete=False) as f:
        idx_path = f.name
    try:
        env = {**os.environ, "GIT_INDEX_FILE": idx_path}
        subprocess.run(["git", "read-tree", source_tree], env=env, check=True)
        subprocess.run([
            "git", "update-index", "--add",
            "--cacheinfo", f"100644,{contrib_blob},{contrib_path}",
        ], env=env, check=True)
        return subprocess.run(
            ["git", "write-tree"], env=env, check=True,
            capture_output=True, text=True,
        ).stdout.strip()
    finally:
        os.unlink(idx_path)


def stream_attribution_commits(commits: list[dict], target_ref: str) -> None:
    proc = subprocess.Popen(
        ["git", "fast-import", "--quiet", "--force", "--done"],
        stdin=subprocess.PIPE,
    )
    assert proc.stdin is not None

    def emit(s):
        if isinstance(s, str):
            s = s.encode("utf-8", errors="replace")
        proc.stdin.write(s)

    # Reset target ref so the first commit is a true root commit
    emit(f"reset {target_ref}\n\n")

    progress_step = max(1, len(commits) // 20)
    for i, c in enumerate(commits):
        msg = c["message"]
        if not msg.endswith("\n"):
            msg += "\n"
        msg_bytes = msg.encode("utf-8", errors="replace")
        if not msg_bytes.strip():
            msg_bytes = b"(no message)\n"

        a_name = sanitize(c["author_name"]) or "(unknown)"
        c_name = sanitize(c["committer_name"]) or "(unknown)"
        a_email = c["author_email"] or "unknown@localhost"
        c_email = c["committer_email"] or "unknown@localhost"
        a_when = fmt_date(c["author_iso"])
        c_when = fmt_date(c["committer_iso"])

        emit(f"commit {target_ref}\n")
        emit(f"mark :{i + 1}\n")
        emit(f"author {a_name} <{a_email}> {a_when}\n")
        emit(f"committer {c_name} <{c_email}> {c_when}\n")
        emit(f"data {len(msg_bytes)}\n")
        emit(msg_bytes)
        if i > 0:
            emit(f"from :{i}\n")
        emit("\n")

        if (i + 1) % progress_step == 0 or (i + 1) == len(commits):
            print(f"  {i + 1}/{len(commits)}", flush=True)

    emit("done\n")
    proc.stdin.close()
    rc = proc.wait()
    if rc != 0:
        raise SystemExit(f"git fast-import failed (rc={rc})")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="develop")
    ap.add_argument("--target", default="develop-squashed")
    ap.add_argument("--yes", action="store_true")
    args = ap.parse_args()

    repo_root = run(["git", "rev-parse", "--show-toplevel"]).strip()
    os.chdir(repo_root)

    src = args.source
    target = args.target

    src_sha = run(["git", "rev-parse", src]).strip()
    count = int(run(["git", "rev-list", "--count", src]).strip())

    try:
        remote = run(["git", "remote", "get-url", "origin"]).strip()
        gh_url = parse_remote_url(remote)
    except subprocess.CalledProcessError:
        gh_url = None

    print(f"Source:  {src} ({count} commits @ {src_sha[:12]})")
    print(f"Target:  {target}")
    print(f"GitHub:  {gh_url or '<none>'}")
    print()
    print(f"Will create {count} attribution commits + 1 final code commit "
          f"(={count + 1} total).")
    print()

    if not args.yes:
        if input("Proceed? [y/N] ").strip().lower() not in ("y", "yes"):
            print("Aborted.")
            return 1

    print(f"Reading {count} commits...")
    commits = get_commits(src)
    print(f"  parsed {len(commits)} commits")
    if len(commits) != count:
        print(f"  warning: expected {count}, got {len(commits)}", file=sys.stderr)

    print("Building CONTRIBUTIONS.md...")
    contrib = build_contributions_md(commits, gh_url, src)
    contrib_blob = write_blob(contrib)
    print(f"  blob {contrib_blob[:12]} ({len(contrib):,} bytes)")

    print("Building final tree (source tree + CONTRIBUTIONS.md)...")
    src_tree = run(["git", "rev-parse", f"{src}^{{tree}}"]).strip()
    final_tree = build_final_tree(src_tree, contrib_blob)
    print(f"  tree {final_tree[:12]}")

    target_ref = f"refs/heads/{target}"
    print(f"Streaming {len(commits)} attribution commits via fast-import...")
    stream_attribution_commits(commits, target_ref)

    print("Adding final code commit...")
    last_attrib = run(["git", "rev-parse", target]).strip()
    last_c = commits[-1]
    final_msg = (
        "Squash code into single file write\n"
        "\n"
        f"The full {src} history ({len(commits)} commits) is preserved as empty\n"
        f"attribution commits below this commit. The complete pre-squash history\n"
        f"is on branch {src}-full-commits and is summarised in CONTRIBUTIONS.md.\n"
    )
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": last_c["committer_name"],
        "GIT_AUTHOR_EMAIL": last_c["committer_email"] or "unknown@localhost",
        "GIT_AUTHOR_DATE": last_c["committer_iso"],
        "GIT_COMMITTER_NAME": last_c["committer_name"],
        "GIT_COMMITTER_EMAIL": last_c["committer_email"] or "unknown@localhost",
        "GIT_COMMITTER_DATE": last_c["committer_iso"],
    }
    final_commit = subprocess.run(
        ["git", "commit-tree", final_tree, "-p", last_attrib, "-m", final_msg],
        env=env, capture_output=True, text=True, check=True,
    ).stdout.strip()

    subprocess.run(["git", "update-ref", target_ref, final_commit], check=True)

    new_count = int(run(["git", "rev-list", "--count", target]).strip())
    print()
    print(f"Done. {target} = {new_count} commits, tip {final_commit[:12]}")
    print()
    print("Verify:")
    print(f"  git log --oneline {target} | wc -l       # expect {new_count}")
    print(f"  git diff {src}..{target}                 # expect only CONTRIBUTIONS.md added")
    print(f"  git log --format='%an' {target} | sort -u | wc -l  # author count")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
