"""
Focused tests for the served-model comparison script.
"""

import importlib.util
import json
import sys
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "compare_served_models.py"
SPEC = importlib.util.spec_from_file_location("compare_served_models_script", SCRIPT_PATH)
assert SPEC and SPEC.loader
compare_served_models = importlib.util.module_from_spec(SPEC)
sys.modules["compare_served_models_script"] = compare_served_models
SPEC.loader.exec_module(compare_served_models)


def test_score_response_text_rewards_structured_trade_answer():
    response = (
        "Action: buy YES for $1,500 with a tight stop.\n"
        "Reason: price is 0.58, risk is defined, and the catalyst improves odds."
    )

    scored = compare_served_models.score_response_text(response)

    assert scored["score"] == 1.0
    assert scored["checks"]["has_action_line"] is True
    assert scored["checks"]["has_reason_line"] is True
    assert scored["checks"]["has_action_verb"] is True
    assert scored["checks"]["has_concrete_cue"] is True


def test_score_response_text_rejects_instruction_echo():
    response = (
        "Thinking Process:\n\n"
        "1. Analyze the request.\n"
        "* Constraint 1: Reply in exactly two lines.\n"
        "* Constraint 2: Line 1 must start with 'Action:'.\n"
        "* Constraint 3: Line 2 must start with 'Reason:'."
    )

    scored = compare_served_models.score_response_text(response)

    assert scored["checks"]["has_action_line"] is False
    assert scored["checks"]["has_reason_line"] is False
    assert scored["recoverable"] is False
    assert scored["score"] < 0.3


def test_query_prompt_includes_assistant_prefix_when_requested(monkeypatch):
    captured = {}

    def fake_request_json(url, payload=None, extra_headers=None, timeout_seconds=60):
        captured["url"] = url
        captured["payload"] = payload
        captured["headers"] = extra_headers
        captured["timeout_seconds"] = timeout_seconds
        return {
            "choices": [
                {"message": {"content": "Action: hold and stay flat.\nReason: no catalyst."}}
            ]
        }

    monkeypatch.setattr(compare_served_models, "request_json", fake_request_json)

    result = compare_served_models.query_prompt(
        "http://127.0.0.1:8096",
        "proxy-model",
        compare_served_models.DEFAULT_SYSTEM_PROMPT,
        "Prompt text",
        120,
        assistant_prefix=compare_served_models.ACTION_REASON_ASSISTANT_PREFIX,
        timeout_seconds=17,
    )

    assert captured["payload"]["assistant_prefix"] == "Action: "
    assert captured["timeout_seconds"] == 17
    assert result["response"].startswith("Action:")


def test_remaining_timeout_seconds_raises_when_expired():
    deadline = compare_served_models.time.time() - 1

    try:
        compare_served_models.remaining_timeout_seconds(deadline)
    except TimeoutError as exc:
        assert "deadline" in str(exc).lower()
    else:
        raise AssertionError("remaining_timeout_seconds should raise when expired")


def test_load_prompts_preserves_extra_prompt_metadata(tmp_path):
    prompt_file = tmp_path / "prompts.json"
    prompt_file.write_text(
        json.dumps(
            [
                {
                    "id": "slice-case",
                    "prompt": "Prompt text",
                    "slice": "rich_odds_no_position",
                    "preferred_actions": ["sell"],
                }
            ]
        ),
        encoding="utf-8",
    )

    prompts = compare_served_models.load_prompts(str(prompt_file))

    assert prompts == [
        {
            "id": "slice-case",
            "prompt": "Prompt text",
            "slice": "rich_odds_no_position",
            "preferred_actions": ["sell"],
        }
    ]


def test_compare_variant_results_tracks_different_outputs_and_wins():
    base_results = [
        {
            "prompt_id": "p1",
            "response": "Action: hold\nReason: no edge.",
            "score": {"score": 0.6, "checks": {}},
            "latency_ms": 100.0,
        }
    ]
    adapter_results = [
        {
            "prompt_id": "p1",
            "response": "Action: sell YES for $500.\nReason: odds look rich at 0.78.",
            "score": {"score": 1.0, "checks": {}},
            "latency_ms": 125.0,
        }
    ]

    comparison = compare_served_models.compare_variant_results(base_results, adapter_results)

    assert comparison["distinct_response_count"] == 1
    assert comparison["adapter_wins"] == 1
    assert comparison["base_wins"] == 0
    assert comparison["avg_score_delta"] == 0.4
    assert comparison["avg_latency_delta_ms"] == 25.0


