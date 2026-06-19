#!/usr/bin/env python3
"""Smoke-test the multilingual ONNX turn detector on hand-crafted samples.

Per the O-turn-intl brief: smoke-test the exported INT8 ONNX on English
plus two non-English samples (Spanish, Japanese), covering complete
utterances and mid-utterance prefixes for each. Runs against the same
scoring path as ``probabilityFromOnnxOutput`` in the runtime:

    P(EOU) = softmax(logits[:, last_real_pos, :])[<|im_end|>]

Exit code:
  0 — every complete utterance scored ≥ ``--decision-threshold`` and
      every prefix scored < ``--decision-threshold``.
  1 — at least one classification disagreed.

The summary JSON (saved to ``--report``) records the raw probability
per row so we can chart the margin between complete/incomplete.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final


LIVEKIT_IM_END_TOKEN: Final[str] = "<|im_end|>"

# Hand-crafted bilingual EOU / non-EOU pairs. Each row covers a single
# "complete utterance vs. random mid-utterance prefix" comparison.
# Spanish + Japanese are required by the brief; we add German + Mandarin
# + French as bonus coverage because the LiveKit base model already
# claims support there.
SMOKE_CASES: Final[tuple[dict[str, Any], ...]] = (
    {
        "lang": "en",
        "complete": "Can you please tell me what time the meeting starts.",
        "prefix": "Can you please tell me what",
    },
    {
        "lang": "en",
        "complete": "I'm done speaking, your turn.",
        "prefix": "I'm done",
    },
    {
        "lang": "es",
        "complete": "¿Me puedes decir a qué hora empieza la reunión?",
        "prefix": "¿Me puedes decir a qué",
    },
    {
        "lang": "es",
        "complete": "He terminado de hablar, te toca.",
        "prefix": "He terminado",
    },
    {
        "lang": "ja",
        "complete": "会議は何時に始まりますか？",
        "prefix": "会議は何時",
    },
    {
        "lang": "ja",
        "complete": "もう話し終わりました、どうぞ。",
        "prefix": "もう話",
    },
    {
        "lang": "de",
        "complete": "Können Sie mir bitte sagen, wann das Meeting beginnt?",
        "prefix": "Können Sie mir bitte",
    },
    {
        "lang": "zh",
        "complete": "请问会议什么时候开始？",
        "prefix": "请问会议",
    },
    {
        "lang": "fr",
        "complete": "Pouvez-vous me dire à quelle heure commence la réunion ?",
        "prefix": "Pouvez-vous me dire à",
    },
)


@dataclass
class SmokeRow:
    lang: str
    text: str
    expected: int  # 1 = complete (EOU), 0 = prefix
    probability: float

    def predicted(self, threshold: float) -> int:
        return 1 if self.probability >= threshold else 0


def _format_livekit_prompt(tokenizer: Any, transcript: str) -> str:
    templated = tokenizer.apply_chat_template(
        [{"role": "user", "content": transcript}],
        add_generation_prompt=False,
        tokenize=False,
        add_special_tokens=False,
    )
    ix = templated.rfind(LIVEKIT_IM_END_TOKEN)
    if ix >= 0:
        templated = templated[:ix]
    return templated


def _resolve_im_end_id(tokenizer: Any) -> int:
    ids = tokenizer(LIVEKIT_IM_END_TOKEN, add_special_tokens=False)["input_ids"]
    if not ids:
        raise SystemExit("tokenizer did not produce an <|im_end|> id")
    return int(ids[0])


def smoke_test(
    *,
    model_path: Path,
    tokenizer_path: Path,
    decision_threshold: float = 0.5,
    cases: tuple[dict[str, Any], ...] = SMOKE_CASES,
) -> dict[str, Any]:
    """Run the smoke set against the fine-tuned ONNX.

    Returns a dict with::

        {
          "passed": bool,
          "decision_threshold": float,
          "rows": list[{"lang", "text", "expected", "probability", "predicted"}],
          "summary": {
            "<lang>": {"complete": [float], "prefix": [float], "passed": bool},
            ...
          }
        }
    """
    try:
        import numpy as np
        import onnxruntime
        from transformers import AutoTokenizer
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "onnxruntime + transformers required for smoke test"
        ) from exc

    tokenizer = AutoTokenizer.from_pretrained(str(tokenizer_path))
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    im_end_id = _resolve_im_end_id(tokenizer)
    session = onnxruntime.InferenceSession(
        str(model_path), providers=["CPUExecutionProvider"],
    )

    rows: list[SmokeRow] = []

    def _score(transcript: str) -> float:
        prompt = _format_livekit_prompt(tokenizer, transcript)
        encoded = tokenizer(
            prompt,
            return_tensors="np",
            max_length=128,
            truncation=True,
            add_special_tokens=False,
        )
        outputs = session.run(
            None, {"input_ids": encoded["input_ids"].astype("int64")}
        )
        logits = outputs[0][0, -1, :].astype("float64")
        logits = logits - logits.max()
        probs = np.exp(logits) / np.exp(logits).sum()
        return float(probs[im_end_id])

    for case in cases:
        lang = case["lang"]
        rows.append(
            SmokeRow(
                lang=lang,
                text=case["complete"],
                expected=1,
                probability=_score(case["complete"]),
            )
        )
        rows.append(
            SmokeRow(
                lang=lang,
                text=case["prefix"],
                expected=0,
                probability=_score(case["prefix"]),
            )
        )

    summary: dict[str, dict[str, Any]] = {}
    for row in rows:
        bucket = summary.setdefault(
            row.lang, {"complete": [], "prefix": [], "passed": True},
        )
        if row.expected == 1:
            bucket["complete"].append(round(row.probability, 6))
        else:
            bucket["prefix"].append(round(row.probability, 6))
        if row.predicted(decision_threshold) != row.expected:
            bucket["passed"] = False

    all_passed = all(b["passed"] for b in summary.values())

    return {
        "passed": all_passed,
        "decision_threshold": decision_threshold,
        "rows": [
            {
                "lang": r.lang,
                "text": r.text,
                "expected": r.expected,
                "probability": round(r.probability, 6),
                "predicted": r.predicted(decision_threshold),
            }
            for r in rows
        ],
        "summary": summary,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", required=True, type=Path)
    ap.add_argument(
        "--tokenizer",
        required=True,
        type=Path,
        help="Directory containing tokenizer.json + sidecars.",
    )
    ap.add_argument("--report", type=Path, default=None)
    ap.add_argument("--decision-threshold", type=float, default=0.5)
    args = ap.parse_args(sys.argv[1:] if argv is None else argv)

    report = smoke_test(
        model_path=args.model,
        tokenizer_path=args.tokenizer,
        decision_threshold=args.decision_threshold,
    )
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(
            json.dumps(report, indent=2, sort_keys=False, ensure_ascii=False)
            + "\n",
            encoding="utf-8",
        )
    print(json.dumps(report, indent=2, sort_keys=False, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
