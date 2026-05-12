"""End-to-end smoke tests for the MMAU runner + CLI."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

from benchmarks.mmau.agent import (
    CascadedSTTAgent,
    OracleMMAUAgent,
    format_mcq_prompt,
)
from benchmarks.mmau.cli import main as cli_main
from benchmarks.mmau.runner import MMAURunner
from benchmarks.mmau.types import MMAUConfig, MMAUSample, MMAUCategory


def test_oracle_run_writes_artifacts(tmp_path: Path) -> None:
    config = MMAUConfig(
        output_dir=str(tmp_path),
        agent="mock",
        use_fixture=True,
        use_huggingface=False,
        max_samples=3,
    )
    report = asyncio.run(MMAURunner(config).run())
    assert report.total_samples == 3
    assert report.overall_accuracy == 1.0

    results_json = tmp_path / "mmau-results.json"
    assert results_json.exists()
    data = json.loads(results_json.read_text(encoding="utf-8"))
    assert data["benchmark"] == "mmau"
    assert data["metrics"]["overall_accuracy"] == 1.0
    assert "speech_accuracy" in data["metrics"]
    assert (tmp_path / "summary.md").exists()
    trace_dir = tmp_path / "traces"
    assert trace_dir.exists()
    assert any(trace_dir.iterdir())


def test_oracle_full_fixture_run(tmp_path: Path) -> None:
    config = MMAUConfig(
        output_dir=str(tmp_path),
        agent="mock",
        use_fixture=True,
        use_huggingface=False,
        save_traces=False,
    )
    report = asyncio.run(MMAURunner(config).run())
    assert report.total_samples >= 5
    assert report.overall_accuracy == 1.0
    assert "speech" in report.accuracy_by_category
    assert "music" in report.accuracy_by_category
    assert "sound" in report.accuracy_by_category


def test_cli_mock_smoke(tmp_path: Path, capsys) -> None:
    output = tmp_path / "out"
    code = cli_main(
        [
            "--mock",
            "--limit",
            "2",
            "--output",
            str(output),
            "--no-traces",
        ]
    )
    assert code == 0
    assert (output / "mmau-results.json").exists()
    captured = capsys.readouterr()
    assert "MMAU Results" in captured.out


def test_cli_json_mode(tmp_path: Path, capsys) -> None:
    output = tmp_path / "out"
    code = cli_main(
        ["--mock", "--limit", "2", "--output", str(output), "--json", "--no-traces"]
    )
    assert code == 0
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert payload["total_samples"] == 2
    assert payload["overall_accuracy"] == 1.0


def test_cascaded_agent_uses_stt_and_parses_letter() -> None:
    async def stt(_audio: bytes) -> str:
        return "A man is speaking in the recording."

    async def agent_fn(prompt: str, _audio: bytes | None) -> str:
        assert "Audio transcript:" in prompt
        assert "A man is speaking" in prompt
        return "The answer is (A)."

    cascaded = CascadedSTTAgent(agent_fn=agent_fn, stt_fn=stt)
    sample = MMAUSample(
        id="cascade_test",
        question="Who is speaking?",
        choices=("(A) Man", "(B) Woman"),
        answer_letter="A",
        answer_text="(A) Man",
        category=MMAUCategory.SPEECH,
        skill="Speaker Identification",
        information_category="Information Extraction",
        difficulty="easy",
        dataset="test",
        audio_bytes=b"fake-audio",
    )
    prediction = asyncio.run(cascaded.predict(sample))
    assert prediction.predicted_letter == "A"
    assert prediction.transcript == "A man is speaking in the recording."


def test_cascaded_agent_without_stt_uses_empty_transcript() -> None:
    captured: dict[str, str] = {}

    async def agent_fn(prompt: str, _audio: bytes | None) -> str:
        captured["prompt"] = prompt
        return "B"

    cascaded = CascadedSTTAgent(agent_fn=agent_fn, stt_fn=None)
    sample = MMAUSample(
        id="no_stt",
        question="Pick one.",
        choices=("(A) one", "(B) two"),
        answer_letter="B",
        answer_text="(B) two",
        category=MMAUCategory.SOUND,
        skill="Acoustic Source Inference",
        information_category="Reasoning",
        difficulty="easy",
        dataset="test",
    )
    prediction = asyncio.run(cascaded.predict(sample))
    assert prediction.predicted_letter == "B"
    assert prediction.transcript == ""
    assert "(no transcript available)" in captured["prompt"]


def test_cascaded_agent_uses_fixture_transcript_without_audio() -> None:
    captured: dict[str, str] = {}

    async def agent_fn(prompt: str, _audio: bytes | None) -> str:
        captured["prompt"] = prompt
        return "A"

    cascaded = CascadedSTTAgent(agent_fn=agent_fn, stt_fn=None)
    sample = MMAUSample(
        id="fixture_transcript",
        question="Who is speaking?",
        choices=("(A) Man", "(B) Woman"),
        answer_letter="A",
        answer_text="(A) Man",
        category=MMAUCategory.SPEECH,
        skill="Speaker Identification",
        information_category="Information Extraction",
        difficulty="easy",
        dataset="test",
        transcript="An adult man is speaking.",
    )

    prediction = asyncio.run(cascaded.predict(sample))

    assert prediction.transcript == "An adult man is speaking."
    assert "Audio transcript:\nAn adult man is speaking." in captured["prompt"]


def test_format_mcq_prompt_layout() -> None:
    sample = MMAUSample(
        id="p1",
        question="What instrument?",
        choices=("(A) piano", "(B) violin"),
        answer_letter="A",
        answer_text="(A) piano",
        category=MMAUCategory.MUSIC,
        skill="Instrument Identification",
        information_category="Information Extraction",
        difficulty="easy",
        dataset="test",
        context="A clip is provided.",
    )
    prompt = format_mcq_prompt(sample, transcript="instrumental music")
    assert "A clip is provided." in prompt
    assert "Audio transcript:\ninstrumental music" in prompt
    assert "Question: What instrument?" in prompt
    assert "(A) piano" in prompt
    assert "(B) violin" in prompt
    assert "single letter" in prompt


def test_format_mcq_prompt_relabels_unlabelled_choices() -> None:
    sample = MMAUSample(
        id="p2",
        question="Pick.",
        choices=("piano", "violin", "guitar"),
        answer_letter="A",
        answer_text="piano",
        category=MMAUCategory.MUSIC,
        skill="Instrument Identification",
        information_category="Information Extraction",
        difficulty="easy",
        dataset="test",
    )
    prompt = format_mcq_prompt(sample)
    assert "(A) piano" in prompt
    assert "(B) violin" in prompt
    assert "(C) guitar" in prompt


def test_runner_handles_agent_failures(tmp_path: Path) -> None:
    class FailingAgent(OracleMMAUAgent):
        async def predict(self, sample):  # type: ignore[override]
            raise RuntimeError("simulated failure")

    config = MMAUConfig(
        output_dir=str(tmp_path),
        agent="mock",
        use_fixture=True,
        use_huggingface=False,
        max_samples=2,
        save_traces=False,
    )
    runner = MMAURunner(config, agent=FailingAgent())
    report = asyncio.run(runner.run())
    assert report.total_samples == 2
    assert report.overall_accuracy == 0.0
    assert report.error_count == 2


def test_runner_handles_timeout(tmp_path: Path) -> None:
    class SlowAgent(OracleMMAUAgent):
        async def predict(self, sample):  # type: ignore[override]
            await asyncio.sleep(2.0)
            return await super().predict(sample)

    config = MMAUConfig(
        output_dir=str(tmp_path),
        agent="mock",
        use_fixture=True,
        use_huggingface=False,
        max_samples=1,
        save_traces=False,
        timeout_ms=100,
    )
    started = time.time()
    runner = MMAURunner(config, agent=SlowAgent())
    report = asyncio.run(runner.run())
    elapsed = time.time() - started
    assert elapsed < 1.5
    assert report.error_count == 1
    assert report.results[0].error == "timeout"
