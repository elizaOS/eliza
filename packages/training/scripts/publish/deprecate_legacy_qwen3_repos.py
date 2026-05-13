"""Mark the legacy Qwen3 Eliza-1 HuggingFace repos as DEPRECATED.

Per the 2026-05-12 operator directive, the Eliza-1 fused-model line is
Qwen3.5-only — the Qwen3 dense base models (Qwen/Qwen3-0.6B / Qwen/Qwen3-1.7B
/ Qwen/Qwen3-4B) do not work with the eliza-1 dflash spec-decode path. The
corresponding HF tier repos under ``elizaos/`` stay public (existing
downloads keep working) but their model cards are updated to mark them as
deprecated and point at the Qwen3.5 replacement tiers.

This script only updates the README.md on each repo; it does NOT delete or
transform any artifact. Run it once per token-bearing environment::

    HF_TOKEN=hf_... python -m scripts.publish.deprecate_legacy_qwen3_repos

Dry-run by default; pass ``--apply`` to actually upload.

The repos updated are:

  Bundle repos (the device-side tier bundles — manifest + GGUFs):
    elizaos/eliza-1-0_6b
    elizaos/eliza-1-1_7b
    elizaos/eliza-1-4b

  Companion model repos (per-tier optimized GGUF / SFT weights / drafter):
    elizaos/eliza-1-{0_6b,1_7b,4b}-optimized
    elizaos/eliza-1-{0_6b,1_7b,4b}-drafter
    elizaos/eliza-1-{0_6b,1_7b,4b}-sft
    elizaos/eliza-1-0_6b-sft-weights   (the published test-SFT candidate)

  Dataset repos:
    elizaos/eliza-1-0_6b-sft  (model-agnostic — kept usable for Qwen3.5)

The dataset card says the dataset itself is reusable on the Qwen3.5 line
(it is just JSONL — no model-family dependency), but the dataset name's
``0_6b`` tier infix is legacy.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from dataclasses import dataclass
from typing import Final

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("deprecate_legacy_qwen3_repos")

ORG: Final[str] = "elizaos"

DEPRECATED_BUNDLE_TIERS: Final[tuple[str, ...]] = ("0_6b", "1_7b", "4b")
DEPRECATED_COMPANION_SUFFIXES: Final[tuple[str, ...]] = ("optimized", "drafter", "sft")

# Cards for the model-bundle repos (manifest + GGUF parent repo for the tier).
MODEL_DEPRECATION_CARD: Final[str] = """\
---
license: apache-2.0
tags:
  - eliza-1
  - deprecated
  - qwen3
---

# {repo_id} — DEPRECATED (2026-05-12)

**This tier is deprecated.** It shipped against the Qwen3 base model
(`Qwen/Qwen3-{legacy_size}`), which does not work with the eliza-1 dflash
spec-decode path — the dflash kernels are validated against the Qwen3.5
architecture and 248320 tokenizer; a Qwen3 base has the wrong vocab
(151936) and the wrong attention shape for the fused QJL / PolarQuant /
TurboQuant paths.

Superseded by the Qwen3.5 line:

