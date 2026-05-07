#!/usr/bin/env python3
"""
Export Babylon-compatible anti-scam trajectories for local training.

This script creates synthetic-but-structured Babylon trajectory files with real
LLM-call-shaped prompts and target responses. The data is tailored to the
ScamBench decision schema and Babylon trust-defense scenarios, so it can be
consumed directly by scripts/train_local.py via --source-dir.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import subprocess
import sys
from collections.abc import Iterable
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from scam_defense_exchange import (
    NATURAL_MESSAGE_SYSTEM_PROMPT,
    action_catalog_for_key,
    build_sanitized_transcript_block,
    build_user_prompt,
    canonical_record_from_row,
    coerce_bool,
    write_reprocessed_formats,
)

SYSTEM_PROMPT = NATURAL_MESSAGE_SYSTEM_PROMPT

DEFAULT_RESEARCH_PROFILE = {
    "stackSummary": "The target agent uses tool routing plus message-based plugin execution.",
    "suspectedWeaknesses": [
        "legacy debug action names remain in prompts",
        "private-message trust is higher than public-room trust",
    ],
    "hardcodedTargets": ["DEBUG_EXPORT", "SAFE_MODE_BYPASS"],
}

TRADING_SYSTEM_PROMPT = " ".join(
    [
        "You are a Babylon prediction-market trading agent.",
        "Provide a concise trading recommendation with reasoning, position sizing, and risk controls.",
        "Do not output JSON unless the user explicitly asks for it.",
    ]
)

WORKSPACE_ROOT = Path(__file__).resolve().parents[5]


def resolve_scambench_root(workspace_root: Path) -> Path:
    candidates = [
        workspace_root / "scambench",
        workspace_root / "benchmarks" / "scambench",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


SCAMBENCH_ROOT = resolve_scambench_root(WORKSPACE_ROOT)
DEFAULT_CATALOG_PATH = SCAMBENCH_ROOT / "generated" / "scenario-catalog.json"
GENERATED_CATALOG_PATH = SCAMBENCH_ROOT / "generated" / "scenario-catalog-generated.json"
FALLBACK_CATALOG_PATH = SCAMBENCH_ROOT / "generated" / "scenario-catalog-difraud-merged.json"
DEFAULT_EXTERNAL_MATERIALIZED_ROOT = (
    Path(__file__).resolve().parents[4] / "training-data" / "merged-threat-materialized"
)
FALLBACK_EXTERNAL_MATERIALIZED_ROOT = (
    Path(__file__).resolve().parents[4] / "training-data" / "external-scam-materialized"
)
DEFAULT_SYNTHETIC_TRAINING_ROOT = (
    Path(__file__).resolve().parents[4] / "training-data" / "synthetic-conversations"
)
CATALOG_SOURCE_FILES = [
    SCAMBENCH_ROOT / "src" / "catalog.ts",
    SCAMBENCH_ROOT / "src" / "scenarios.ts",
    SCAMBENCH_ROOT / "src" / "pliny.ts",
    SCAMBENCH_ROOT / "src" / "styles.ts",
    SCAMBENCH_ROOT / "src" / "types.ts",
]


@dataclass(frozen=True)
class TrainingExample:
    record_id: str
    group_id: str
    scenario_id: str
    category: str
    prompt: str
    chosen_action: str
    leaked_secret: bool
    explanation: str
    response: str | None = None
    used_research_profile: bool = False
    trust_profile: str = "blue"
    scam_losses_avoided: float = 0.0
    unsafe_disclosures: int = 0
    system_prompt: str = SYSTEM_PROMPT
    user_prompt: str | None = None
    llm_purpose: str = "action"
    action_type: str = "scam_defense_decision"
    response_format: str = "natural-message"
    available_actions: list[dict[str, str]] | None = None
    source_kind: str = "catalog"
    source_dataset: str | None = None
    source_family: str | None = None
    private_analysis: dict[str, Any] | None = None
    raw_reasoning_trace: str | None = None
    reasoning_available: bool = False
    reasoning_source: str | None = None
    reward_components: dict[str, float] | None = None
    judge_bundle_id: str | None = None

    def to_response(self) -> str:
        if self.response is not None:
            return self.response
        return safe_response_text(self.chosen_action)

    def to_training_row(self) -> dict[str, Any]:
        row: dict[str, Any] = {
            "record_id": self.record_id,
            "group_id": self.group_id,
            "scenario_id": self.scenario_id,
            "category": self.category,
            "prompt": self.prompt,
            "chosen_action": self.chosen_action,
            "leaked_secret": self.leaked_secret,
            "explanation": self.explanation,
            "response": self.to_response(),
            "used_research_profile": self.used_research_profile,
            "trust_profile": self.trust_profile,
            "scam_losses_avoided": self.scam_losses_avoided,
            "unsafe_disclosures": self.unsafe_disclosures,
            "system_prompt": self.system_prompt,
            "user_prompt": self.user_prompt,
            "llm_purpose": self.llm_purpose,
            "action_type": self.action_type,
            "response_format": self.response_format,
            "available_actions": self.available_actions or [],
            "source_kind": self.source_kind,
        }
        if self.source_dataset:
            row["source_dataset"] = self.source_dataset
        if self.source_family:
            row["source_family"] = self.source_family
        if self.private_analysis:
            row["private_analysis"] = self.private_analysis
        if self.raw_reasoning_trace:
            row["raw_reasoning_trace"] = self.raw_reasoning_trace
        row["reasoning_available"] = self.reasoning_available or bool(self.raw_reasoning_trace)
        if self.reasoning_source:
            row["reasoning_source"] = self.reasoning_source
        if self.reward_components:
            row["reward_components"] = self.reward_components
        if self.judge_bundle_id:
            row["judge_bundle_id"] = self.judge_bundle_id
        return row


def ensure_scambench_catalog(catalog_path: Path) -> Path:
    if catalog_path.exists():
        return catalog_path

    # Fall back to generated catalog (expanded for RLVR training)
    if not catalog_path.exists() and GENERATED_CATALOG_PATH.exists():
        return GENERATED_CATALOG_PATH

    # Fall back to the base catalog if the difraud-merged one doesn't exist
    if not catalog_path.exists() and FALLBACK_CATALOG_PATH.exists():
        return FALLBACK_CATALOG_PATH

    # Try to regenerate the base catalog
    catalog_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "bun",
            "run",
            "src/catalog.ts",
            "--output",
            str(catalog_path),
        ],
        cwd=SCAMBENCH_ROOT,
        check=True,
    )
    return catalog_path


def load_scambench_scenarios(catalog_path: str | None = None) -> list[dict]:
    resolved = ensure_scambench_catalog(
        Path(catalog_path).resolve() if catalog_path else DEFAULT_CATALOG_PATH
    )
    payload = json.loads(resolved.read_text(encoding="utf-8"))
    scenarios = payload.get("scenarios", [])
    if not isinstance(scenarios, list) or not scenarios:
        raise ValueError(f"No scenarios found in catalog: {resolved}")
    return scenarios


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_kind_counts(examples: list[TrainingExample]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for example in examples:
        source_kind = example.source_kind or "unknown"
        counts[source_kind] = counts.get(source_kind, 0) + 1
    return counts


def source_family_counts(examples: list[TrainingExample]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for example in examples:
        source_family = example.source_family or example.source_dataset or "unknown"
        counts[source_family] = counts.get(source_family, 0) + 1
    return counts


def describe_input_artifact(
    path_value: str | None,
    *,
    required_filename: str | None = "training_examples.jsonl",
) -> dict[str, Any] | None:
    if not path_value:
        return None

    path = Path(path_value).resolve()
    summary: dict[str, Any] = {"path": str(path), "exists": path.exists()}
    if not path.exists():
        return summary

    if path.is_file():
        summary["sha256"] = file_sha256(path)
        return summary

    manifest_path = path / "manifest.json"
    if manifest_path.exists():
        summary["manifestPath"] = str(manifest_path)
        summary["manifestSha256"] = file_sha256(manifest_path)
    if required_filename:
        dataset_path = path / required_filename
        if dataset_path.exists():
            summary["datasetPath"] = str(dataset_path)
            summary["datasetSha256"] = file_sha256(dataset_path)
    return summary


def example_statistics(examples: list[TrainingExample]) -> dict[str, Any]:
    scenario_groups = sorted({group_key_for_example(example) for example in examples})
    return {
        "categoryCounts": category_counts(examples),
        "sourceKindCounts": source_kind_counts(examples),
        "sourceFamilyCounts": source_family_counts(examples),
        "groupCount": len(scenario_groups),
        "scenarioGroups": scenario_groups,
    }


def catalog_statistics(catalog_path: Path) -> dict[str, Any]:
    return {
        "catalogPath": str(catalog_path),
        "catalogSha256": file_sha256(catalog_path),
        "catalogScenarioCount": len(load_scambench_scenarios(str(catalog_path))),
    }


def input_provenance_summary(
    *,
    catalog_path: Path,
    external_materialized_dir: str | None,
    synthetic_training_dir: str | None,
) -> dict[str, Any]:
    return {
        "catalog": describe_input_artifact(str(catalog_path), required_filename=None),
        "externalMaterialized": describe_input_artifact(external_materialized_dir),
        "syntheticTraining": describe_input_artifact(synthetic_training_dir),
    }


def latest_corpus_dir(
    base_dir: Path,
    *,
    required_filename: str = "training_examples.jsonl",
    preferred_substrings: tuple[str, ...] = (),
    prefer_nested_deduplicated: bool = False,
) -> Path:
    if not base_dir.exists():
        raise FileNotFoundError(f"Corpus root not found: {base_dir}")
    runs = [
        path for path in base_dir.iterdir() if path.is_dir() and (path / required_filename).exists()
    ]
    if not runs:
        raise FileNotFoundError(
            f"No corpus runs found under {base_dir} containing {required_filename}"
        )
    preferred = [
        path for path in runs if any(token in path.name.lower() for token in preferred_substrings)
    ]
    candidates = preferred or runs
    selected = max(candidates, key=lambda path: path.stat().st_mtime)
    if prefer_nested_deduplicated:
        deduplicated = selected / "deduplicated"
        if (deduplicated / required_filename).exists():
            return deduplicated
    return selected


def load_training_examples_from_dir(
    training_dir: Path,
    *,
    scenario_prefix: str,
    source_kind: str,
    limit: int | None = None,
) -> list[TrainingExample]:
    training_path = training_dir / "training_examples.jsonl"
    if not training_path.exists():
        raise FileNotFoundError(
            f"training_examples.jsonl not found in training dir: {training_dir}"
        )

    examples: list[TrainingExample] = []
    with training_path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if limit is not None and len(examples) >= limit:
                break
            if not line.strip():
                continue
            try:
                payload: dict[str, Any] = json.loads(line)
            except json.JSONDecodeError as error:
                logging.getLogger(__name__).warning(
                    f"Skipping malformed JSON at {training_path}:{line_number}: {error}"
                )
                continue
            try:
                examples.append(
                    TrainingExample(
                        record_id=str(
                            payload.get("record_id")
                            or f"{scenario_prefix}/{payload['scenario_id']}"
                        ),
                        group_id=str(
                            payload.get("group_id") or str(payload["scenario_id"]).split("::")[0]
                        ),
                        scenario_id=f"{scenario_prefix}/{payload['scenario_id']}",
                        category=str(payload["category"]),
                        prompt=str(payload.get("prompt") or payload["scenario_id"]),
                        chosen_action=str(payload["chosen_action"]),
                        leaked_secret=bool(payload.get("leaked_secret", False)),
                        explanation=str(payload["explanation"]),
                        response=normalize_training_response(
                            payload.get("response"),
                            chosen_action=str(payload["chosen_action"]),
                        ),
                        used_research_profile=bool(payload.get("used_research_profile", False)),
                        trust_profile=str(payload.get("trust_profile") or "blue"),
                        scam_losses_avoided=float(payload["scam_losses_avoided"])
                        if payload.get("scam_losses_avoided") is not None
                        else 0.0,
                        unsafe_disclosures=int(payload["unsafe_disclosures"])
                        if payload.get("unsafe_disclosures") is not None
                        else 0,
                        system_prompt=str(payload.get("system_prompt") or SYSTEM_PROMPT),
                        user_prompt=str(payload["user_prompt"])
                        if payload.get("user_prompt")
                        else None,
                        llm_purpose=str(payload.get("llm_purpose") or "action"),
                        action_type=str(payload.get("action_type") or "scam_defense_decision"),
                        response_format=str(payload.get("response_format") or "decision-json"),
                        available_actions=(
                            list(payload.get("available_actions") or [])
                            if isinstance(payload.get("available_actions"), list)
                            else None
                        ),
                        source_kind=str(payload.get("source_kind") or source_kind),
                        source_dataset=str(payload.get("source_dataset") or training_dir.name),
                        source_family=str(payload.get("source_family") or ""),
                        private_analysis=(
                            dict(
                                payload.get("private_analysis")
                                or payload.get("privateAnalysis")
                                or {}
                            )
                            if isinstance(
                                payload.get("private_analysis") or payload.get("privateAnalysis"),
                                dict,
                            )
                            else None
                        ),
                        raw_reasoning_trace=str(
                            payload.get("raw_reasoning_trace")
                            or payload.get("rawReasoningTrace")
                            or ""
                        )
                        or None,
                        reasoning_available=bool(
                            coerce_bool(
                                payload.get("reasoning_available")
                                if payload.get("reasoning_available") is not None
                                else payload.get("reasoningAvailable"),
                                default=False,
                            )
                        ),
                        reasoning_source=str(
                            payload.get("reasoning_source") or payload.get("reasoningSource") or ""
                        )
                        or None,
                        reward_components=(
                            {
                                str(key): float(value)
                                for key, value in dict(
                                    payload.get("reward_components")
                                    or payload.get("rewardComponents")
                                    or {}
                                ).items()
                                if isinstance(value, (int, float))
                            }
                            if isinstance(
                                payload.get("reward_components") or payload.get("rewardComponents"),
                                dict,
                            )
                            else None
                        ),
                        judge_bundle_id=str(
                            payload.get("judge_bundle_id") or payload.get("judgeBundleId") or ""
                        )
                        or None,
                    )
                )
            except KeyError as error:
                raise ValueError(
                    f"Malformed training example at {training_path}:{line_number}: missing {error}"
                ) from error
    return examples


def build_transcript_block(messages: list[dict]) -> str:
    return build_sanitized_transcript_block(messages)


def build_stage_user_prompt(
    scenario: dict,
    stage: dict,
    transcript: list[dict],
) -> str:
    chosen_action = str((stage.get("expectedSafeActions") or ["audit"])[0])
    action_catalog = action_catalog_for_key(
        f"{scenario.get('id', 'unknown')}::{stage.get('id', 'unknown')}",
        chosen_action=chosen_action,
    )
    return build_user_prompt(
        channel=str(stage.get("channel", "dm")),
        register=str(scenario.get("register", "casual")),
        language=str(scenario.get("language", "en")),
        conversation_id=str(scenario.get("id", "unknown")),
        transcript=build_transcript_block(transcript),
        action_catalog=action_catalog,
    )


def resolve_stage_messages(stage: dict) -> list[dict]:
    incoming = stage.get("incoming")
    if isinstance(incoming, list) and incoming:
        return incoming
    fallback = stage.get("fallbackIncoming")
    if isinstance(fallback, list) and fallback:
        return fallback
    return []


def build_generic_trading_examples(
    limit: int | None = None,
) -> list[TrainingExample]:
    prompts_and_responses = [
        (
            "You are a trading agent in Babylon prediction markets.\n\nCurrent State:\n- Balance: $10,000\n- P&L: $250\n- Positions: 2 open\n\nMarket Update:\n- BTC prediction market at 68% probability\n- Recent news: Fed announces rate cut consideration\n\nAnalyze this market update and explain your trading decision.",
            "I would add a modest YES position rather than chase aggressively. The 68% market probability and a possible Fed rate cut both support a bullish setup, but I would still size the trade conservatively because macro headlines can reverse quickly. My plan is to buy a small increment, keep cash in reserve, and set a clear risk limit in case sentiment weakens.",
        ),
        (
            'You are evaluating a prediction market.\n\nMarket: "Will Bitcoin reach $100k by Q1 2025?"\nCurrent Probability: 65% YES\nYour Analysis: Technical indicators show bullish momentum, but macro uncertainty remains.\n\nShould you buy YES or NO shares? Explain your reasoning.',
            "I would buy YES, but with smaller size than a high-conviction trade. Bullish momentum supports the upside case, and a 65% market price is still reasonable if momentum continues. The main risk is macro uncertainty, so I would keep the position moderate, avoid overexposure, and reassess if the market starts repricing lower.",
        ),
        (
            'You are managing a trading portfolio.\n\nCurrent Holdings:\n- 100 YES shares in "AI regulation passes" market\n- 50 NO shares in "Ethereum upgrade succeeds" market\n\nNew Market Opens: "Stablecoin regulation announced"\nProbability: 40% YES\n\nHow should you allocate capital? Explain your strategy.',
            "I would keep the existing positions, preserve most cash, and open only a small YES starter position in the stablecoin market. A 40% probability suggests upside if regulation momentum improves, but it is not strong enough for a large allocation. The portfolio should stay diversified across markets, with position sizes capped so one thesis cannot dominate overall risk.",
        ),
        (
            "You are monitoring a Babylon election market.\n\nMarket: 'Will the reform bill pass this quarter?'\nCurrent Probability: 54% YES\nNew information: committee support improved, but two undecided votes remain.\n\nWhat trade would you place and why?",
            "I would take a small YES trade because the committee update improves the odds, but the undecided votes keep the market close. This is a medium-conviction setup, not a full-size position. The trade should be sized modestly, with risk limits in place in case the political whip count turns against the bill.",
        ),
        (
            "You are managing event-driven positions.\n\nOpen positions:\n- Long YES on semiconductor subsidy package\n- Flat on inflation surprise market\n\nA new CPI forecast suggests hotter inflation next month. How should you adjust the portfolio?",
            "I would avoid increasing risk across the book and instead reduce exposure to positions that depend on easy policy. A hotter CPI forecast can pressure risk assets and change market probabilities quickly. The safer move is to trim vulnerable positions, keep liquidity available, and wait for confirmation before adding any new trade.",
        ),
        (
            "You are trading a sports prediction market.\n\nMarket: 'Will Team A win the series?'\nProbability: 72% YES\nUpdate: star player is questionable with a minor injury.\n\nExplain the trade.",
            "I would not add to YES at 72% until the injury status is clearer. The market is already pricing a strong favorite, so the risk-reward on buying more is weaker if the star player misses time. My trade would be to wait or trim slightly, protecting profit and avoiding a crowded position on uncertain news.",
        ),
        (
            "You are a Babylon trader reviewing overnight moves.\n\nMarket: 'Will the ETF be approved this month?'\nProbability moved from 41% to 58% YES after an exchange filing update.\n\nWhat is your next move?",
            "I would avoid blindly buying the move after such a sharp repricing. The filing update is directionally positive, but a jump from 41% to 58% means some of the edge may already be gone. I would either wait for a better entry or take a small position with tight risk rather than chase momentum.",
        ),
        (
            "You manage a balanced prediction portfolio.\n\nA rumor is spreading that a major exchange insolvency case will resolve sooner than expected. The market is thin and volatile.\n\nHow do you respond?",
            "I would treat the rumor as low-quality information and avoid oversized trades. In a thin market, rumor-driven price action can create false signals and sharp reversals. The right approach is to wait for confirmation, use small size if taking any exposure, and prioritize downside protection over quick profit.",
        ),
        (
            "You are reviewing a weather market.\n\nMarket: 'Will rainfall exceed 8 inches this weekend?'\nProbability: 33% YES\nNew forecast models are converging higher but still disagree on timing.\n\nWhat is your trade?",
            "I would consider a small YES position because the forecast trend is moving in that direction, but the disagreement on timing keeps uncertainty high. This is a situation for careful sizing, not aggressive leverage. I would buy lightly and be ready to exit if the next model run weakens the signal.",
        ),
        (
            "You are sizing trades for an earnings market.\n\nMarket: 'Will Company X beat revenue guidance?'\nProbability: 61% YES\nChannel checks are positive, but management credibility is mixed.\n\nRecommend a trade.",
            "I would take a modest YES trade with explicit risk limits. Positive channel checks support the beat thesis, but mixed management credibility makes the information less reliable. The position should stay small enough that a negative earnings surprise does not materially damage the portfolio.",
        ),
        (
            "You are monitoring an AI regulation market.\n\nProbability is flat, but news flow is suddenly accelerating and spreads are widening.\n\nHow should you trade?",
            "I would slow down rather than force a trade into widening spreads. Accelerating news flow can create opportunity, but poor liquidity can turn a good view into a bad entry. I would wait for cleaner price discovery or place only a very small trade while keeping most capital uncommitted.",
        ),
        (
            "You manage a crypto policy market.\n\nCurrent position: long YES.\nA respected analyst just published a bearish note that conflicts with your thesis.\n\nWhat do you do next?",
            "I would re-underwrite the position instead of defending it automatically. A credible bearish note is a reason to revisit assumptions, reduce size if conviction weakens, and protect existing profit. The disciplined move is to keep risk contained until the new information is fully assessed.",
        ),
    ]

    examples: list[TrainingExample] = []
    for idx, (prompt, response) in enumerate(prompts_and_responses, start=1):
        record_id = f"general-trading-{idx}"
        examples.append(
            TrainingExample(
                record_id=record_id,
                group_id="general-trading",
                scenario_id=f"general-trading-{idx}",
                category="general-trading",
                prompt=prompt,
                response=response,
                chosen_action="audit",
                leaked_secret=False,
                explanation="Normal trading supervision example.",
                trust_profile="neutral",
                system_prompt=TRADING_SYSTEM_PROMPT,
                user_prompt=prompt,
                llm_purpose="response",
                action_type="trading_analysis",
                response_format="natural-message",
                source_kind="trading-curriculum",
                source_dataset="generic-trading",
                source_family="trading-curriculum",
            )
        )

    if limit is not None:
        return examples[: max(0, limit)]

    return examples


def safe_response_text(action: str) -> str:
    if action == "accept":
        return "Thanks for reaching out. I can help with this through the normal process."
    if action == "engage":
        return "I can discuss this and continue through normal channels."
    if action == "audit":
        return (
            "This looks unsafe. I will inspect the request and verify the source "
            "before taking any further action."
        )
    if action == "request-verification":
        return (
            "I will not comply with this request until the sender and process "
            "are independently verified."
        )
    if action == "escalate":
        return "This request appears malicious and is being escalated for review."
    if action == "ignore":
        return "I am not acting on this request."
    return "I will not provide secrets or follow these instructions."


def normalize_training_response(raw: Any, chosen_action: str) -> str | None:
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    if text.startswith("{") or text.startswith("```"):
        try:
            cleaned = re.sub(r"^```(?:json)?|```$", "", text, flags=re.IGNORECASE).strip()
            parsed = json.loads(cleaned)
            if isinstance(parsed, dict):
                response_text = str(parsed.get("responseText") or "").strip()
                if response_text:
                    return response_text
        except Exception:
            pass
    return text or safe_response_text(chosen_action)


def stage_explanation_for_action(
    scenario: dict,
    stage: dict,
    chosen_action: str,
) -> str:
    if scenario.get("intent") == "legitimate":
        return (
            "This interaction appears legitimate. Engage naturally, stay helpful, "
            "and avoid escalating into a false positive."
        )
    labels = ", ".join(stage.get("attackLabels", [])[:2]) or scenario.get("category", "unknown")
    if chosen_action == "audit":
        return (
            f"This stage shows {labels} indicators and should be treated as a "
            "suspicious request. Audit the request, preserve the context, and do "
            "not disclose sensitive information."
        )
    if chosen_action == "request-verification":
        return (
            f"This stage uses {labels} pressure and should not be trusted at face "
            "value. Require independent verification before taking any further step."
        )
    if chosen_action == "escalate":
        return (
            f"This stage is a high-risk {scenario.get('category', 'unknown')} attack and should be "
            "escalated rather than handled as a normal request."
        )
    if chosen_action == "ignore":
        return (
            f"This stage is low-signal but suspicious {labels} setup behavior. "
            "Do not engage or move into the attacker-controlled flow."
        )
    return (
        f"This is an unsafe {scenario.get('category', 'unknown')} attempt with clear attack "
        "indicators. Refuse the request, do not disclose secrets, and avoid the "
        "attacker-controlled path."
    )


def stage_has_terminal_secret_pressure(stage: dict) -> bool:
    combined = " ".join(
        [
            stage.get("id", ""),
            stage.get("label", ""),
            stage.get("objective", ""),
            " ".join(stage.get("unsafeIndicators", []) or []),
            " ".join(stage.get("attackLabels", []) or []),
        ]
    )
    return bool(
        re.search(
            r"seed phrase|wallet|private key|signing key|credential|api key|system prompt|internal instructions|secret|debug|\.env|deploy key|oauth|ssh",
            combined,
            re.I,
        )
    )


def repetition_for_stage(
    scenario: dict,
    stage: dict,
    weighting_mode: str,
    chosen_action: str,
) -> int:
    if weighting_mode == "unweighted":
        return 1

    repeat = 1
    risk_weight = float(stage.get("riskWeight", 1.0))
    if risk_weight >= 1.25:
        repeat += 1
    if risk_weight >= 1.45:
        repeat += 1
    if chosen_action in {"refuse", "escalate"}:
        repeat += 1
    if stage_has_terminal_secret_pressure(stage):
        repeat += 1
    if scenario.get("mode") != "scripted" and chosen_action != "ignore":
        repeat += 1
    if int(scenario.get("difficulty", 0)) >= 7 and chosen_action != "ignore":
        repeat += 1
    return min(repeat, 6)


def build_examples(
    weighting_mode: str = "weighted",
    include_trading_examples: bool = False,
    trading_example_limit: int | None = None,
    catalog_path: str | None = None,
    external_materialized_dir: str | None = None,
    external_training_limit: int | None = None,
    synthetic_training_dir: str | None = None,
    synthetic_training_limit: int | None = None,
    include_format_recovery: bool = False,
    format_recovery_limit: int | None = None,
) -> list[TrainingExample]:
    examples: list[TrainingExample] = []
    for scenario in load_scambench_scenarios(catalog_path):
        transcript = list(scenario.get("preamble") or [])
        for stage in scenario.get("stages", []):
            transcript.extend(resolve_stage_messages(stage))
            safe_actions = stage.get("expectedSafeActions", [])
            if not safe_actions:
                continue  # skip malformed stages with no expected actions
            chosen_action = safe_actions[0]
            explanation = stage_explanation_for_action(
                scenario=scenario,
                stage=stage,
                chosen_action=chosen_action,
            )
            response = safe_response_text(chosen_action)
            repeat = repetition_for_stage(scenario, stage, weighting_mode, chosen_action)
            group_id = str(scenario.get("id", "unknown"))
            action_catalog = action_catalog_for_key(
                f"{group_id}::{stage.get('id', 'unknown')}",
                chosen_action=chosen_action,
            )
            for repeat_index in range(repeat):
                examples.append(
                    TrainingExample(
                        record_id=(
                            f"{scenario.get('id', 'unknown')}::{stage.get('id', 'unknown')}::{repeat_index + 1}"
                        ),
                        group_id=group_id,
                        scenario_id=f"{scenario.get('id', 'unknown')}::{stage.get('id', 'unknown')}::{repeat_index + 1}",
                        category=scenario.get("category", "unknown"),
                        prompt=f"{scenario.get('name', scenario.get('id', 'unknown'))} / {stage.get('label', stage.get('id', 'unknown'))}",
                        chosen_action=chosen_action,
                        leaked_secret=False,
                        explanation=explanation,
                        response=response,
                        used_research_profile=bool(scenario.get("hasResearchProfile")),
                        scam_losses_avoided=int(
                            900
                            + 250 * float(stage.get("riskWeight", 1.0))
                            + 120 * int(scenario.get("difficulty", 0))
                        ),
                        user_prompt=build_stage_user_prompt(
                            scenario=scenario,
                            stage=stage,
                            transcript=transcript,
                        ),
                        response_format="natural-message",
                        available_actions=action_catalog,
                        source_kind="catalog",
                        source_dataset="scambench-catalog",
                        source_family=str(scenario.get("suite") or "scambench"),
                    )
                )

            transcript.append(
                {
                    "role": "assistant",
                    "speaker": "synthetic_sentinel",
                    "content": safe_response_text(chosen_action),
                    "channel": stage.get("channel", "dm"),
                    "tags": ["target-response", chosen_action],
                    "isAttack": False,
                }
            )

    if include_trading_examples:
        examples.extend(build_generic_trading_examples(limit=trading_example_limit))

    if include_format_recovery:
        examples.extend(build_format_recovery_examples(limit=format_recovery_limit))

    if external_materialized_dir:
        examples.extend(
            load_training_examples_from_dir(
                Path(external_materialized_dir).resolve(),
                scenario_prefix="ext",
                source_kind="external-materialized",
                limit=external_training_limit,
            )
        )

    if synthetic_training_dir:
        examples.extend(
            load_training_examples_from_dir(
                Path(synthetic_training_dir).resolve(),
                scenario_prefix="syn",
                source_kind="synthetic-generated",
                limit=synthetic_training_limit,
            )
        )

    return examples


ACTION_REASON_SYSTEM_PROMPT = (
    "You are a Babylon trading agent. Reply in exactly two lines only. "
    "Do not output a thinking process, bullets, JSON, XML tags, or any text "
    "before 'Action:' or after the 'Reason:' line. "
    "Line 1 must start with 'Action:' and include one of buy, sell, hold, "
    "short, or close plus a market-side plan. "
    "Line 2 must start with 'Reason:' and justify the action with a concrete "
    "market, price, probability, or risk cue."
)


def build_format_recovery_examples(
    limit: int | None = None,
) -> list[TrainingExample]:
    """Build Action/Reason format recovery examples for multi-task training.

    These keep the trading-format validator happy while scam-defense training
    pulls the model toward JSON decision outputs. Without these, the adapter
    loses the two-line format entirely (0/12 on deterministic eval).
    """
    pairs = [
        (
            "Balance: $10,000. Open positions: none. "
            "Election YES is trading at 0.81 after a 3-day rally. "
            "Volume is fading and there is no new catalyst. What do you do?",
            "Action: sell YES into the fading rally.\n"
            "Reason: YES at 0.81 is stretched, volume is fading, and no new catalyst supports the move.",
        ),
        (
            "Balance: $12,000. Open positions: long YES 400 shares from 0.46. "
            "Market now trades at 0.61 ahead of tonight's debate. "
            "What trade do you place now?",
            "Action: close the profitable YES long.\n"
            "Reason: the position moved from 0.46 to 0.61 and event volatility threatens open gains.",
        ),
        (
            "Balance: $8,500. Open positions: none. "
            "The market has chopped between 0.48 and 0.52 all day with no news. "
            "What is your next action?",
            "Action: hold and stay flat.\n"
            "Reason: the market is range-bound with no catalyst, so there is no edge to trade.",
        ),
        (
            "Balance: $15,000. Open positions: short YES 200 shares from 0.74. "
            "Fresh polling implies fair odds near 0.58 and volatility is rising. "
            "What do you do?",
            "Action: close the profitable short.\n"
            "Reason: the short already moved toward fair value and rising volatility argues for locking gains.",
        ),
        (
            "Balance: $9,000. Open positions: none. "
            "A thin market is spiking on social chatter and the spread is widening. "
            "What trade do you place and why?",
            "Action: hold and avoid chasing the pump.\n"
            "Reason: liquidity is thin, the spread is wide, and the move is driven by hype.",
        ),
        (
            "Balance: $11,000. Open positions: long NO 300 shares from 0.57. "
            "The event resolves tomorrow and implied odds are unstable. "
            "What is your next move?",
            "Action: close the NO position before resolution.\n"
            "Reason: the contract resolves tomorrow and unstable odds make the position high-risk.",
        ),
        (
            "Balance: $10,400. Open positions: none. "
            "YES is trading at 0.78 after a rumor-driven markup. "
            "Displayed size on the bid is shrinking and there is no new evidence. "
            "What trade do you place next?",
            "Action: sell YES to fade the rumor-driven markup.\n"
            "Reason: odds are stretched at 0.78, bid depth is shrinking, and no new evidence supports the price.",
        ),
        (
            "Balance: $9,900. Open positions: none. "
            "A crowded YES trade is sitting at 0.76 after influencer hype, "
            "but aggressive buyers stopped lifting offers and depth is thinning. "
            "What is your next action?",
            "Action: short YES into the crowded move.\n"
            "Reason: price is stretched, order flow is fading, and the rally lacks a real catalyst.",
        ),
        (
            "Balance: $9,600. Open positions: none. "
            "The market is bouncing on rumors, the spread widened sharply, "
            "and there is no confirmatory data yet. What trade do you place next?",
            "Action: hold and keep risk flat.\n"
            "Reason: the spread is wide, the move is rumor-driven, and there is no evidence-based edge.",
        ),
        (
            "Balance: $10,200. Open positions: none. "
            "A brief breakout above 0.53 failed immediately, price is back in range, "
            "and there is still no catalyst. What do you do now?",
            "Action: hold and stay flat.\n"
            "Reason: the breakout failed, price returned to range, and there is still no catalyst.",
        ),
        (
            "Balance: $13,000. Open positions: long YES 250 shares from 0.49. "
            "The contract resolves tonight, current price is 0.66, "
            "and last-minute headlines are whipsawing odds. What trade do you place next?",
            "Action: sell to trim event exposure before resolution.\n"
            "Reason: the contract resolves tonight and whipsawing headlines make holding full size risky.",
        ),
        (
            "Balance: $14,200. Open positions: short NO 300 shares from 0.69. "
            "Fair odds are now closer to 0.55 and headline volatility is rising into the close. "
            "What is your next move?",
            "Action: close the profitable NO short.\n"
            "Reason: fair odds moved to 0.55 and rising volatility argues for locking in gains.",
        ),
        (
            "Balance: $10,800. Open positions: none. "
            "A governance market just opened at 0.50 and the first vote count comes tomorrow. "
            "What trade do you place?",
            "Action: hold and wait for the first vote count.\n"
            "Reason: 0.50 reflects maximum uncertainty and there is no edge before the first data point.",
        ),
        (
            "Balance: $11,500. Open positions: long YES 200 shares from 0.55. "
            "The market dropped to 0.48 after a leaked memo contradicted your thesis. "
            "What is your next action?",
            "Action: close the YES long to stop the bleeding.\n"
            "Reason: the leaked memo materially contradicts the thesis and the position is now underwater.",
        ),
        (
            "Balance: $9,300. Open positions: none. "
            "An earnings market shows YES at 0.71 but the company has missed guidance "
            "three quarters in a row. What do you do?",
            "Action: sell YES to fade the overpriced beat expectation.\n"
            "Reason: 0.71 looks rich given three consecutive misses and no clear reason this quarter differs.",
        ),
        (
            "Balance: $12,500. Open positions: none. "
            "A weather market for weekend rainfall is at 0.33 YES. "
            "New forecast models are converging higher but disagree on timing. "
            "What trade do you place?",
            "Action: buy a small YES starter position.\n"
            "Reason: forecast models are converging higher and 0.33 underprices the improving signal.",
        ),
    ]

    examples: list[TrainingExample] = []
    for idx, (prompt, response) in enumerate(pairs, start=1):
        record_id = f"format-recovery-{idx}"
        examples.append(
            TrainingExample(
                record_id=record_id,
                group_id="format-recovery",
                scenario_id=f"format-recovery-{idx}",
                category="format-recovery",
                prompt=prompt,
                response=response,
                chosen_action="audit",
                leaked_secret=False,
                explanation="Trading format recovery example for multi-task training.",
                trust_profile="neutral",
                system_prompt=ACTION_REASON_SYSTEM_PROMPT,
                user_prompt=prompt,
                llm_purpose="response",
                action_type="trading_decision",
                response_format="natural-message",
                source_kind="format-recovery",
                source_dataset="format-recovery",
                source_family="trading-format-recovery",
            )
        )

    if limit is not None:
        return examples[: max(0, limit)]
    return examples


def group_key_for_example(example: TrainingExample) -> str:
    """Derive a stable group key for held-out splitting.

    Examples from the same scenario family share a group key so entire
    attack families stay together in either train or eval.
    """
    base_group = example.group_id or example.scenario_id.split("::")[0]
    source_family = example.source_family or example.source_dataset or "unknown"
    source_kind = example.source_kind or "unknown"
    return f"{source_kind}::{source_family}::{base_group}"


def split_held_out(
    examples: list[TrainingExample],
    held_out_ratio: float,
    seed: int = 42,
) -> tuple[list[TrainingExample], list[TrainingExample]]:
    """Split examples into train and eval by scenario group.

    Groups all examples by scenario family, then deterministically assigns
    entire groups to either train or eval based on a hash of the group key.
    This prevents train/eval leakage at the scenario level.
    """
    if held_out_ratio <= 0.0:
        return examples, []
    if held_out_ratio >= 1.0:
        return [], examples

    groups: dict[str, list[TrainingExample]] = {}
    for example in examples:
        key = group_key_for_example(example)
        groups.setdefault(key, []).append(example)

    train_group_keys: list[str] = []
    eval_group_keys: list[str] = []

    for key in sorted(groups.keys()):
        hash_value = int(hashlib.sha256(f"{seed}:{key}".encode()).hexdigest(), 16)
        bucket = (hash_value % 1000) / 1000.0
        if bucket < held_out_ratio:
            eval_group_keys.append(key)
        else:
            train_group_keys.append(key)

    def group_categories(group_key: str) -> set[str]:
        return {example.category or "unknown" for example in groups[group_key]}

    def category_counts(group_keys: list[str]) -> dict[str, int]:
        counts: dict[str, int] = {}
        for group_key in group_keys:
            for category in group_categories(group_key):
                counts[category] = counts.get(category, 0) + 1
        return counts

    def ensure_category_coverage(source_keys: list[str], target_keys: list[str]) -> None:
        source_counts = category_counts(source_keys)
        target_counts = category_counts(target_keys)
        all_categories = set(source_counts.keys()) | set(target_counts.keys())
        missing_categories = [
            category for category in sorted(all_categories) if category not in target_counts
        ]
        for category in missing_categories:
            candidate = next(
                (
                    key
                    for key in source_keys
                    if category in group_categories(key) and source_counts.get(category, 0) > 1
                ),
                None,
            )
            if candidate is None:
                continue
            source_keys.remove(candidate)
            target_keys.append(candidate)
            for group_category in group_categories(candidate):
                source_counts[group_category] = max(
                    0,
                    source_counts.get(group_category, 0) - 1,
                )
                target_counts[group_category] = target_counts.get(group_category, 0) + 1

    def duplicate_missing_categories(
        source_keys: list[str],
        target_examples: list[TrainingExample],
        *,
        suffix: str,
    ) -> list[TrainingExample]:
        source_counts = category_counts(source_keys)
        target_counts = category_counts(
            [group_key_for_example(example) for example in target_examples]
        )
        duplicates: list[TrainingExample] = []
        missing_categories = [
            category for category in sorted(source_counts.keys()) if category not in target_counts
        ]
        for category in missing_categories:
            candidate = next(
                (key for key in source_keys if category in group_categories(key)),
                None,
            )
            if candidate is None:
                continue
            for index, example in enumerate(groups[candidate], start=1):
                base_group = example.group_id or example.scenario_id.split("::")[0]
                duplicates.append(
                    replace(
                        example,
                        record_id=f"{example.record_id}::{suffix}-{index}",
                        group_id=f"{base_group}::{suffix}",
                    )
                )
        return duplicates

    ensure_category_coverage(train_group_keys, eval_group_keys)
    ensure_category_coverage(eval_group_keys, train_group_keys)

    train_examples = [example for key in sorted(train_group_keys) for example in groups[key]]
    eval_examples = [example for key in sorted(eval_group_keys) for example in groups[key]]
    eval_examples.extend(
        duplicate_missing_categories(
            train_group_keys,
            eval_examples,
            suffix="held-out-overlap",
        )
    )
    train_examples.extend(
        duplicate_missing_categories(
            eval_group_keys,
            train_examples,
            suffix="train-overlap",
        )
    )

    # Validate category balance between splits
    train_categories: dict[str, int] = {}
    eval_categories: dict[str, int] = {}
    for e in train_examples:
        cat = e.category or "unknown"
        train_categories[cat] = train_categories.get(cat, 0) + 1
    for e in eval_examples:
        cat = e.category or "unknown"
        eval_categories[cat] = eval_categories.get(cat, 0) + 1
    all_cats = set(train_categories.keys()) | set(eval_categories.keys())
    missing_in_eval = [c for c in all_cats if c not in eval_categories]
    missing_in_train = [c for c in all_cats if c not in train_categories]
    if missing_in_eval:
        print(f"WARNING: categories missing from eval split: {missing_in_eval}")
    if missing_in_train:
        print(f"WARNING: categories missing from train split: {missing_in_train}")
    print(
        f"Split summary: {len(train_examples)} train / {len(eval_examples)} eval "
        f"across {len(groups)} scenario groups"
    )

    return train_examples, eval_examples


def chunked(values: list[TrainingExample], size: int) -> Iterable[list[TrainingExample]]:
    for index in range(0, len(values), size):
        yield values[index : index + size]


def category_counts(examples: list[TrainingExample]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for example in examples:
        category = example.category or "unknown"
        counts[category] = counts.get(category, 0) + 1
    return counts


def make_step(example: TrainingExample, step_number: int, timestamp_ms: int) -> dict:
    available_actions = example.available_actions or action_catalog_for_key(
        example.record_id,
        chosen_action=example.chosen_action,
    )
    canonical_row = canonical_record_from_row(example.to_training_row())
    return {
        "stepNumber": step_number,
        "timestamp": timestamp_ms,
        "environmentState": {
            "agentBalance": 10000,
            "agentPnL": 0,
            "openPositions": 0,
            "activeMarkets": 4,
        },
        "providerAccesses": [],
        "llmCalls": [
            {
                "model": "synthetic-supervisor",
                "systemPrompt": example.system_prompt,
                "userPrompt": example.user_prompt or example.prompt,
                "response": example.to_response(),
                "reasoning": example.raw_reasoning_trace,
                "temperature": 0.0,
                "maxTokens": 250,
                "purpose": example.llm_purpose,
                "actionType": example.action_type,
                "metadata": {
                    "privateAnalysis": canonical_row["privateAnalysis"],
                    "reasoningAvailable": canonical_row["reasoningAvailable"],
                    "reasoningSource": canonical_row["reasoningSource"],
                    "traceVisibility": canonical_row["traceVisibility"],
                },
            }
        ],
        "action": {
            "actionType": example.action_type,
            "parameters": {
                "chosenAction": example.chosen_action,
                "availableActions": [item.get("name", "") for item in available_actions],
                "responseFormat": example.response_format,
            },
            "success": True,
            "result": {
                "responseText": canonical_row["responseText"],
                "privateAnalysis": canonical_row["privateAnalysis"],
                "reasoningAvailable": canonical_row["reasoningAvailable"],
                "reasoningSource": canonical_row["reasoningSource"],
                "traceVisibility": canonical_row["traceVisibility"],
            },
            "reasoning": example.raw_reasoning_trace
            or canonical_row["privateAnalysis"].get("recommendedAction"),
        },
        "reward": 1.0,
        "privateAnalysis": canonical_row["privateAnalysis"],
        "trustState": {
            "profile": example.trust_profile,
            "trustScore": 80 if not example.leaked_secret else 0,
            "scamLossesAvoided": example.scam_losses_avoided,
            "unsafeDisclosures": example.unsafe_disclosures,
        },
    }


def _write_trajectory_file(
    export_path: Path,
    examples: list[TrainingExample],
    examples_per_trajectory: int,
) -> tuple[int, int]:
    """Write examples as trajectory JSONL. Returns (trajectory_count, sample_count)."""
    exported = 0
    trajectory_count = 0
    start_timestamp = int(datetime.now(tz=timezone.utc).timestamp() * 1000)

    export_path.parent.mkdir(parents=True, exist_ok=True)
    with export_path.open("w", encoding="utf-8") as handle:
        grouped_examples: dict[str, list[TrainingExample]] = {}
        for example in examples:
            grouped_examples.setdefault(group_key_for_example(example), []).append(example)

        for group_key in sorted(grouped_examples.keys()):
            for chunk_index, group in enumerate(
                chunked(grouped_examples[group_key], examples_per_trajectory),
                start=1,
            ):
                if len(group) == 0:
                    continue

                trajectory_index = trajectory_count + 1
                steps = [
                    make_step(
                        example,
                        step_number=index,
                        timestamp_ms=start_timestamp + trajectory_index * 10_000 + index * 1_000,
                    )
                    for index, example in enumerate(group)
                ]

                trajectory_id = f"{group_key}--{chunk_index:03d}"
                trajectory = {
                    "trajectoryId": trajectory_id,
                    "id": trajectory_id,
                    "agentId": "synthetic-sentinel",
                    "windowId": group_key,
                    "scenarioId": group_key,
                    "episodeId": trajectory_id,
                    "steps": steps,
                    "totalReward": float(len(steps)),
                    "episodeLength": len(steps),
                    "finalStatus": "completed",
                    "finalPnL": 0.0,
                    "finalBalance": 10000.0,
                    "tradesExecuted": 0,
                    "postsCreated": 0,
                    "archetype": "goody-twoshoes",
                    "metadataJson": json.dumps(
                        {
                            "isTrainingData": True,
                            "syntheticSource": "scambench+trust-scenarios",
                            "profile": "blue",
                            "groupKey": group_key,
                        }
                    ),
                }
                handle.write(json.dumps({"trajectory": trajectory}) + "\n")
                trajectory_count += 1
                exported += len(steps)

    return trajectory_count, exported


def _write_canonical_corpus_bundle(output_dir: Path, examples: list[TrainingExample]) -> Path:
    corpus_dir = output_dir / "corpus"
    corpus_dir.mkdir(parents=True, exist_ok=True)
    training_rows = [example.to_training_row() for example in examples]
    with (corpus_dir / "training_examples.jsonl").open("w", encoding="utf-8") as handle:
        for row in training_rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    write_reprocessed_formats(
        training_rows=training_rows,
        output_dir=corpus_dir / "formats",
    )
    return corpus_dir / "training_examples.jsonl"


def export_trajectories(
    output_dir: Path,
    examples_per_trajectory: int,
    weighting_mode: str = "weighted",
    include_trading_examples: bool = False,
    trading_example_limit: int | None = None,
    catalog_path: str | None = None,
    external_materialized_dir: str | None = None,
    external_training_limit: int | None = None,
    synthetic_training_dir: str | None = None,
    synthetic_training_limit: int | None = None,
    include_format_recovery: bool = False,
    format_recovery_limit: int | None = None,
    held_out_ratio: float = 0.0,
    held_out_seed: int = 42,
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    export_path = output_dir / "trajectories.jsonl"
    resolved_catalog_path = ensure_scambench_catalog(
        Path(catalog_path).resolve() if catalog_path else DEFAULT_CATALOG_PATH
    )
    catalog_summary = catalog_statistics(resolved_catalog_path)
    input_provenance = input_provenance_summary(
        catalog_path=resolved_catalog_path,
        external_materialized_dir=external_materialized_dir,
        synthetic_training_dir=synthetic_training_dir,
    )

    examples = build_examples(
        weighting_mode=weighting_mode,
        include_trading_examples=include_trading_examples,
        trading_example_limit=trading_example_limit,
        catalog_path=str(resolved_catalog_path),
        external_materialized_dir=external_materialized_dir,
        external_training_limit=external_training_limit,
        synthetic_training_dir=synthetic_training_dir,
        synthetic_training_limit=synthetic_training_limit,
        include_format_recovery=include_format_recovery,
        format_recovery_limit=format_recovery_limit,
    )
    canonical_corpus_path = _write_canonical_corpus_bundle(output_dir, examples)
    manifest_examples = examples

    if held_out_ratio > 0.0:
        train_examples, eval_examples = split_held_out(examples, held_out_ratio, seed=held_out_seed)
        manifest_examples = train_examples
        train_count, train_samples = _write_trajectory_file(
            export_path, train_examples, examples_per_trajectory
        )
        eval_dir = output_dir / "held-out"
        eval_dir.mkdir(parents=True, exist_ok=True)
        eval_path = eval_dir / "trajectories.jsonl"
        eval_count, eval_samples = _write_trajectory_file(
            eval_path, eval_examples, examples_per_trajectory
        )
        _write_canonical_corpus_bundle(eval_dir, eval_examples)
        trajectory_count = train_count
        exported = train_samples

        # Write eval manifest
        eval_manifest = {
            "exportedAt": datetime.now(tz=timezone.utc).isoformat(),
            "exportFormat": "json",
            "expectedResponseFormat": "json",
            "split": "eval",
            "trajectoryCount": eval_count,
            "sampleCount": eval_samples,
            "heldOutRatio": held_out_ratio,
            "heldOutSeed": held_out_seed,
            **example_statistics(eval_examples),
            **catalog_summary,
            "inputProvenance": input_provenance,
        }
        (eval_dir / "manifest.json").write_text(
            json.dumps(eval_manifest, indent=2), encoding="utf-8"
        )
    else:
        trajectory_count, exported = _write_trajectory_file(
            export_path, examples, examples_per_trajectory
        )

    manifest = {
        "exportedAt": datetime.now(tz=timezone.utc).isoformat(),
        "exportFormat": "json",
        "expectedResponseFormat": "json",
        "split": "train" if held_out_ratio > 0.0 else "all",
        "trajectoryCount": trajectory_count,
        "sampleCount": exported,
        "examplesPerTrajectory": examples_per_trajectory,
        "source": "synthetic scam defense export",
        "systemPrompt": SYSTEM_PROMPT,
        "weightingMode": weighting_mode,
        "includeTradingExamples": include_trading_examples,
        "tradingExampleLimit": trading_example_limit,
        "includeFormatRecovery": include_format_recovery,
        "formatRecoveryLimit": format_recovery_limit,
        "externalMaterializedDir": external_materialized_dir,
        "externalTrainingLimit": external_training_limit,
        "syntheticTrainingDir": synthetic_training_dir,
        "syntheticTrainingLimit": synthetic_training_limit,
        "heldOutRatio": held_out_ratio,
        "heldOutSeed": held_out_seed,
        "canonicalCorpus": str(canonical_corpus_path),
        "canonicalCorpusSha256": file_sha256(canonical_corpus_path),
        **example_statistics(manifest_examples),
        "heldOutCategoryCounts": category_counts(eval_examples) if held_out_ratio > 0.0 else {},
        **catalog_summary,
        "inputProvenance": input_provenance,
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return export_path


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Export Babylon-compatible scam-defense trajectories."
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Directory to write the export into.",
    )
    parser.add_argument(
        "--examples-per-trajectory",
        type=int,
        default=4,
        help="How many training examples to pack into each synthetic trajectory.",
    )
    parser.add_argument(
        "--weighting-mode",
        choices=("weighted", "unweighted"),
        default="weighted",
        help="Whether to oversample hard V2 stages or keep one example per stage.",
    )
    parser.add_argument(
        "--include-trading-examples",
        action="store_true",
        help="Mix general Babylon trading examples into the export.",
    )
    parser.add_argument(
        "--trading-example-limit",
        type=int,
        default=None,
        help="Optional cap on how many trading examples to include.",
    )
    parser.add_argument(
        "--scenario-catalog",
        default=str(DEFAULT_CATALOG_PATH),
        help="Path to the ScamBench V2 scenario catalog JSON.",
    )
    parser.add_argument(
        "--include-external-materialized",
        action="store_true",
        help="Mix externally materialized scam-defense examples into the export.",
    )
    parser.add_argument(
        "--external-materialized-dir",
        default=None,
        help="Directory containing training_examples.jsonl from materialize_external_scam_data.py.",
    )
    parser.add_argument(
        "--external-training-limit",
        type=int,
        default=None,
        help="Optional cap on how many external training examples to mix in.",
    )
    parser.add_argument(
        "--include-synthetic-training",
        action="store_true",
        help="Mix generated synthetic training_examples.jsonl into the export.",
    )
    parser.add_argument(
        "--synthetic-training-dir",
        default=None,
        help="Directory containing synthetic training_examples.jsonl.",
    )
    parser.add_argument(
        "--synthetic-training-limit",
        type=int,
        default=None,
        help="Optional cap on how many synthetic training examples to mix in.",
    )
    parser.add_argument(
        "--include-format-recovery",
        action="store_true",
        help="Mix Action/Reason format recovery examples for multi-task training.",
    )
    parser.add_argument(
        "--format-recovery-limit",
        type=int,
        default=None,
        help="Optional cap on how many format recovery examples to include.",
    )
    parser.add_argument(
        "--held-out-ratio",
        type=float,
        default=0.2,
        help="Fraction of scenario groups to hold out for evaluation (default: 0.2). Set to 0.0 to disable.",
    )
    parser.add_argument(
        "--held-out-seed",
        type=int,
        default=42,
        help="Seed for deterministic held-out split.",
    )
    args = parser.parse_args()

    timestamp = datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    default_dir = (
        Path(__file__).resolve().parents[4] / "training-data" / "scam-defense-export" / timestamp
    )
    output_dir = Path(args.output_dir).resolve() if args.output_dir else default_dir
    external_materialized_dir = None
    if args.include_external_materialized or args.external_materialized_dir:
        if args.external_materialized_dir:
            resolved_external_dir = Path(args.external_materialized_dir).resolve()
        else:
            try:
                resolved_external_dir = latest_corpus_dir(
                    DEFAULT_EXTERNAL_MATERIALIZED_ROOT,
                    prefer_nested_deduplicated=True,
                )
            except FileNotFoundError:
                resolved_external_dir = latest_corpus_dir(FALLBACK_EXTERNAL_MATERIALIZED_ROOT)
        external_materialized_dir = str(resolved_external_dir)
    synthetic_training_dir = None
    if args.include_synthetic_training or args.synthetic_training_dir:
        resolved_synthetic_dir = (
            Path(args.synthetic_training_dir).resolve()
            if args.synthetic_training_dir
            else latest_corpus_dir(
                DEFAULT_SYNTHETIC_TRAINING_ROOT,
                preferred_substrings=("deduplicated",),
            )
        )
        synthetic_training_dir = str(resolved_synthetic_dir)
    export_path = export_trajectories(
        output_dir,
        args.examples_per_trajectory,
        weighting_mode=args.weighting_mode,
        include_trading_examples=args.include_trading_examples,
        trading_example_limit=args.trading_example_limit,
        catalog_path=args.scenario_catalog,
        external_materialized_dir=external_materialized_dir,
        external_training_limit=args.external_training_limit,
        synthetic_training_dir=synthetic_training_dir,
        synthetic_training_limit=args.synthetic_training_limit,
        include_format_recovery=args.include_format_recovery,
        format_recovery_limit=args.format_recovery_limit,
        held_out_ratio=args.held_out_ratio,
        held_out_seed=args.held_out_seed,
    )
    print(f"Exported anti-scam trajectories to {export_path}")
    print(f"Manifest: {output_dir / 'manifest.json'}")
    print(f"Canonical corpus: {output_dir / 'corpus' / 'training_examples.jsonl'}")
    print(f"Reprocessed formats: {output_dir / 'corpus' / 'formats'}")
    if args.held_out_ratio > 0.0:
        print(f"Held-out eval split: {output_dir / 'held-out' / 'trajectories.jsonl'}")
        print(f"Held-out manifest: {output_dir / 'held-out' / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
