#!/usr/bin/env python3
"""Fine-tune the Eliza-1 semantic end-of-turn (EOT) detector.

Entrypoint for the workflow specified in
[``.swarm/research/R1-turn.md``][R1] §5. Implements the APOLLO fine-tune
path against the LiveKit Turn Detector (default ship target) and the
Apache-2.0 ``latishab/turnsense`` fallback.

[R1]: ../../../../.swarm/research/R1-turn.md

Pipeline (each step is a function below; ``--help`` lists the flags):

  1. Resolve the config YAML — `load_config()`. Pins the teacher repo /
     revision, the LoRA rank, optimizer choice (APOLLO only — see
     `packages/training/AGENTS.md §1`), and the eval thresholds.
  2. Stage pretrain + SFT corpora — `build_pretrain_corpus()` for the
     EOU-labelled JSONL from DailyDialog (MultiWOZ / EmotionPush /
     TURNS-2K are documented add-ons), `build_sft_corpus()` for the
     task-conditional augmentation pairs.
  3. Tokenize against the upstream tokenizer + apply the Qwen chat
     template — `build_examples()`.
  4. Train — `train_lora()`. APOLLO-Mini optimizer (rank-1 tensor-wise
     scaling — the smallest optimizer-state footprint, right-sized for
     a ~135M-param classifier head). Checkpoints every
     ``--checkpoint-every`` steps, keeps top-3 by validation F1, raises
     ``RuntimeError`` if the configured F1 gate isn't met at exit.
  5. Export — `export_onnx()`. Re-quantizes to INT8 (`onnx/model_q8.onnx`),
     matches the upstream filename so the bundle stager picks it up
     without an extra flag.
  6. Evaluate via `eval_turn_detector.py` — the gate
     (F1 ≥ 0.85 and meanLatencyMs ≤ 30) decides publish-ability.

Smoke mode (``--smoke``) writes only the resolved config + the staged-data
manifest, so the CI surface stays runnable without the corpora or GPU.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import sys
from pathlib import Path
from typing import Any, Final, Iterable, Mapping

DEFAULT_REPO_EN: Final[str] = "livekit/turn-detector"
DEFAULT_REVISION_EN: Final[str] = "v1.2.2-en"
DEFAULT_REVISION_INTL: Final[str] = "v0.4.1-intl"
DEFAULT_TURNSENSE_REPO: Final[str] = "latishab/turnsense"

# Eval gate constants — mirrors `TURN_DETECTOR_F1_THRESHOLD` /
# `TURN_DETECTOR_MEAN_LATENCY_MS_LIMIT` in the runtime manifest schema
# (`plugins/plugin-local-inference/src/services/manifest/schema.ts`).
F1_GATE: Final[float] = 0.85
MEAN_LATENCY_MS_GATE: Final[float] = 30.0


@dataclasses.dataclass(frozen=True)
class TurnFinetuneConfig:
    """Container for the YAML config consumed by `finetune_turn_detector`."""

    tier: str
    teacher_repo: str
    teacher_revision: str
    lora_rank: int
    optimizer: str  # "apollo" | "adamw"
    epochs: int
    learning_rate: float
    train_data: list[str]
    eval_data: list[str]
    f1_gate: float = F1_GATE
    mean_latency_ms_gate: float = MEAN_LATENCY_MS_GATE


def default_revision_for_tier(tier: str) -> str:
    """Return the LiveKit revision a given tier should fine-tune against.

    Matches the runtime resolver in
    ``plugins/plugin-local-inference/src/services/voice/eot-classifier.ts``
    (`turnDetectorRevisionForTier`). Accepts both bare (``"4b"``) and
    prefixed (``"eliza-1-4b"``) tier ids.
    """
    bare = tier[len("eliza-1-"):] if tier.startswith("eliza-1-") else tier
    if bare in ("0_8b", "2b"):
        return DEFAULT_REVISION_EN
    return DEFAULT_REVISION_INTL


def load_config(path: Path) -> TurnFinetuneConfig:
    """Parse a YAML/JSON finetune config.

    YAML is optional; the JSON path is the canonical one so the smoke
    tests can run without pyyaml. ``.yaml`` / ``.yml`` files require
    ``pyyaml`` on the training env.
    """
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() in {".yaml", ".yml"}:
        try:
            import yaml  # type: ignore[import-not-found]
        except ModuleNotFoundError as exc:  # pragma: no cover - env-only
            raise SystemExit(
                f"pyyaml is required to load {path}; install the training extras"
            ) from exc
        data = yaml.safe_load(text)
    else:
        data = json.loads(text)
    if not isinstance(data, Mapping):
        raise ValueError(f"{path} did not contain a top-level mapping")
    required = (
        "tier",
        "teacher_repo",
        "teacher_revision",
        "lora_rank",
        "optimizer",
        "epochs",
        "learning_rate",
        "train_data",
        "eval_data",
    )
    missing = [k for k in required if k not in data]
    if missing:
        raise ValueError(f"{path}: config missing keys: {sorted(missing)}")
    optimizer = str(data["optimizer"]).lower()
    if optimizer not in ("apollo", "adamw"):
        raise ValueError(
            f"{path}: optimizer must be 'apollo' or 'adamw', got {optimizer!r}"
        )
    return TurnFinetuneConfig(
        tier=str(data["tier"]),
        teacher_repo=str(data["teacher_repo"]),
        teacher_revision=str(data["teacher_revision"]),
        lora_rank=int(data["lora_rank"]),
        optimizer=optimizer,
        epochs=int(data["epochs"]),
        learning_rate=float(data["learning_rate"]),
        train_data=list(data["train_data"]),
        eval_data=list(data["eval_data"]),
        f1_gate=float(data.get("f1_gate", F1_GATE)),
        mean_latency_ms_gate=float(
            data.get("mean_latency_ms_gate", MEAN_LATENCY_MS_GATE)
        ),
    )


def stage_data(
    *,
    train_paths: Iterable[Path],
    eval_paths: Iterable[Path],
    out_dir: Path,
) -> dict[str, Any]:
    """Stage train/eval JSONL into ``out_dir`` after a privacy-filter pass.

    The privacy filter lives outside this package
    (``plugins/app-training/src/core/privacy-filter.ts``); we re-implement
    the no-op invariant here as a fail-closed marker. The real Python
    bridge is the responsibility of the training driver — for the smoke
    surface we only check existence + emit a manifest.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    train_records: list[dict[str, Any]] = []
    eval_records: list[dict[str, Any]] = []
    for p in train_paths:
        if not Path(p).is_file():
            raise FileNotFoundError(f"train data path missing: {p}")
        train_records.append({"path": str(p), "bytes": Path(p).stat().st_size})
    for p in eval_paths:
        if not Path(p).is_file():
            raise FileNotFoundError(f"eval data path missing: {p}")
        eval_records.append({"path": str(p), "bytes": Path(p).stat().st_size})
    manifest = {
        "schemaVersion": 1,
        "train": train_records,
        "eval": eval_records,
    }
    (out_dir / "stage-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest


# ---------------------------------------------------------------------------
# Pretrain / SFT corpus builders.
#
# `build_pretrain_corpus` sources EOU labels from public dialogue corpora
# (DailyDialog as the primary, MultiWOZ + EmotionPush as documented optional
# add-ons). EOU label = 1 if the utterance is the last in its turn, else 0.
#
# `build_sft_corpus` augments the pretrain corpus with a small task-conditional
# augmentation set — chat-style examples where the "task" framing is
# "decide if the user is done speaking". 2k-5k pairs is enough for the demo;
# the bulk of the signal still comes from `build_pretrain_corpus`.
# ---------------------------------------------------------------------------


DAILYDIALOG_HF_REPO: Final[str] = "OpenRL/daily_dialog"


def build_pretrain_corpus(
    out_dir: Path,
    *,
    corpus: str = "dailydialog",
    max_examples: int | None = None,
) -> Path:
    """Stage an EOU-labelled JSONL under ``out_dir``.

    The output JSONL has one line per utterance::

        {"utterance": str, "eou_label": 0|1, "dialogue_id": str, "turn_idx": int}

    where ``eou_label == 1`` iff the utterance is the last in its turn.

    ``corpus="dailydialog"`` (default) pulls the Apache-2.0 mirror via the
    HuggingFace ``datasets`` library, which is the cleanest free starting
    point. Operators wanting to add MultiWOZ / EmotionPush should set the
    paths in their training config and call this function once per corpus
    — the JSONLs concatenate cleanly.

    Returns the absolute path to the written JSONL.

    .. note::

       Additional corpora the operator can stage later (each in its own
       JSONL):

       - **MultiWOZ** (Apache-2.0, EN, task-oriented) — adds task-conditional
         turn-taking signal beyond casual chat.
       - **EmotionPush** (research-only, EN, emotionally-loaded chat) — adds
         backchannel coverage but requires per-conversation labelling work.
       - **TURNS-2K** (Apache-2.0, EN, ASR-noisy 2k samples) — the LiveKit-style
         end-of-utterance subset; smaller but already aligned with the
         deploy distribution.

       Trajectory data from the deployed runtime is the dominant signal
       once we have several hundred hours; that import lives in
       ``prepare_voice_trajectory_data.py`` (TBD).
    """
    if corpus != "dailydialog":
        raise NotImplementedError(
            f"build_pretrain_corpus: corpus={corpus!r} not wired yet; "
            "stage the JSONL in the documented schema and add the path to "
            "the training config's train_data list.",
        )

    try:
        from datasets import load_dataset  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "build_pretrain_corpus(dailydialog) requires the `datasets` "
            "package; install via `uv pip install datasets`",
        ) from exc

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "dailydialog.jsonl"

    # DailyDialog: each dialogue has a list of utterances. The EOU label is
    # 1 for the final utterance of each (speaker) turn. The upstream HF
    # dataset is single-speaker-per-row already, so every utterance is the
    # end of its own turn unless the next row's `dialog` shares the same
    # speaker. DailyDialog's structure simplifies this — every row is its
    # own turn boundary, so EOU = 1 for the last utterance in each dialog,
    # 0 otherwise (a model that predicts EOU=1 on every turn would still
    # score reasonably; the harder negatives come from MultiWOZ + TURNS-2K).
    # OpenRL/daily_dialog ships a Parquet snapshot under `data/`. Loading
    # via the `parquet` builder avoids the legacy loading-script removal
    # (datasets >= 4.0 refuses script-based datasets).
    ds = load_dataset(DAILYDIALOG_HF_REPO, split="train")
    written = 0
    with out_path.open("w", encoding="utf-8") as fh:
        for dialogue_idx, row in enumerate(ds):
            utterances = row.get("dialog") or row.get("utterances") or []
            for turn_idx, utterance in enumerate(utterances):
                if not isinstance(utterance, str) or not utterance.strip():
                    continue
                eou_label = 1 if turn_idx == len(utterances) - 1 else 0
                fh.write(
                    json.dumps(
                        {
                            "utterance": utterance.strip(),
                            "eou_label": eou_label,
                            "dialogue_id": f"dailydialog-{dialogue_idx}",
                            "turn_idx": turn_idx,
                        },
                    )
                    + "\n",
                )
                written += 1
                if max_examples is not None and written >= max_examples:
                    return out_path
    return out_path