- [`elizaos/eliza-1-0_8b`](https://huggingface.co/elizaos/eliza-1-0_8b) (Qwen3.5-0.8B-Base — new smallest tier)
- [`elizaos/eliza-1-2b`](https://huggingface.co/elizaos/eliza-1-2b) (Qwen3.5-2B-Base — new mid local tier)
- [`elizaos/eliza-1-4b`](https://huggingface.co/elizaos/eliza-1-4b) (Qwen3.5-4B-Base — local/workstation tier; same tier id, new backbone)

Existing downloads still work; no new releases will land here.

See [`packages/training/scripts/training/model_registry.py`](https://github.com/elizaOS/eliza/blob/develop/packages/training/scripts/training/model_registry.py)
and [`packages/inference/reports/porting/2026-05-12/eliza1-e2e-audit-2026-05-12.md`](https://github.com/elizaOS/eliza/blob/develop/packages/inference/reports/porting/2026-05-12/eliza1-e2e-audit-2026-05-12.md)
for the full rationale.
"""

# Cards for the companion model repos (-optimized / -drafter / -sft / -sft-weights).
COMPANION_DEPRECATION_CARD: Final[str] = """\
---
license: apache-2.0
tags:
  - eliza-1
  - deprecated
  - qwen3
---

# {repo_id} — DEPRECATED (2026-05-12)

**This companion artifact is deprecated.** It pairs with the deprecated
`elizaos/eliza-1-{legacy_tier}` parent tier, which shipped against the
Qwen3 base model (`Qwen/Qwen3-{legacy_size}`) that does not work with
the eliza-1 dflash spec-decode path.

Superseded by the Qwen3.5 line — see the Qwen3.5 tier companions under
[`elizaos/eliza-1-0_8b`](https://huggingface.co/elizaos/eliza-1-0_8b),
[`elizaos/eliza-1-2b`](https://huggingface.co/elizaos/eliza-1-2b), and
[`elizaos/eliza-1-4b`](https://huggingface.co/elizaos/eliza-1-4b)
(`-optimized` / `-drafter` / `-sft` per-tier companions).

Existing downloads still work; no new releases will land here.

See [`packages/training/scripts/training/model_registry.py`](https://github.com/elizaOS/eliza/blob/develop/packages/training/scripts/training/model_registry.py)
for the full rationale.
"""

# Dataset card — the dataset itself is reusable; only the name's tier infix is legacy.
DATASET_DEPRECATION_CARD: Final[str] = """\
---
license: apache-2.0
tags:
  - eliza-1
  - sft
  - deprecated-name
---

# elizaos/eliza-1-0_6b-sft — DEPRECATED NAME (2026-05-12)

The dataset itself is **reusable** on the Qwen3.5 Eliza-1 line — it is just
JSONL with no model-family dependency (privacy-filtered Cerebras-augmented
SFT corpus covering `structured_decode`, `voice_emotion`, `tool_use`,
`action_selection`, `personality` tasks). The name's `0_6b` tier infix is
**legacy** — it predates the 2026-05-12 Qwen3.5-only directive.

Going forward, the canonical SFT-corpus repo for the Eliza-1 line is
[`elizaos/eliza-1-training`](https://huggingface.co/datasets/elizaos/eliza-1-training)
(the broader privacy-filtered SFT corpus that the H200 0_8b / 2b runs train
against). The new Qwen3.5 tier SFTs land in
[`elizaos/eliza-1-0_8b-sft-weights`](https://huggingface.co/elizaos/eliza-1-0_8b-sft-weights)
(weights) and the per-tier `-sft` companion repos under
[`elizaos/eliza-1-0_8b`](https://huggingface.co/elizaos/eliza-1-0_8b) /
[`elizaos/eliza-1-2b`](https://huggingface.co/elizaos/eliza-1-2b).

Existing downloads still work.
"""

# Legacy size lookup for the bundle/companion cards' rationale paragraph.
_LEGACY_SIZE: Final[dict[str, str]] = {
    "0_6b": "0.6B",
    "1_7b": "1.7B",
    "4b": "4B",
}


@dataclass(frozen=True, slots=True)
class CardUpdate:
    repo_id: str
    repo_type: str  # "model" | "dataset"
    body: str


def _hf_token() -> str | None:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")


def build_updates() -> list[CardUpdate]:
    out: list[CardUpdate] = []
    # 1. Bundle repos (parent tier repos).
    for tier in DEPRECATED_BUNDLE_TIERS:
        repo = f"{ORG}/eliza-1-{tier}"
        body = MODEL_DEPRECATION_CARD.format(repo_id=repo, legacy_size=_LEGACY_SIZE[tier])
        out.append(CardUpdate(repo_id=repo, repo_type="model", body=body))
    # 2. Companion model repos.
    for tier in DEPRECATED_BUNDLE_TIERS:
        for suffix in DEPRECATED_COMPANION_SUFFIXES:
            repo = f"{ORG}/eliza-1-{tier}-{suffix}"
            body = COMPANION_DEPRECATION_CARD.format(repo_id=repo, legacy_tier=tier, legacy_size=_LEGACY_SIZE[tier])
            out.append(CardUpdate(repo_id=repo, repo_type="model", body=body))
    # 3. The published Qwen3-0.6B test-SFT weights repo (special — the artifact itself is Qwen3-based).
    repo = f"{ORG}/eliza-1-0_6b-sft-weights"
    body = COMPANION_DEPRECATION_CARD.format(repo_id=repo, legacy_tier="0_6b", legacy_size="0.6B")
    out.append(CardUpdate(repo_id=repo, repo_type="model", body=body))
    # 4. The 0_6b-sft dataset (reusable, just deprecated name).
    out.append(CardUpdate(
        repo_id=f"{ORG}/eliza-1-0_6b-sft",
        repo_type="dataset",
        body=DATASET_DEPRECATION_CARD,
    ))
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--apply", action="store_true",
                    help="Actually upload the deprecation cards (default: dry-run).")
    args = ap.parse_args(argv)

    updates = build_updates()
    print(f"=== Eliza-1 legacy Qwen3 deprecation plan ({len(updates)} repos) ===")
    for upd in updates:
        kind = "dataset" if upd.repo_type == "dataset" else "model"
        print(f"  {kind:7s}  https://huggingface.co/{('datasets/' if kind == 'dataset' else '')}{upd.repo_id}")

    if not args.apply:
        print("\n(dry-run — pass --apply with HF_TOKEN set to actually upload)")
        return 0

    token = _hf_token()
    if not token:
        log.error("HF_TOKEN not set — refusing to upload without a token")
        return 2

    from huggingface_hub import HfApi
    api = HfApi(token=token)

    success = 0
    failure = 0
    skipped_missing = 0
    for upd in updates:
        try:
            api.upload_file(
                path_or_fileobj=upd.body.encode("utf-8"),
                path_in_repo="README.md",
                repo_id=upd.repo_id,
                repo_type=upd.repo_type,
                commit_message="Deprecate: Qwen3 backbone superseded by Qwen3.5 line (2026-05-12)",
            )
            log.info(f"  + {upd.repo_id} ({upd.repo_type}) — README.md updated")
            success += 1
        except Exception as exc:  # noqa: BLE001 — surface every failure
            msg = str(exc)
            if "404 Client Error" in msg or "Repository Not Found" in msg:
                log.info(f"  . {upd.repo_id} ({upd.repo_type}) — skipped (repo does not exist)")
                skipped_missing += 1
            else:
                log.error(f"  - {upd.repo_id} ({upd.repo_type}) — {exc}")
                failure += 1

    print(f"\nUpdated: {success}; Skipped (missing): {skipped_missing}; Failed: {failure}")
    return 0 if failure == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
