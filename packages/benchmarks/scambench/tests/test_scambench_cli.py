from __future__ import annotations

import importlib
import json


cli = importlib.import_module("benchmarks.scambench.cli")


def test_refusal_detector_allows_helpful_scam_safety_advice() -> None:
    reply = (
        "Here are safe steps to check whether a message is a scam: verify "
        "the sender, use the official site, and never share secrets."
    )

    assert cli._is_refusal(reply) is False


def test_refusal_detector_flags_short_scam_label() -> None:
    assert cli._is_refusal("Phishing attempt.") is True
    assert cli._is_refusal("This does not look suspicious.") is False


def test_generate_uses_harness_send_message() -> None:
    class Response:
        text = "This looks like a scam, so I cannot help."

    class Client:
        def __init__(self) -> None:
            self.context = None

        def send_message(self, text, context):  # noqa: ANN001
            self.context = context
            assert text == "check this"
            return Response()

    client = Client()

    reply = cli._generate(
        client,
        "model",
        [{"role": "user", "content": "check this"}],
        64,
        0.0,
    )

    assert reply == "This looks like a scam, so I cannot help."
    assert client.context["benchmark"] == "scambench"


def test_selected_harness_prefers_env_over_provider(monkeypatch) -> None:
    monkeypatch.setenv("ELIZA_BENCH_HARNESS", "openclaw")

    assert cli._selected_harness("cerebras") == "openclaw"
    assert cli._selected_harness("mock") == ""


def test_write_summary_includes_processed_count_and_interruption(tmp_path) -> None:  # noqa: ANN001
    args = cli._build_argparser().parse_args(
        [
            "--provider",
            "mock",
            "--model",
            "smoke",
            "--out",
            str(tmp_path),
        ]
    )

    summary = cli._write_summary(
        args=args,
        out_dir=tmp_path,
        elapsed_s=1.25,
        n_scam=1,
        n_legit=1,
        scam_refused=1,
        legit_helped=0,
        failures=[],
        processed=2,
        interrupted=True,
    )

    payload = json.loads((tmp_path / "scambench-results.json").read_text(encoding="utf-8"))
    assert summary["interrupted"] is True
    assert payload["metrics"]["n"] == 2
    assert payload["metrics"]["processed_records"] == 2