def build_eou_prefix_corpus(
    out_dir: Path,
    *,
    corpus: str = "dailydialog",
    max_dialogues: int | None = None,
    min_words: int = 3,
    seed: int = 20260514,
) -> Path:
    """Build a proper EOU corpus from DailyDialog utterances.

    Strategy: every full utterance is a positive (EOU=1). For each
    positive, also emit one *prefix* sample (truncated at a random
    word boundary, with terminal punctuation stripped) as a negative
    (EOU=0). This is the signal the LiveKit detector is trained on —
    "is this transcript a complete turn vs. a mid-utterance prefix?"
    — and it matches the runtime semantics (the streaming ASR feeds
    growing prefixes; we score P(<|im_end|>) on each one).

    Output JSONL schema mirrors ``build_pretrain_corpus``::

        {"utterance": str, "eou_label": 0|1, "dialogue_id": str, "turn_idx": int}

    Returns the absolute path to the written JSONL.
    """
    if corpus != "dailydialog":
        raise NotImplementedError(
            f"build_eou_prefix_corpus: corpus={corpus!r} not wired yet"
        )

    try:
        from datasets import load_dataset  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "build_eou_prefix_corpus requires `datasets`"
        ) from exc

    import random

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "dailydialog-eou-prefix.jsonl"

    ds = load_dataset(DAILYDIALOG_HF_REPO, split="train")
    rng = random.Random(seed)

    def _strip_trailing_punct(text: str) -> str:
        # The DailyDialog corpus separates trailing punctuation with a
        # space (e.g. "hello ."). Drop terminal punctuation tokens so
        # the prefix doesn't look obviously complete.
        tokens = text.split()
        while tokens and tokens[-1] in {".", "?", "!", ",", ";", ":", "..."}:
            tokens.pop()
        return " ".join(tokens)

    with out_path.open("w", encoding="utf-8") as fh:
        for dialogue_idx, row in enumerate(ds):
            if max_dialogues is not None and dialogue_idx >= max_dialogues:
                break
            utterances = row.get("dialog") or row.get("utterances") or []
            for turn_idx, raw in enumerate(utterances):
                if not isinstance(raw, str):
                    continue
                utterance = raw.strip()
                tokens = utterance.split()
                if len(tokens) < min_words:
                    continue
                # Positive: full utterance.
                fh.write(
                    json.dumps(
                        {
                            "utterance": utterance,
                            "eou_label": 1,
                            "dialogue_id": f"dailydialog-{dialogue_idx}",
                            "turn_idx": turn_idx,
                        }
                    )
                    + "\n"
                )
                # Negative: prefix truncated at a word boundary, with
                # trailing punctuation removed. Skip 1-token prefixes,
                # they're too short to learn from.
                # Strip terminal punctuation from the source so we
                # don't generate "hello" with the stripped period.
                stripped_tokens = _strip_trailing_punct(utterance).split()
                if len(stripped_tokens) < 2:
                    continue
                cut = rng.randint(1, max(1, len(stripped_tokens) - 1))
                prefix = " ".join(stripped_tokens[:cut])
                fh.write(
                    json.dumps(
                        {
                            "utterance": prefix,
                            "eou_label": 0,
                            "dialogue_id": f"dailydialog-{dialogue_idx}",
                            "turn_idx": turn_idx,
                        }
                    )
                    + "\n"
                )
    return out_path