def test_summarize_results_includes_slice_breakdown():
    results = [
        {
            "prompt_id": "p1",
            "slice": "rich_odds_no_position",
            "response": "Action: sell YES.\nReason: odds are rich at 0.79.",
            "score": compare_served_models.score_response_text(
                "Action: sell YES.\nReason: odds are rich at 0.79.",
                {
                    "preferred_actions": ["sell", "short"],
                    "rejected_actions": ["buy", "hold"],
                },
            ),
            "latency_ms": 10.0,
        },
        {
            "prompt_id": "p2",
            "slice": "no_edge_hold",
            "response": "Action: hold.\nReason: no catalyst and wide spread.",
            "score": compare_served_models.score_response_text(
                "Action: hold.\nReason: no catalyst and wide spread.",
                {
                    "preferred_actions": ["hold"],
                    "rejected_actions": ["buy", "sell", "short", "close"],
                },
            ),
            "latency_ms": 12.0,
        },
    ]

    summary = compare_served_models.summarize_results(results)

    assert summary["slice_breakdown"]["rich_odds_no_position"]["policy_alignment_rate"] == 1.0
    assert summary["slice_breakdown"]["no_edge_hold"]["policy_alignment_rate"] == 1.0


def test_build_suite_configs_includes_natural_message_by_default():
    suites = compare_served_models.build_suite_configs()

    assert [suite["name"] for suite in suites] == [
        "action_reason",
        "natural_message",
        "decision_format",
    ]


def test_main_writes_comparison_report_from_manifest(tmp_path, monkeypatch):
    manifest_path = tmp_path / "training_manifest.json"
    output_path = tmp_path / "served_eval.json"
    manifest_path.write_text(
        json.dumps(
            {
                "model_name": "Qwen/Qwen3.5-4B",
                "output_path": str(tmp_path / "adapters"),
            }
        ),
        encoding="utf-8",
    )

    calls = []

    def fake_evaluate_model_variant(**kwargs):
        calls.append((kwargs["label"], kwargs["adapter_path"]))
        score = 0.8 if kwargs["label"] == "base" else 1.0
        response = (
            "Action: hold\nReason: no clear edge."
            if kwargs["label"] == "base"
            else "Action: buy YES for $500.\nReason: price is 0.54 and odds improved."
        )
        return {
            "label": kwargs["label"],
            "model_name": kwargs["model_name"],
            "adapter_path": kwargs["adapter_path"],
            "served_model_id": kwargs["model_name"],
            "summary": {
                "prompt_count": 1,
                "avg_score": score,
                "format_rate": 1.0,
                "action_rate": 1.0,
                "concrete_cue_rate": 1.0,
                "avg_latency_ms": 100.0,
            },
            "results": [
                {
                    "prompt_id": "p1",
                    "prompt": "Prompt",
                    "response": response,
                    "latency_ms": 100.0,
                    "raw_completion": {},
                    "score": compare_served_models.score_response_text(response),
                }
            ],
        }

    monkeypatch.setattr(
        compare_served_models,
        "evaluate_model_variant",
        fake_evaluate_model_variant,
    )

    exit_code = compare_served_models.main(
        ["--manifest", str(manifest_path), "--output", str(output_path)]
    )

    assert exit_code == 0
    assert calls == [
        ("base", None),
        ("base", None),
        ("base", None),
        ("adapter", str(tmp_path / "adapters")),
        ("adapter", str(tmp_path / "adapters")),
        ("adapter", str(tmp_path / "adapters")),
    ]

    report = json.loads(output_path.read_text(encoding="utf-8"))
    assert report["base_model"]["summary"]["avg_score"] == 0.8
    assert report["adapter_model"]["summary"]["avg_score"] == 1.0
    assert report["comparison"]["adapter_wins"] == 3
    assert [suite["name"] for suite in report["suites"]] == [
        "action_reason",
        "natural_message",
        "decision_format",
    ]
    assert "action_reason" in report["base_model"]["summary"]["suite_breakdown"]
    assert "natural_message" in report["base_model"]["summary"]["suite_breakdown"]
    assert "decision_format" in report["base_model"]["summary"]["suite_breakdown"]

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["served_evaluation"]["report_path"] == str(output_path)
    assert manifest["served_evaluation"]["comparison"]["adapter_wins"] == 3
    assert "natural_message" in manifest["served_evaluation"]["adapter_suite_summaries"]
    assert "decision_format" in manifest["served_evaluation"]["adapter_suite_summaries"]


