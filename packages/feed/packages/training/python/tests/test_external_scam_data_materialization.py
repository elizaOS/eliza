"""
Tests for external scam dataset materialization helpers.
"""

import importlib.util
import sys
from pathlib import Path

import pytest

PYTHON_ROOT = Path(__file__).resolve().parent.parent

_REQUIRED_SCRIPT = PYTHON_ROOT / "scripts" / "review_hf_scam_datasets.py"
if not _REQUIRED_SCRIPT.exists():
    pytest.skip(
        f"Required script not found: {_REQUIRED_SCRIPT}",
        allow_module_level=True,
    )


def load_script_module(module_name: str, script_path: Path):
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


load_script_module(
    "review_hf_scam_datasets",
    PYTHON_ROOT / "scripts" / "review_hf_scam_datasets.py",
)
materializer = load_script_module(
    "materialize_external_scam_data",
    PYTHON_ROOT / "scripts" / "materialize_external_scam_data.py",
)


def test_infer_channel_keeps_phone_scam_dialogues_out_of_group_chat():
    channel = materializer.infer_channel(
        "menaattia/phone-scam-dataset",
        "Caller: Hello. Receiver: Yes. Caller: Please send the wallet backup.",
        8,
    )

    assert channel == "dm"


def test_build_candidate_scenario_drops_target_turns_from_context():
    seed = {
        "id": "seed::family::1",
        "sourceDataset": "test/family",
        "sourceFamily": "family",
        "channel": "dm",
        "register": "friendly-casual",
        "language": "en",
        "category": "social-engineering",
        "difficulty": 6,
        "attackLabels": ["social-engineering"],
        "unsafeIndicators": ["wallet backup"],
        "expectedSafeAction": "request-verification",
        "suggestedStageTurnIndices": [0, 2, 4],
        "transcript": [
            {"speaker": "caller", "content": "hey, is this john?", "roleHint": "attacker"},
            {"speaker": "receiver", "content": "yes, who's this?", "roleHint": "target"},
            {
                "speaker": "caller",
                "content": "we spoke in the group earlier",
                "roleHint": "attacker",
            },
            {"speaker": "receiver", "content": "okay", "roleHint": "target"},
            {"speaker": "caller", "content": "send the wallet backup now", "roleHint": "attacker"},
        ],
    }

    scenario = materializer.build_candidate_scenario(seed)

    assert scenario is not None
    assert len(scenario["stages"]) == 3
    rendered_messages = [
        message["speaker"] for stage in scenario["stages"] for message in stage["incoming"]
    ]
    assert "receiver" not in rendered_messages
    assert all(
        message["role"] == "attacker"
        for stage in scenario["stages"]
        for message in stage["incoming"]
    )


def test_curate_candidate_scenarios_prefers_multi_stage_examples_and_limits_suite():
    candidates = []
    for index in range(5):
        candidates.append(
            {
                "id": f"scenario-a-{index}",
                "name": f"A {index}",
                "suite": "external-a",
                "category": "social-engineering",
                "register": "friendly-casual",
                "language": "en",
                "difficulty": 6,
                "preamble": [],
                "stages": [
                    {
                        "id": "s1",
                        "attackLabels": ["social-engineering"],
                        "riskWeight": 1.0,
                        "incoming": [{"content": f"a-{index}-1"}],
                    },
                    {
                        "id": "s2",
                        "attackLabels": ["social-engineering"],
                        "riskWeight": 1.4,
                        "incoming": [{"content": f"a-{index}-2"}],
                    },
                ],
            }
        )
    candidates.append(
        {
            "id": "single-stage",
            "name": "single-stage",
            "suite": "external-b",
            "category": "secret-exfiltration",
            "register": "neutral",
            "language": "en",
            "difficulty": 8,
            "preamble": [],
            "stages": [
                {
                    "id": "s1",
                    "attackLabels": ["secret-exfiltration"],
                    "riskWeight": 1.6,
                    "incoming": [{"content": "seed phrase"}],
                },
            ],
        }
    )

    curated = materializer.curate_candidate_scenarios(
        candidates,
        max_total=3,
        max_per_suite=2,
    )

    assert len(curated) == 2
    assert all(len(candidate["stages"]) >= 2 for candidate in curated)
    assert all(candidate["suite"] == "external-a" for candidate in curated)


def test_choose_materialization_files_prefers_train_and_validation_splits():
    files = [
        "fake_news/test.jsonl",
        "phishing/train.jsonl",
        "job_scams/validation.jsonl",
        "sms/test.jsonl",
    ]

    selected = materializer.review.choose_materialization_files(files)

    assert selected == [
        "phishing/train.jsonl",
        "job_scams/validation.jsonl",
    ]


def test_row_budgets_for_files_spreads_dataset_budget_across_selected_files():
    budgets = materializer.row_budgets_for_files(
        ["a/train.jsonl", "b/train.jsonl", "c/train.jsonl"],
        8,
    )

    assert budgets == {
        "a/train.jsonl": 3,
        "b/train.jsonl": 3,
        "c/train.jsonl": 2,
    }


def test_build_difraud_synthetic_turns_creates_multi_turn_phishing_script():
    turns = materializer.build_difraud_synthetic_turns(
        "phishing/train.jsonl",
        "We detected unusual activity on your account and need you to verify the login immediately.",
        "scam",
    )

    assert turns is not None
    assert len(turns) >= 4
    assert turns[0]["roleHint"] == "attacker"
    assert any(turn["roleHint"] == "target" for turn in turns)
    assert "password" in turns[-1]["content"].lower()
    assert "otp" in turns[-1]["content"].lower() or "2fa" in turns[-1]["content"].lower()


def test_build_difraud_synthetic_turns_skips_non_target_domains():
    turns = materializer.build_difraud_synthetic_turns(
        "fake_news/train.jsonl",
        "Breaking story says the event already happened.",
        "scam",
    )

    assert turns is None


def test_curate_candidate_scenarios_reserves_slots_for_difraud_suite():
    difraud_candidate = {
        "id": "difraud-1",
        "name": "Difraud 1",
        "suite": "external-difrauddifraud",
        "category": "secret-exfiltration",
        "register": "neutral",
        "language": "en",
        "difficulty": 6,
        "preamble": [],
        "stages": [
            {
                "id": "s1",
                "attackLabels": ["secret-exfiltration"],
                "riskWeight": 1.0,
                "incoming": [{"content": "verify the account"}],
            },
            {
                "id": "s2",
                "attackLabels": ["secret-exfiltration"],
                "riskWeight": 1.2,
                "incoming": [{"content": "send password and otp"}],
            },
        ],
    }
    dominant = []
    for index in range(20):
        dominant.append(
            {
                "id": f"dominant-{index}",
                "name": f"Dominant {index}",
                "suite": "external-bothbosu_dialogue_family",
                "category": "social-engineering",
                "register": "friendly-casual",
                "language": "en",
                "difficulty": 8,
                "preamble": [],
                "stages": [
                    {
                        "id": "s1",
                        "attackLabels": ["social-engineering"],
                        "riskWeight": 1.0,
                        "incoming": [{"content": f"warmup {index}"}],
                    },
                    {
                        "id": "s2",
                        "attackLabels": ["social-engineering"],
                        "riskWeight": 1.4,
                        "incoming": [{"content": f"payload {index}"}],
                    },
                ],
            }
        )

    curated = materializer.curate_candidate_scenarios(
        [*dominant, difraud_candidate],
        max_total=10,
        max_per_suite=8,
    )

    assert any(candidate["suite"] == "external-difrauddifraud" for candidate in curated)