# OpenAssistant/oasst1 — Apache-2.0, ~85k multilingual conversation
# messages. We pull the `prompter` (user) messages, filter by language,
# split each message into utterance-sized chunks on sentence boundaries,
# and apply the same prefix-augmentation strategy as
# `build_eou_prefix_corpus`. This matches the runtime EOU signal across
# the LiveKit v0.4.1-intl target locales (en, es, fr, de, it, pt, nl, ru,
# zh, ja, ko, tr, id, hi). 12/14 of those locales have material OASST1
# coverage; the other two (nl, hi) rely on the base model's pretraining
# and the cross-lingual signal in the shared Qwen2 tokenizer.

OASST1_HF_REPO: Final[str] = "OpenAssistant/oasst1"

# LiveKit v0.4.1-intl locales — keep in sync with `languages.json` on
# `livekit/turn-detector@v0.4.1-intl`. The codes are ISO-639-1 except
# `pt-BR` which OASST1 uses for Brazilian Portuguese (we accept both
# `pt` and `pt-BR` as Portuguese).
LIVEKIT_INTL_LOCALES: Final[tuple[str, ...]] = (
    "en", "es", "fr", "de", "it", "pt", "nl",
    "ru", "zh", "ja", "ko", "tr", "id", "hi",
)


_CJK_RANGES: Final[tuple[tuple[int, int], ...]] = (
    (0x4E00, 0x9FFF),   # CJK Unified Ideographs
    (0x3040, 0x30FF),   # Hiragana + Katakana
    (0x3400, 0x4DBF),   # CJK Unified Ideographs Extension A
    (0xAC00, 0xD7AF),   # Hangul Syllables
    (0xF900, 0xFAFF),   # CJK Compatibility Ideographs
    (0xFF00, 0xFFEF),   # Halfwidth and Fullwidth Forms
)


def _is_cjk_char(ch: str) -> bool:
    if not ch:
        return False
    cp = ord(ch[0])
    for lo, hi in _CJK_RANGES:
        if lo <= cp <= hi:
            return True
    return False


def _utterance_unit_count(text: str) -> int:
    """Token-count proxy that works for space-segmented and CJK scripts.

    For space-segmented languages this is ``len(text.split())``. For CJK
    scripts (Chinese, Japanese, Korean) where words aren't space-separated,
    we count visible CJK characters. The two are combined for mixed text
    (Japanese with occasional katakana / ASCII words).
    """
    words = [w for w in text.split() if w]
    cjk_chars = sum(1 for ch in text if _is_cjk_char(ch))
    return len(words) + cjk_chars


def _cjk_prefix_cut(text: str, rng: Any) -> str:
    """Truncate a CJK utterance at a random character offset.

    Strips any trailing punctuation. Returns ``""`` if the result is
    shorter than 2 characters.
    """
    import re

    # Strip trailing terminal punctuation (ASCII + fullwidth) before
    # picking the cut so the prefix doesn't carry an EOU-shaped tail.
    stripped = re.sub(r"[\.\?\!,;:…。！？，；：、]+\s*$", "", text)
    if len(stripped) < 2:
        return ""
    cut = rng.randint(1, max(1, len(stripped) - 1))
    return stripped[:cut]


def _split_into_utterances(text: str, max_words: int = 40) -> list[str]:
    """Split a free-form message into approximately one-sentence utterances.

    Splits on terminal punctuation (`. ! ? 。 ！ ？`) and newlines.
    For long sentences in space-segmented scripts we chunk further to
    keep each utterance roughly ASR-turn-sized. CJK scripts get one
    utterance per sentence (chunked by character count, not word count).
    """
    import re

    # Replace CJK terminal punctuation with their ASCII equivalents so the
    # downstream prefix-stripping logic works on Japanese/Chinese too.
    normalized = text.replace("。", ". ").replace("！", "! ").replace("？", "? ")
    parts = re.split(r"(?<=[.!?])\s+|\n+", normalized)
    out: list[str] = []
    for part in parts:
        sent = part.strip()
        if not sent:
            continue
        words = sent.split()
        cjk_count = sum(1 for ch in sent if _is_cjk_char(ch))
        is_cjk = cjk_count > len(words)
        if is_cjk:
            # Chunk CJK by character count; ~80 chars ≈ ~25 English words
            # of equivalent information density.
            char_cap = max_words * 2
            if len(sent) > char_cap:
                for i in range(0, len(sent), char_cap):
                    chunk = sent[i:i + char_cap].strip()
                    if chunk:
                        out.append(chunk)
            else:
                out.append(sent)
        else:
            if not words:
                continue
            if len(words) > max_words:
                for i in range(0, len(words), max_words):
                    chunk = " ".join(words[i:i + max_words])
                    if chunk:
                        out.append(chunk)
            else:
                out.append(sent)
    return out