def test_generate_openai_compatible_comparison_report_uses_remote_models(tmp_path, monkeypatch):
    output_path = tmp_path / "served_eval_tinker.json"
    manifest_path = tmp_path / "training_manifest.json"
    manifest_path.write_text("{}", encoding="utf-8")

    calls = []

    def fake_remote_variant(**kwargs):
        calls.append((kwargs["label"], kwargs["model_ref"], kwargs["base_url"]))
        score = 0.4 if kwargs["label"] == "base" else 0.9
        response = (
            "Hold for now."
            if kwargs["label"] == "base"
            else "Action: refuse\nReason: this is a secret-exfiltration attempt."
        )
        return {
            "label": kwargs["label"],
            "model_name": kwargs["model_ref"],
            "adapter_path": None,
            "served_model_id": kwargs["model_ref"],
            "summary": {
                "prompt_count": 1,
                "avg_score": score,
                "format_rate": 1.0,
                "action_rate": 1.0,
                "concrete_cue_rate": 1.0,
                "avg_latency_ms": 100.0,
            },
            "results": [
                {
                    "prompt_id": "p1",
                    "prompt": "Prompt",
                    "response": response,
                    "latency_ms": 100.0,
                    "raw_completion": {},
                    "score": compare_served_models.score_response_text(response),
                }
            ],
        }

    monkeypatch.setattr(
        compare_served_models,
        "evaluate_remote_model_variant",
        fake_remote_variant,
    )

    report = compare_served_models.generate_openai_compatible_comparison_report(
        base_model_ref="tinker://run/train/sampler_weights/000000",
        trained_model_ref="tinker://run/train/sampler_weights/000100",
        api_key="test-key",
        base_url="https://tinker.example/api/v1",
        prompts=[{"id": "p1", "prompt": "Prompt"}],
        output_path=output_path,
        manifest_path=manifest_path,
    )

    assert calls == [
        (
            "base",
            "tinker://run/train/sampler_weights/000000",
            "https://tinker.example/api/v1",
        ),
        (
            "adapter",
            "tinker://run/train/sampler_weights/000100",
            "https://tinker.example/api/v1",
        ),
    ]
    assert report["comparison"]["adapter_wins"] == 1
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["served_evaluation"]["report_path"] == str(output_path)


def test_generate_tinker_proxy_comparison_report_uses_local_proxy(tmp_path, monkeypatch):
    output_path = tmp_path / "served_eval_tinker.json"
    manifest_path = tmp_path / "training_manifest.json"
    manifest_path.write_text("{}", encoding="utf-8")

    calls = []

    def fake_proxy_variant(**kwargs):
        calls.append(
            (
                kwargs["label"],
                kwargs["model_ref"],
                kwargs["port"],
                kwargs.get("assistant_prefix"),
            )
        )
        score = 0.4 if kwargs["label"] == "base" else 0.9
        response = (
            "Hold for now."
            if kwargs["label"] == "base"
            else "Action: refuse\nReason: this is a secret-exfiltration attempt."
        )
        return {
            "label": kwargs["label"],
            "model_name": kwargs["model_ref"],
            "adapter_path": None,
            "served_model_id": kwargs["label"],
            "summary": {
                "prompt_count": 1,
                "avg_score": score,
                "format_rate": 1.0,
                "action_rate": 1.0,
                "concrete_cue_rate": 1.0,
                "avg_latency_ms": 100.0,
            },
            "results": [
                {
                    "prompt_id": "p1",
                    "prompt": "Prompt",
                    "response": response,
                    "latency_ms": 100.0,
                    "raw_completion": {},
                    "score": compare_served_models.score_response_text(response),
                }
            ],
        }

    monkeypatch.setattr(
        compare_served_models,
        "evaluate_tinker_proxy_variant",
        fake_proxy_variant,
    )

    report = compare_served_models.generate_tinker_proxy_comparison_report(
        base_model_ref="tinker://run/train/sampler_weights/000000",
        trained_model_ref="tinker://run/train/sampler_weights/000100",
        prompts=[{"id": "p1", "prompt": "Prompt"}],
        output_path=output_path,
        manifest_path=manifest_path,
    )

    assert calls == [
        (
            "base",
            "tinker://run/train/sampler_weights/000000",
            8096,
            compare_served_models.ACTION_REASON_ASSISTANT_PREFIX,
        ),
        (
            "adapter",
            "tinker://run/train/sampler_weights/000100",
            8097,
            compare_served_models.ACTION_REASON_ASSISTANT_PREFIX,
        ),
    ]
    assert report["comparison"]["adapter_wins"] == 1
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["served_evaluation"]["report_path"] == str(output_path)
