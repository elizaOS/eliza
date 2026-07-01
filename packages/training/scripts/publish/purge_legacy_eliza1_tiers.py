#!/usr/bin/env python3
"""purge_legacy_eliza1_tiers.py — fail-closed HF folder-delete for legacy Eliza-1 tiers.

Hard-cutover purge for the Gemma 4 release: the mono-repo ``elizaos/eliza-1``
carried per-tier bundle folders under ``bundles/<tier>/`` for the pre-Gemma
Qwen3.5 tier line. With the Gemma cutover the tiers are
``["2b","4b","9b","27b","27b-256k"]`` and the legacy folders
``bundles/0_6b``, ``bundles/0_8b``, ``bundles/1_7b`` are dead weight that must
be removed from the live repo.

There is no folder-delete tool in the repo
(``deprecate_legacy_qwen3_repos.py`` only rewrites READMEs on the retired
standalone repos), so this is the one place that calls
``huggingface_hub.HfApi.delete_folder`` against the mono-repo.

This is destructive and irreversible on apply, so it is fail-closed and
mirrors the gate style of ``eliza1-hf-push.sh``:

  1. DRY-RUN BY DEFAULT. With no flag it lists exactly what it WOULD delete
     and makes zero HF API calls.
  2. To actually delete it requires BOTH:
       - ``--yes-i-will-delete`` passed on the command line, AND
       - ``HF_TOKEN`` (or ``HUGGINGFACE_HUB_TOKEN``) set to a non-empty value.
  3. An explicit, hardcoded per-tier allowlist. Only ``0_6b``, ``0_8b``,
     ``1_7b`` can ever be targeted. The active Gemma tiers
     (``2b``/``4b``/``9b``/``27b``/``27b-256k``) are NOT deletable through
     this tool — any ``--tier`` outside the legacy allowlist is a hard error.

Usage:
  # dry-run (default): list would-be deletions, zero HF calls, exits 0
  python3 -m scripts.publish.purge_legacy_eliza1_tiers

  # actually delete (irreversible):
  HF_TOKEN=hf_xxx python3 -m scripts.publish.purge_legacy_eliza1_tiers \
      --yes-i-will-delete

  # limit to a subset of the legacy allowlist:
  HF_TOKEN=hf_xxx python3 -m scripts.publish.purge_legacy_eliza1_tiers \
      --yes-i-will-delete --tier 0_8b
"""

from __future__ import annotations

import argparse
import logging
import os
import sys

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("purge-legacy-eliza1-tiers")

REPO_ID = "elizaos/eliza-1"

# The ONLY tiers this tool is permitted to delete. Active Gemma tiers
# (2b/4b/9b/27b/27b-256k) are deliberately absent and can never be targeted.
LEGACY_TIERS: tuple[str, ...] = ("0_6b", "0_8b", "1_7b")


def _hf_token() -> str | None:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")


def _path_in_repo(tier: str) -> str:
    return f"bundles/{tier}"


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="purge_legacy_eliza1_tiers",
        description=(
            "Fail-closed delete of legacy Eliza-1 bundle folders "
            f"({', '.join(_path_in_repo(t) for t in LEGACY_TIERS)}) "
            f"from {REPO_ID}. Dry-run by default."
        ),
    )
    parser.add_argument(
        "--yes-i-will-delete",
        action="store_true",
        help=(
            "Acknowledge the irreversible delete. Without this flag (or "
            "without HF_TOKEN) the tool dry-runs and makes zero HF API calls."
        ),
    )
    parser.add_argument(
        "--tier",
        action="append",
        choices=LEGACY_TIERS,
        metavar="TIER",
        help=(
            "Restrict to a subset of the legacy allowlist "
            f"({', '.join(LEGACY_TIERS)}). Repeatable. Default: all legacy "
            "tiers. Non-legacy tiers are rejected by the choices gate."
        ),
    )
    parser.add_argument(
        "--repo-id",
        default=REPO_ID,
        help=f"HF repo to purge from (default: {REPO_ID}).",
    )
    args = parser.parse_args()

    tiers = tuple(dict.fromkeys(args.tier)) if args.tier else LEGACY_TIERS

    # Defense in depth: even though argparse `choices` already constrains
    # --tier, re-assert the allowlist so no future caller path can sneak an
    # active tier past the gate.
    illegal = [t for t in tiers if t not in LEGACY_TIERS]
    if illegal:
        log.error(
            "refusing to purge non-legacy tier(s): %s — allowlist is %s",
            ", ".join(illegal),
            ", ".join(LEGACY_TIERS),
        )
        return 2

    targets = [(t, _path_in_repo(t)) for t in tiers]

    print(f"=== Eliza-1 legacy tier purge plan ({len(targets)} folder(s)) ===")
    print(f"  repo: {args.repo_id}")
    for tier, path in targets:
        print(f"  delete  https://huggingface.co/{args.repo_id}/tree/main/{path}  (tier {tier})")

    token = _hf_token()

    if not args.yes_i_will_delete or not token:
        reasons = []
        if not args.yes_i_will_delete:
            reasons.append("--yes-i-will-delete not passed")
        if not token:
            reasons.append("HF_TOKEN / HUGGINGFACE_HUB_TOKEN not set")
        print(
            "\n(dry-run — "
            + "; ".join(reasons)
            + ")\nNo HF API calls were made. To delete for real, pass "
            "--yes-i-will-delete with HF_TOKEN set. This is irreversible."
        )
        return 0

    from huggingface_hub import HfApi
    from huggingface_hub.errors import RepositoryNotFoundError

    api = HfApi(token=token)

    print("\nHF_TOKEN present and --yes-i-will-delete acknowledged. Deleting (irreversible).")

    deleted = 0
    skipped_missing = 0
    failure = 0
    for tier, path in targets:
        try:
            api.delete_folder(
                path_in_repo=path,
                repo_id=args.repo_id,
                repo_type="model",
                commit_message=f"Hard cutover: remove legacy {path} (Gemma 4 tier set)",
            )
            log.info("  + %s — deleted (tier %s)", path, tier)
            deleted += 1
        except RepositoryNotFoundError:
            log.error("  ! %s — repo %s not found; aborting", path, args.repo_id)
            failure += 1
            break
        except Exception as exc:  # noqa: BLE001 — surface every failure
            msg = str(exc)
            if "404 Client Error" in msg or "EntryNotFound" in msg:
                log.info("  . %s — skipped (folder does not exist)", path)
                skipped_missing += 1
            else:
                log.error("  - %s — %s", path, exc)
                failure += 1

    print(f"\nDeleted: {deleted}; Skipped (missing): {skipped_missing}; Failed: {failure}")
    return 0 if failure == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