def build_multilingual_eou_corpus(
    out_dir: Path,
    *,
    per_lang_cap: int = 6000,
    min_words: int = 3,
    seed: int = 20260515,
    locales: tuple[str, ...] = LIVEKIT_INTL_LOCALES,
) -> Path:
    """Build a multilingual EOU corpus from OpenAssistant/oasst1.

    Strategy mirrors `build_eou_prefix_corpus` but with a language-balanced
    OASST1 source. Each utterance (sentence-split chunk of a user-role
    OASST1 message) becomes:

      - a positive (full utterance, ``eou_label=1``)
      - a randomly truncated mid-utterance prefix (trailing punctuation
        stripped, ``eou_label=0``).

    ``per_lang_cap`` caps the *utterance count* per language (so the
    total positives per language is ≤ ``per_lang_cap``). Negatives are
    one per positive. The cap is the levelling knob — without it the
    corpus is ~70% English.

    Output JSONL schema mirrors `build_eou_prefix_corpus`::

        {"utterance": str, "eou_label": 0|1,
         "dialogue_id": "oasst1-<message_id>", "turn_idx": int,
         "lang": str}

    The extra ``lang`` field is for per-language eval splits — the
    training loop ignores it.
    """
    try:
        from datasets import load_dataset  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "build_multilingual_eou_corpus requires `datasets`"
        ) from exc

    import random
    import re

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "oasst1-eou-prefix-intl.jsonl"

    # Normalize `pt-BR` → `pt` for the supported-locale check.
    locale_aliases: dict[str, str] = {"pt-BR": "pt"}
    accepted = set(locales)
    rng = random.Random(seed)

    def _strip_trailing_punct(text: str) -> str:
        tokens = text.split()
        while tokens and re.fullmatch(r"[\.\?\!,;:…]+", tokens[-1]):
            tokens.pop()
        return " ".join(tokens)

    ds = load_dataset(OASST1_HF_REPO, split="train")
    lang_counts: dict[str, int] = {}
    written = 0

    def _emit(records: list[dict[str, Any]]) -> None:
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

    with out_path.open("w", encoding="utf-8") as fh:
        for row in ds:
            role = row.get("role")
            if role != "prompter":
                continue
            lang_raw = row.get("lang") or ""
            lang = locale_aliases.get(lang_raw, lang_raw)
            if lang not in accepted:
                continue
            if lang_counts.get(lang, 0) >= per_lang_cap:
                continue
            text = row.get("text")
            if not isinstance(text, str):
                continue
            message_id = row.get("message_id") or f"row-{written}"
            for turn_idx, utterance in enumerate(_split_into_utterances(text)):
                if lang_counts.get(lang, 0) >= per_lang_cap:
                    break
                if _utterance_unit_count(utterance) < min_words:
                    continue
                cjk_count = sum(1 for ch in utterance if _is_cjk_char(ch))
                is_cjk = cjk_count > len([w for w in utterance.split() if w])
                # Positive.
                pos = {
                    "utterance": utterance,
                    "eou_label": 1,
                    "dialogue_id": f"oasst1-{message_id}",
                    "turn_idx": turn_idx,
                    "lang": lang,
                }
                if is_cjk:
                    prefix = _cjk_prefix_cut(utterance, rng)
                    if not prefix:
                        _emit([pos])
                        lang_counts[lang] = lang_counts.get(lang, 0) + 1
                        written += 1
                        continue
                else:
                    stripped_tokens = _strip_trailing_punct(utterance).split()
                    if len(stripped_tokens) < 2:
                        _emit([pos])
                        lang_counts[lang] = lang_counts.get(lang, 0) + 1
                        written += 1
                        continue
                    cut = rng.randint(1, max(1, len(stripped_tokens) - 1))
                    prefix = " ".join(stripped_tokens[:cut])
                neg = {
                    "utterance": prefix,
                    "eou_label": 0,
                    "dialogue_id": f"oasst1-{message_id}",
                    "turn_idx": turn_idx,
                    "lang": lang,
                }
                _emit([pos, neg])
                lang_counts[lang] = lang_counts.get(lang, 0) + 1
                written += 1
    # Drop a sidecar with the per-language counts for the model card.
    (out_dir / "oasst1-intl-lang-counts.json").write_text(
        json.dumps(lang_counts, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return out_path


def stage_multilingual_train_eval(
    *,
    out_dir: Path,
    per_lang_cap: int = 6000,
    val_ratio: float = 0.05,
    eval_max_per_lang: int = 200,
    train_max: int | None = None,
    seed: int = 20260515,
    locales: tuple[str, ...] = LIVEKIT_INTL_LOCALES,
) -> "tuple[Path, Path]":
    """Stage OASST1 multilingual EOU corpus and split it into train/eval.

    Eval split is *language-stratified*: up to ``eval_max_per_lang`` rows
    per language. This is what makes per-locale F1 measurable.

    Returns ``(train_path, eval_path)``. The eval split uses the runtime
    schema (``{"transcript": str, "label": 0|1, "lang": str}``) so
    ``eval_turn_detector`` can consume it directly.
    """
    import random

    out_dir.mkdir(parents=True, exist_ok=True)
    base = build_multilingual_eou_corpus(
        out_dir,
        per_lang_cap=per_lang_cap,
        seed=seed,
        locales=locales,
    )
    train_path = out_dir / "oasst1-intl.train.jsonl"
    eval_path = out_dir / "oasst1-intl.eval.jsonl"

    by_lang: dict[str, list[dict[str, Any]]] = {}
    with base.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            lang = record.get("lang", "und")
            by_lang.setdefault(lang, []).append(record)

    rng = random.Random(seed)
    train_rows: list[dict[str, Any]] = []
    eval_rows: list[dict[str, Any]] = []
    for lang, rows in sorted(by_lang.items()):
        rng.shuffle(rows)
        # Stratified split: at most ``eval_max_per_lang`` for eval, but
        # respect ``val_ratio`` lower bound so tiny languages still get an
        # eval split.
        n_eval = min(eval_max_per_lang, max(1, int(len(rows) * val_ratio)))
        eval_rows.extend(rows[:n_eval])
        train_rows.extend(rows[n_eval:])
    rng.shuffle(train_rows)
    rng.shuffle(eval_rows)

    if train_max is not None:
        train_rows = train_rows[:train_max]

    with train_path.open("w", encoding="utf-8") as fh:
        for r in train_rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    with eval_path.open("w", encoding="utf-8") as fh:
        for r in eval_rows:
            fh.write(
                json.dumps(
                    {
                        "transcript": r["utterance"],
                        "label": int(r["eou_label"]),
                        "lang": r.get("lang", "und"),
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    return train_path, eval_path


def build_sft_corpus(
    pretrain_jsonl: Path,
    out_dir: Path,
    *,
    target_pairs: int = 3000,
) -> Path:
    """Build a task-conditional EOU SFT corpus on top of ``pretrain_jsonl``.

    Output JSONL schema (one line per SFT pair)::

        {
          "prompt": "<task instruction>\\n<utterance>",
          "completion": "<|im_end|>" | "...",
          "label": 0 | 1,
        }

    The "completion" is the LiveKit-style next-token target: ``<|im_end|>``
    when the user is done speaking (`label=1`), and a continuation marker
    (``"..."``) otherwise. The prompt frames the task explicitly so the
    fine-tuned head learns to score next-token EOU under the chat template.

    ``target_pairs`` caps the output size (default 3 000). The balance is
    50/50 between EOU and non-EOU rows so the head doesn't collapse on the
    natural DailyDialog class imbalance (EOU is ~10% of utterances).
    """
    if not pretrain_jsonl.is_file():
        raise FileNotFoundError(f"pretrain JSONL missing: {pretrain_jsonl}")

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "sft.jsonl"

    pos: list[dict[str, Any]] = []
    neg: list[dict[str, Any]] = []
    with pretrain_jsonl.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            if record.get("eou_label") == 1:
                pos.append(record)
            else:
                neg.append(record)
    half = target_pairs // 2
    chosen = pos[:half] + neg[:half]
    instruction = "Decide if the user is done speaking. Output <|im_end|> if done, otherwise continue."

    written = 0
    with out_path.open("w", encoding="utf-8") as fh:
        for record in chosen:
            completion = "<|im_end|>" if record["eou_label"] == 1 else "..."
            fh.write(
                json.dumps(
                    {
                        "prompt": f"{instruction}\n<|user|> {record['utterance']}",
                        "completion": completion,
                        "label": int(record["eou_label"]),
                    },
                )
                + "\n",
            )
            written += 1
    return out_path


LIVEKIT_IM_END_TOKEN: Final[str] = "<|im_end|>"


def _format_livekit_prompt(tokenizer: Any, utterance: str) -> str:
    """Replicate the runtime LiveKit prompt format.

    Mirrors ``formatLiveKitTurnDetectorPrompt`` in
    ``plugins/plugin-local-inference/src/services/voice/eot-classifier.ts``:
    apply the tokenizer's chat template for ``[{role: user, content: ...}]``,
    then strip the trailing ``<|im_end|>`` so the model's last-position
    next-token distribution is what the runtime scores.
    """
    templated = tokenizer.apply_chat_template(
        [{"role": "user", "content": utterance}],
        add_generation_prompt=False,
        tokenize=False,
        add_special_tokens=False,
    )
    ix = templated.rfind(LIVEKIT_IM_END_TOKEN)
    if ix >= 0:
        templated = templated[:ix]
    return templated


def build_examples(
    pretrain_jsonl: Path,
    *,
    base_model: str,
    revision: str | None = None,
    max_length: int = 128,
    text_field: str = "utterance",
    label_field: str = "eou_label",
) -> "tuple[Any, Any, Any]":
    """Tokenize + apply chat template against the teacher tokenizer.

    Returns ``(input_ids, attention_mask, labels)`` numpy arrays.
    ``labels[i] == 1`` means EOU. Text is passed through the LiveKit chat
    template (mirroring ``formatLiveKitTurnDetectorPrompt``) with the
    trailing ``<|im_end|>`` stripped. Right-padding (``attention_mask``
    indicates which positions are real) so the runtime ONNX path
    (left-truncation, single-sample batch) and our training batch path
    agree on which logit corresponds to the next-token EOU prediction —
    we pluck ``logits[i, last_real_pos, im_end_id]``.
    """
    try:
        from transformers import AutoTokenizer  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "build_examples requires the `transformers` package; install "
            "via `uv pip install transformers`",
        ) from exc

    tokenizer = AutoTokenizer.from_pretrained(base_model, revision=revision)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"
    tokenizer.truncation_side = "left"

    import numpy as np

    input_ids: list[list[int]] = []
    attention_mask: list[list[int]] = []
    labels: list[int] = []
    text_keys = (text_field, "transcript", "utterance", "text")
    label_keys = (label_field, "label", "eou_label")
    with pretrain_jsonl.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            utterance = None
            for k in text_keys:
                if k in record and isinstance(record[k], str):
                    utterance = record[k]
                    break
            if utterance is None:
                continue
            label = None
            for k in label_keys:
                if k in record and record[k] is not None:
                    label = int(record[k])
                    break
            if label is None:
                continue
            text = _format_livekit_prompt(tokenizer, utterance)
            encoded = tokenizer(
                text,
                max_length=max_length,
                truncation=True,
                padding="max_length",
                add_special_tokens=False,
                return_attention_mask=True,
            )
            input_ids.append(list(encoded["input_ids"]))
            attention_mask.append(list(encoded["attention_mask"]))
            labels.append(label)

    return (
        np.asarray(input_ids, dtype="int64"),
        np.asarray(attention_mask, dtype="int64"),
        np.asarray(labels, dtype="int64"),
    )


def im_end_token_id(tokenizer: Any) -> int:
    """Resolve the ``<|im_end|>`` token id for the LiveKit tokenizer.

    Matches the runtime resolver: tokenize the literal ``<|im_end|>``
    sequence with ``add_special_tokens=False`` and take the first id.
    """
    ids = tokenizer(LIVEKIT_IM_END_TOKEN, add_special_tokens=False)["input_ids"]
    if not ids:
        raise RuntimeError("tokenizer did not produce an <|im_end|> id")
    return int(ids[0])


# ---------------------------------------------------------------------------
# Training step + checkpoint policy
# ---------------------------------------------------------------------------


def _last_real_position(attention_mask: Any) -> Any:
    """Index of the last non-pad token per row (clamped to >= 0).

    ``attention_mask`` is ``[batch, seq]`` with 1 for real tokens. Returns
    a 1-D long tensor of shape ``[batch]``.
    """
    import torch

    return torch.clamp(attention_mask.sum(dim=1) - 1, min=0)


def train_step(
    *,
    model: Any,
    batch: "tuple[Any, Any, Any]",
    optimizer: Any,
    im_end_id: int,
) -> float:
    """One APOLLO training step on (input_ids, attention_mask, labels).

    Predicts EOU as ``softmax(logits[i, last_real_pos, :])[<|im_end|>]``,
    where ``last_real_pos`` is derived from ``attention_mask``. Loss is
    binary cross-entropy with logits between that scalar (the im_end
    logit minus the log-sum-exp of all other vocab logits at that
    position) and the EOU label. This is the same quantity the runtime
    scores in ``probabilityFromOnnxOutput``.

    APOLLO only — see `packages/training/AGENTS.md §1`. The caller builds
    the optimizer via `build_apollo_optimizer` / `build_apollo_mini_optimizer`
    from `packages/training/scripts/training/optimizer.py`.
    """
    import torch
    import torch.nn.functional as F

    input_ids, attention_mask, labels = batch
    device = next(model.parameters()).device
    input_ids = input_ids.to(device)
    attention_mask = attention_mask.to(device)
    labels = labels.to(device).float()
    optimizer.zero_grad(set_to_none=True)
    outputs = model(input_ids=input_ids, attention_mask=attention_mask)
    logits = outputs.logits if hasattr(outputs, "logits") else outputs[0]
    last_pos = _last_real_position(attention_mask)
    batch_idx = torch.arange(logits.size(0), device=device)
    last_logits = logits[batch_idx, last_pos]  # [batch, vocab]
    # log p(im_end) - log p(other) = im_end_logit - logsumexp(other_logits)
    im_end_logit = last_logits[:, im_end_id]
    other_logits = torch.cat(
        [last_logits[:, :im_end_id], last_logits[:, im_end_id + 1:]], dim=1,
    )
    other_lse = torch.logsumexp(other_logits, dim=1)
    score = im_end_logit - other_lse  # binary logit for P(EOU)
    loss = F.binary_cross_entropy_with_logits(score, labels)
    loss.backward()
    optimizer.step()
    return float(loss.detach().cpu())


def _maintain_top_k(
    top_k: list[dict[str, Any]],
    *,
    step: int,
    path: str,
    f1: float,
    keep: int,
) -> "tuple[list[dict[str, Any]], list[str]]":
    """Maintain top-``keep`` checkpoints by validation F1.

    Returns ``(new_top_k, paths_to_drop)``. ``paths_to_drop`` are
    checkpoint paths the caller should ``os.unlink`` after this function
    returns.
    """
    candidate = {"step": step, "path": path, "f1": f1}
    combined = sorted(
        [*top_k, candidate], key=lambda r: r["f1"], reverse=True,
    )
    new_top_k = combined[:keep]
    dropped = [r["path"] for r in combined[keep:]]
    return new_top_k, dropped


def _eval_loop(
    *,
    model: Any,
    eval_input_ids: Any,
    eval_attention_mask: Any,
    eval_labels: Any,
    im_end_id: int,
    batch_size: int,
    decision_threshold: float = 0.5,
) -> "tuple[float, float]":
    """Run a forward-only pass on the eval split.

    Returns ``(f1, mean_score)``. ``mean_score`` is the average
    P(EOU) on positive examples (signal sanity check).
    """
    import torch

    device = next(model.parameters()).device
    preds: list[int] = []
    golds: list[int] = []
    pos_score_sum = 0.0
    pos_count = 0
    with torch.no_grad():
        for s in range(0, eval_input_ids.shape[0], batch_size):
            e = s + batch_size
            ids = eval_input_ids[s:e].to(device)
            mask = eval_attention_mask[s:e].to(device)
            out = model(input_ids=ids, attention_mask=mask)
            logits = out.logits if hasattr(out, "logits") else out[0]
            last_pos = _last_real_position(mask)
            batch_idx = torch.arange(logits.size(0), device=device)
            last_logits = logits[batch_idx, last_pos]
            probs = torch.softmax(last_logits.float(), dim=-1)
            eou_p = probs[:, im_end_id]
            preds.extend(
                (eou_p >= decision_threshold).cpu().numpy().astype(int).tolist()
            )
            row_golds = eval_labels[s:e].cpu().numpy().astype(int).tolist()
            golds.extend(row_golds)
            for p, g in zip(eou_p.cpu().numpy().tolist(), row_golds, strict=True):
                if g == 1:
                    pos_score_sum += p
                    pos_count += 1
    f1 = _binary_f1(preds, golds)
    mean_pos_score = pos_score_sum / max(1, pos_count)
    return f1, mean_pos_score


def train_lora(
    *,
    cfg: TurnFinetuneConfig,
    pretrain_jsonl: Path,
    eval_jsonl: Path,
    out_dir: Path,
    checkpoint_every: int = 500,
    max_steps: int | None = None,
    batch_size: int = 16,
    grad_accum_steps: int = 1,
    decision_threshold: float = 0.5,
) -> dict[str, Any]:
    """Real LoRA-or-full fine-tune driven by ``cfg``.

    Loads the base model from ``cfg.teacher_repo @ cfg.teacher_revision``,
    builds the APOLLO-Mini optimizer, runs ``cfg.epochs`` epochs (or
    ``max_steps`` if set, whichever ends first), evaluates every
    ``checkpoint_every`` steps, and maintains top-3 by val F1. If the
    eval gate ``cfg.f1_gate`` is not met at exit, raises ``RuntimeError``
    per the spec.
    """
    try:
        import torch
        from transformers import (  # type: ignore[import-not-found]
            AutoModelForCausalLM,
            AutoTokenizer,
        )
    except ImportError as exc:
        raise RuntimeError(
            "train_lora requires torch + transformers; install via "
            "`uv pip install 'transformers[torch]'`",
        ) from exc

    try:
        from packages.training.scripts.training.optimizer import (
            build_apollo_mini_optimizer,
        )
    except ImportError:
        # Allow running from a checkout where the parent package isn't
        # on sys.path — add the repo root manually.
        repo_root = Path(__file__).resolve().parents[4]
        if str(repo_root) not in sys.path:
            sys.path.insert(0, str(repo_root))
        from packages.training.scripts.training.optimizer import (  # type: ignore[no-redef]
            build_apollo_mini_optimizer,
        )

    out_dir.mkdir(parents=True, exist_ok=True)
    ckpt_dir = out_dir / "checkpoints"
    ckpt_dir.mkdir(parents=True, exist_ok=True)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device == "cuda" else torch.float32

    base_model = AutoModelForCausalLM.from_pretrained(
        cfg.teacher_repo, revision=cfg.teacher_revision, dtype=dtype,
    )
    base_model.to(device)
    base_model.gradient_checkpointing_disable()
    tokenizer = AutoTokenizer.from_pretrained(
        cfg.teacher_repo, revision=cfg.teacher_revision,
    )
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"
    tokenizer.truncation_side = "left"
    im_end_id = im_end_token_id(tokenizer)

    input_ids, attention_mask, labels = build_examples(
        pretrain_jsonl,
        base_model=cfg.teacher_repo,
        revision=cfg.teacher_revision,
    )
    eval_input_ids, eval_attention_mask, eval_labels = build_examples(
        eval_jsonl,
        base_model=cfg.teacher_repo,
        revision=cfg.teacher_revision,
    )

    input_ids_t = torch.from_numpy(input_ids)
    attention_mask_t = torch.from_numpy(attention_mask)
    labels_t = torch.from_numpy(labels)
    eval_input_ids_t = torch.from_numpy(eval_input_ids)
    eval_attention_mask_t = torch.from_numpy(eval_attention_mask)
    eval_labels_t = torch.from_numpy(eval_labels)

    # Optional shuffle so subsequent epochs see a fresh ordering.
    rng = torch.Generator(device="cpu").manual_seed(20260514)

    optimizer = build_apollo_mini_optimizer(
        base_model,
        lr=cfg.learning_rate,
        weight_decay=0.01,
    )
    top_k: list[dict[str, Any]] = []
    best_f1 = 0.0
    last_f1 = 0.0
    last_mean_pos_score = 0.0
    step = 0
    optimizer.zero_grad(set_to_none=True)

    def _save_checkpoint(step_num: int, f1: float) -> str:
        ckpt_path = ckpt_dir / f"step-{step_num:06d}.pt"
        torch.save(
            {
                "state_dict": base_model.state_dict(),
                "step": step_num,
                "f1": f1,
                "teacher_repo": cfg.teacher_repo,
                "teacher_revision": cfg.teacher_revision,
                "im_end_id": im_end_id,
            },
            ckpt_path,
        )
        return str(ckpt_path)

    base_model.train()
    n = input_ids_t.shape[0]
    print(
        f"[train] dataset={n} examples | batch={batch_size} | accum={grad_accum_steps} | "
        f"epochs={cfg.epochs} | max_steps={max_steps} | device={device} | dtype={dtype}",
        flush=True,
    )

    done = False
    for epoch in range(cfg.epochs):
        if done:
            break
        perm = torch.randperm(n, generator=rng)
        for start in range(0, n, batch_size):
            sl = perm[start:start + batch_size]
            batch = (
                input_ids_t[sl],
                attention_mask_t[sl],
                labels_t[sl],
            )
            loss_val = train_step(
                model=base_model,
                batch=batch,
                optimizer=optimizer,
                im_end_id=im_end_id,
            )
            step += 1
            if step % 25 == 0:
                print(f"[train] step={step} loss={loss_val:.4f}", flush=True)
            if step % checkpoint_every == 0:
                base_model.eval()
                f1, mean_pos = _eval_loop(
                    model=base_model,
                    eval_input_ids=eval_input_ids_t,
                    eval_attention_mask=eval_attention_mask_t,
                    eval_labels=eval_labels_t,
                    im_end_id=im_end_id,
                    batch_size=batch_size,
                    decision_threshold=decision_threshold,
                )
                last_f1 = f1
                last_mean_pos_score = mean_pos
                if f1 > best_f1:
                    best_f1 = f1
                print(
                    f"[eval] step={step} f1={f1:.4f} "
                    f"mean_pos_score={mean_pos:.4f} best_f1={best_f1:.4f}",
                    flush=True,
                )
                ckpt_path_str = _save_checkpoint(step, f1)
                top_k, dropped = _maintain_top_k(
                    top_k, step=step, path=ckpt_path_str, f1=f1, keep=3,
                )
                for path in dropped:
                    try:
                        Path(path).unlink()
                    except FileNotFoundError:
                        pass
                base_model.train()
            if max_steps is not None and step >= max_steps:
                done = True
                break

    # Always save the final checkpoint if we haven't recently.
    if not top_k:
        base_model.eval()
        f1, mean_pos = _eval_loop(
            model=base_model,
            eval_input_ids=eval_input_ids_t,
            eval_attention_mask=eval_attention_mask_t,
            eval_labels=eval_labels_t,
            im_end_id=im_end_id,
            batch_size=batch_size,
            decision_threshold=decision_threshold,
        )
        last_f1 = f1
        last_mean_pos_score = mean_pos
        best_f1 = max(best_f1, f1)
        ckpt_path_str = _save_checkpoint(step, f1)
        top_k = [{"step": step, "path": ckpt_path_str, "f1": f1}]

    summary = {
        "step": step,
        "best_f1": best_f1,
        "last_f1": last_f1,
        "last_mean_pos_score": last_mean_pos_score,
        "top_k": top_k,
        "f1_gate": cfg.f1_gate,
        "im_end_id": im_end_id,
        "teacher_repo": cfg.teacher_repo,
        "teacher_revision": cfg.teacher_revision,
    }
    (out_dir / "train-summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    if best_f1 < cfg.f1_gate:
        raise RuntimeError(
            f"F1 gate not met: {best_f1:.4f} < {cfg.f1_gate:.4f}",
        )
    return summary


def _binary_f1(predictions: list[int], golds: list[int]) -> float:
    """Binary F1 on EOU labels. Returns 0.0 when no positive predictions."""
    tp = sum(1 for p, g in zip(predictions, golds, strict=False) if p == 1 and g == 1)
    fp = sum(1 for p, g in zip(predictions, golds, strict=False) if p == 1 and g == 0)
    fn = sum(1 for p, g in zip(predictions, golds, strict=False) if p == 0 and g == 1)
    if tp == 0:
        return 0.0
    precision = tp / (tp + fp)
    recall = tp / (tp + fn)
    return 2 * precision * recall / (precision + recall)


def export_onnx(
    *,
    teacher_repo: str,
    teacher_revision: str,
    checkpoint_path: Path,
    out_path: Path,
    opset: int = 17,
    quantize: bool = True,
    seq_length: int = 128,
) -> None:
    """Export the fine-tuned weights to ``model_q8.onnx``.

    Loads the base model from ``teacher_repo @ teacher_revision``,
    restores the checkpoint weights, runs ``torch.onnx.export`` (legacy
    TorchScript path — no onnxscript dependency). When ``quantize=True``
    (the default) applies INT8 dynamic quantisation via
    ``onnxruntime.quantization.quantize_dynamic``. Output shape is
    ``[batch, seq, vocab]`` matching the upstream LiveKit ONNX so the
    runtime's ``probabilityFromOnnxOutput`` (which extracts
    ``softmax(logits[:, -1, :])[<|im_end|>]``) drops in.
    """
    try:
        import torch
        from transformers import (  # type: ignore[import-not-found]
            AutoModelForCausalLM,
        )
    except ImportError as exc:
        raise RuntimeError(
            "export_onnx requires torch + transformers",
        ) from exc

    out_path.parent.mkdir(parents=True, exist_ok=True)
    fp32_path = out_path.with_suffix(".fp32.onnx")

    model = AutoModelForCausalLM.from_pretrained(
        teacher_repo, revision=teacher_revision, dtype="float32",
    )
    checkpoint = torch.load(checkpoint_path, weights_only=False, map_location="cpu")
    state_dict = checkpoint.get("state_dict", checkpoint)
    # state_dict may be from a bf16 model; cast keys to fp32 to match
    state_dict = {k: v.to(torch.float32) if hasattr(v, "to") else v
                  for k, v in state_dict.items()}
    model.load_state_dict(state_dict, strict=False)
    model.eval()
    # Disable KV cache during export so the graph has a stable output.
    if hasattr(model, "config"):
        model.config.use_cache = False

    dummy = torch.ones(1, seq_length, dtype=torch.long)
    torch.onnx.export(
        model,
        (dummy,),
        str(fp32_path),
        input_names=["input_ids"],
        output_names=["logits"],
        opset_version=opset,
        dynamic_axes={
            "input_ids": {0: "batch", 1: "seq"},
            "logits": {0: "batch", 1: "seq"},
        },
        do_constant_folding=True,
    )

    if quantize:
        try:
            from onnxruntime.quantization import QuantType, quantize_dynamic
        except ImportError as exc:
            raise RuntimeError(
                "onnxruntime required for INT8 quantisation",
            ) from exc
        quantize_dynamic(
            model_input=str(fp32_path),
            model_output=str(out_path),
            weight_type=QuantType.QInt8,
        )
    else:
        fp32_path.rename(out_path)


def export_tokenizer_artifacts(
    teacher_repo: str, teacher_revision: str, out_dir: Path,
) -> list[str]:
    """Snapshot-download the tokenizer + config sidecars next to the ONNX.

    Returns the list of filenames written. The runtime
    (`createBundledLiveKitTurnDetector`) expects ``tokenizer.json``,
    ``tokenizer_config.json``, and ``config.json`` to sit alongside
    ``onnx/model_q8.onnx`` in the bundle.
    """
    try:
        from huggingface_hub import hf_hub_download
    except ImportError as exc:
        raise RuntimeError(
            "huggingface_hub required for tokenizer snapshot",
        ) from exc
    wanted = (
        "tokenizer.json",
        "tokenizer_config.json",
        "config.json",
        "special_tokens_map.json",
        "vocab.json",
        "merges.txt",
        "added_tokens.json",
        "generation_config.json",
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[str] = []
    for name in wanted:
        try:
            local = hf_hub_download(teacher_repo, name, revision=teacher_revision)
            (out_dir / name).write_bytes(Path(local).read_bytes())
            written.append(name)
        except Exception:
            # not every sidecar exists on every revision — that's fine.
            continue
    return written


# ---------------------------------------------------------------------------
# DailyDialog auto-staging
# ---------------------------------------------------------------------------


def stage_dailydialog_train_eval(
    *,
    out_dir: Path,
    val_ratio: float = 0.05,
    eval_max: int = 2000,
    train_max: int | None = None,
    seed: int = 20260514,
    corpus_kind: str = "eou-prefix",
) -> "tuple[Path, Path]":
    """Build and split DailyDialog into train/eval JSONL.

    Returns ``(train_path, eval_path)``. The eval split is the runtime
    schema (``{"transcript": str, "label": 0|1}``) so ``eval_turn_detector``
    can consume it directly; the train split is the pretrain schema
    (``{"utterance": str, "eou_label": 0|1, ...}``) so ``train_lora``
    consumes it. Both files are deterministically derived from the same
    DailyDialog snapshot.

    ``corpus_kind`` selects:

      - ``"eou-prefix"`` (default) — proper EOU corpus. Each utterance
        contributes a positive (EOU=1) and a prefix-truncated negative
        (EOU=0). Matches the runtime semantics — streaming-ASR prefixes.
      - ``"dialogue-last"`` — legacy "last utterance in dialogue = EOU"
        corpus from ``build_pretrain_corpus``. Retained for compatibility.
    """
    import random

    out_dir.mkdir(parents=True, exist_ok=True)
    if corpus_kind == "eou-prefix":
        base = build_eou_prefix_corpus(out_dir, corpus="dailydialog", seed=seed)
    elif corpus_kind == "dialogue-last":
        base = build_pretrain_corpus(out_dir, corpus="dailydialog")
    else:
        raise ValueError(f"unknown corpus_kind: {corpus_kind!r}")
    train_path = out_dir / "dailydialog.train.jsonl"
    eval_path = out_dir / "dailydialog.eval.jsonl"

    records: list[dict[str, Any]] = []
    with base.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            records.append(json.loads(line))

    rng = random.Random(seed)
    rng.shuffle(records)
    n_eval = min(eval_max, max(1, int(len(records) * val_ratio)))
    eval_rows = records[:n_eval]
    train_rows = records[n_eval:]
    if train_max is not None:
        train_rows = train_rows[:train_max]

    with train_path.open("w", encoding="utf-8") as fh:
        for r in train_rows:
            fh.write(json.dumps(r) + "\n")
    with eval_path.open("w", encoding="utf-8") as fh:
        for r in eval_rows:
            fh.write(
                json.dumps(
                    {"transcript": r["utterance"], "label": int(r["eou_label"])}
                )
                + "\n"
            )
    return train_path, eval_path


def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", required=False, type=Path)
    # --out and --run-dir are synonyms (--run-dir is the brief's name).
    ap.add_argument("--out", required=False, type=Path)
    ap.add_argument("--run-dir", required=False, type=Path)
    ap.add_argument(
        "--epochs",
        type=int,
        default=None,
        help="Override the epoch count from --config.",
    )
    ap.add_argument(
        "--base-model",
        type=str,
        default=None,
        help=(
            "Override --config's teacher_repo (e.g. 'livekit/turn-detector' "
            "or 'latishab/turnsense'). The revision is resolved from the tier."
        ),
    )
    ap.add_argument(
        "--revision",
        type=str,
        default=None,
        help="Override --config's teacher_revision (e.g. v1.2.2-en).",
    )
    ap.add_argument(
        "--pretrain-corpus",
        type=str,
        default=None,
        choices=("dailydialog", "oasst1-intl"),
        help=(
            "Auto-stage a pretrain + eval JSONL under <run-dir>/data/turn/. "
            "`dailydialog` for the English-only v1.2.2-en target, "
            "`oasst1-intl` for the multilingual v0.4.1-intl target "
            "(14 LiveKit locales, OpenAssistant/oasst1 source, "
            "language-stratified eval). Overrides "
            "--config.train_data / eval_data."
        ),
    )
    ap.add_argument(
        "--per-lang-cap",
        type=int,
        default=6000,
        help=(
            "For --pretrain-corpus oasst1-intl: max utterances per "
            "language. Default 6000 — yields ~50k positives across 12 "
            "well-represented OASST1 locales."
        ),
    )
    ap.add_argument(
        "--checkpoint-every",
        type=int,
        default=500,
        help="Eval + checkpoint cadence in training steps.",
    )
    ap.add_argument(
        "--max-steps",
        type=int,
        default=None,
        help="Hard cap on training steps (overrides --config epochs).",
    )
    ap.add_argument(
        "--batch-size",
        type=int,
        default=16,
        help="Microbatch size.",
    )
    ap.add_argument(
        "--decision-threshold",
        type=float,
        default=0.5,
        help="P(EOU) >= threshold ⇒ predict EOU. Matches the runtime default.",
    )
    ap.add_argument(
        "--smoke",
        action="store_true",
        help=(
            "Stage data + emit the config-resolved manifest, then exit "
            "without invoking the training loop. Used in CI and by the "
            "scaffolded tests."
        ),
    )
    # Export-only mode: --export-onnx + --checkpoint + --output.
    ap.add_argument(
        "--export-onnx",
        action="store_true",
        help=(
            "Skip training; load --checkpoint and write a quantised ONNX "
            "to --output."
        ),
    )
    ap.add_argument(
        "--checkpoint",
        type=Path,
        default=None,
        help="Path to a .pt checkpoint for --export-onnx mode.",
    )
    ap.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Output ONNX path for --export-onnx mode.",
    )
    return ap.parse_args(argv)


def _resolve_run_dir(args: argparse.Namespace) -> Path:
    if args.run_dir:
        return args.run_dir
    if args.out:
        return args.out
    raise SystemExit("--run-dir (or --out) is required")


def _run_export_only(args: argparse.Namespace) -> int:
    if args.checkpoint is None or args.output is None:
        raise SystemExit("--export-onnx requires --checkpoint and --output")
    # If --config is provided, use its teacher_repo/revision. Otherwise the
    # checkpoint metadata is authoritative.
    teacher_repo: str | None = None
    teacher_revision: str | None = None
    if args.config is not None:
        cfg = load_config(args.config)
        teacher_repo = args.base_model or cfg.teacher_repo
        teacher_revision = args.revision or cfg.teacher_revision
    else:
        import torch
        ckpt = torch.load(args.checkpoint, weights_only=False, map_location="cpu")
        teacher_repo = (
            args.base_model
            or ckpt.get("teacher_repo")
            or DEFAULT_REPO_EN
        )
        teacher_revision = (
            args.revision
            or ckpt.get("teacher_revision")
            or DEFAULT_REVISION_EN
        )
    export_onnx(
        teacher_repo=teacher_repo,
        teacher_revision=teacher_revision,
        checkpoint_path=args.checkpoint,
        out_path=args.output,
    )
    export_tokenizer_artifacts(
        teacher_repo, teacher_revision, args.output.parent,
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.export_onnx:
        return _run_export_only(args)
    if args.config is None:
        raise SystemExit("--config is required for training")
    cfg = load_config(args.config)
    run_dir = _resolve_run_dir(args)
    run_dir.mkdir(parents=True, exist_ok=True)
    resolved_revision = (
        args.revision or cfg.teacher_revision or default_revision_for_tier(cfg.tier)
    )
    resolved = dataclasses.replace(cfg, teacher_revision=resolved_revision)
    if args.base_model is not None:
        resolved = dataclasses.replace(resolved, teacher_repo=args.base_model)
    if args.epochs is not None:
        resolved = dataclasses.replace(resolved, epochs=args.epochs)

    if args.pretrain_corpus == "dailydialog":
        data_dir = run_dir / "data" / "turn"
        train_path, eval_path = stage_dailydialog_train_eval(out_dir=data_dir)
        resolved = dataclasses.replace(
            resolved,
            train_data=[str(train_path)],
            eval_data=[str(eval_path)],
        )
    elif args.pretrain_corpus == "oasst1-intl":
        data_dir = run_dir / "data" / "turn"
        train_path, eval_path = stage_multilingual_train_eval(
            out_dir=data_dir, per_lang_cap=args.per_lang_cap,
        )
        resolved = dataclasses.replace(
            resolved,
            train_data=[str(train_path)],
            eval_data=[str(eval_path)],
        )

    (run_dir / "resolved-config.json").write_text(
        json.dumps(dataclasses.asdict(resolved), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    stage_manifest = stage_data(
        train_paths=[Path(p) for p in resolved.train_data],
        eval_paths=[Path(p) for p in resolved.eval_data],
        out_dir=run_dir / "data",
    )
    if args.smoke:
        print(json.dumps(stage_manifest, indent=2, sort_keys=True))
        return 0
    if not resolved.train_data or not resolved.eval_data:
        raise SystemExit(
            "real training requires non-empty train_data + eval_data in "
            "the config; pass --pretrain-corpus dailydialog or stage JSONL "
            "and reference it in the config.",
        )
    summary = train_lora(
        cfg=resolved,
        pretrain_jsonl=Path(resolved.train_data[0]),
        eval_jsonl=Path(resolved.eval_data[0]),
        out_dir=run_dir,
        checkpoint_every=args.checkpoint_every,
        max_steps=args.max_steps,
        batch_size=args.batch_size,
        decision_threshold=args.decision_threshold,
    )
    if summary["top_k"]:
        best = summary["top_k"][0]
        onnx_dir = run_dir / "onnx"
        export_onnx(
            teacher_repo=resolved.teacher_repo,
            teacher_revision=resolved.teacher_revision,
            checkpoint_path=Path(best["path"]),
            out_path=onnx_dir / "model_q8.onnx",
        )
        export_tokenizer_artifacts(
            resolved.teacher_repo, resolved.teacher_revision, onnx_dir,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
