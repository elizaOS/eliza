#!/usr/bin/env python3
"""Offline accidental-reintroduction preflight; never executes repository code."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

DENIED_COMMITS = {
    "61d293f61f8e56caea450cdb6b33d01bb18aa5b8",
    "39ef594011c34d625882ee8f4ecb5a0a07788885",
    "cc3f7a709ec276044577a768793e8aad81dff709",
    "25e0ac948781591ff7f8ffbee5edeef8884d1bf2",
    "131cd0e63a34af72b55267d21f0717226b5f43f6",
    "f98094915d86ef5dc1ddab4eeb6781e8eea6c4bb",
    "0cefd6e47848c9784f4d3b03e2840416084a95cd",
}
PAYLOAD = "android/app/src/androidTest/java/ai/eliza/plugins/reminders/public/fonts/fa-brand-400.orc"
MARKERS = ("fa-brand-400.orc", "eval(proxyInfo)", "files.catbox.moe/e8jt91.js",
           "aHR0cHM6Ly9maWxlcy5jYXRib3gubW9lL2U4anQ5MS5qcw==")


def inspect(repo, kind, expected):
    env = {**os.environ, "GIT_NO_LAZY_FETCH": "1", "GIT_NO_REPLACE_OBJECTS": "1",
           "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"}

    def git(*args):
        result = subprocess.run(
            ["git", "--no-replace-objects", "-c", "core.fsmonitor=false",
             "-c", "core.hooksPath=/dev/null", "-C", str(repo), *args],
            env=env, capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise RuntimeError("Git metadata unavailable for " + args[0])
        return result.stdout.strip()

    root = Path(git("rev-parse", "--show-toplevel")).resolve()
    if root != repo:
        raise RuntimeError("Pass the exact Git worktree root")
    head = git("rev-parse", "HEAD")
    failures = []
    limitations = ["Known-incident guard, not a general malware audit or sandbox"]
    if expected and head != expected:
        failures.append("HEAD differs from the explicitly reviewed expected revision")
    if kind == "sdk" and not expected:
        failures.append("SDK mode requires an independently reviewed --expected-head")
    if git("for-each-ref", "--format=%(refname)", "refs/replace"):
        failures.append("Git replacement refs require owner review")

    ancestors = subprocess.run(
        ["git", "--no-replace-objects", "-c", "core.fsmonitor=false", "-C", str(repo),
         "rev-list", "HEAD"], env=env, capture_output=True, text=True, timeout=60)
    complete = ancestors.returncode == 0 and git("rev-parse", "--is-shallow-repository") == "false"
    denied = sorted(set(ancestors.stdout.splitlines()) & DENIED_COMMITS)
    if denied:
        failures.append("Known injected commits are reachable from HEAD")
    if kind == "product" and not complete:
        failures.append("Product ancestry cannot be fully checked offline")
    if kind == "sdk" and not complete:
        limitations.append("SDK ancestry incomplete; only exact pin and incident markers checked")

    paths = set(git("ls-tree", "-r", "--name-only", "HEAD").splitlines())
    if kind == "product":
        for name in (".env", "init", PAYLOAD):
            if name in paths:
                failures.append("Forbidden incident path tracked: " + name)
        for name in ("init", PAYLOAD):
            if (repo / name).is_file():
                failures.append("Incident execution path exists in worktree: " + name)

    for name in ("package.json", "capacitor.config.ts", ".vscode/tasks.json", ".vscode/settings.json", ".env"):
        file = repo / name
        if not file.is_file():
            continue
        text = file.read_text(errors="replace")
        if any(marker in text for marker in MARKERS):
            failures.append("Known loader marker in " + name)
        if name == "package.json":
            package = json.loads(text)
            if any(re.search(r"\bnode\s+(?:\./)?init(?:\s|$|[;&|])", value)
                   for value in package.get("scripts", {}).values() if isinstance(value, str)):
                failures.append("Package command invokes injected init entrypoint")
        if name == "capacitor.config.ts" and any(x in text for x in ("AUTH_API_KEY", "dotenv/config", "eval(")):
            failures.append("Capacitor config requires review for restored loader mechanism")

    if kind == "product" and (repo / "upstream.lock.json").is_file():
        lock = json.loads((repo / "upstream.lock.json").read_text())
        entry = git("ls-tree", "HEAD", "--", "vendor/eliza").split()
        if lock.get("url") != "https://github.com/elizaOS/eliza.git":
            failures.append("Unexpected upstream source URL")
        if not entry or entry[0] != "160000" or entry[2] != lock.get("commit"):
            failures.append("Working lock and HEAD upstream gitlink do not match")
        if (repo / "vendor/eliza/.git").exists():
            actual = subprocess.run(
                ["git", "--no-replace-objects", "-c", "core.fsmonitor=false", "-C",
                 str(repo / "vendor/eliza"), "rev-parse", "HEAD"],
                env=env, capture_output=True, text=True, timeout=30)
            if actual.returncode or actual.stdout.strip() != lock.get("commit"):
                failures.append("Checked-out upstream revision differs from product lock")

    dirty = git("diff", "--no-ext-diff", "--name-only", "HEAD").splitlines()
    return {"result": "PASS" if not failures else "BLOCK", "repo": str(repo), "kind": kind,
            "head": head, "expectedHead": expected, "ancestryComplete": complete,
            "knownInjectedAncestors": denied, "trackedChangedFiles": dirty,
            "failures": failures, "limitations": limitations,
            "sourceCodeExecuted": False, "networkAccess": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--kind", required=True, choices=("product", "sdk"))
    parser.add_argument("--expected-head")
    args = parser.parse_args()
    if args.expected_head and not re.fullmatch(r"[0-9a-f]{40}", args.expected_head):
        parser.error("--expected-head must be a full reviewed commit SHA")
    try:
        result = inspect(args.repo.resolve(), args.kind, args.expected_head)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        result = {"result": "BLOCK", "reason": str(error), "sourceCodeExecuted": False}
    print(json.dumps(result, indent=2))
    return 0 if result["result"] == "PASS" else 2


if __name__ == "__main__":
    sys.exit(main())
