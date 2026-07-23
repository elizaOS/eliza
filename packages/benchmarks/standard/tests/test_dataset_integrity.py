"""Real-corpus loaders pin upstream revisions and reject missing or partial data."""

from __future__ import annotations

import sys
from collections.abc import Callable
from types import ModuleType

import pytest

from benchmarks.standard import gsm8k, humaneval, mmlu, mt_bench


def _install_loader(
    monkeypatch: pytest.MonkeyPatch,
    implementation: Callable[..., object],
) -> None:
    datasets = ModuleType("datasets")
    datasets.load_dataset = implementation  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "datasets", datasets)


def test_mmlu_loader_uses_pinned_revision(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []

    def load_dataset(*_args: object, **kwargs: object) -> list[dict[str, object]]:
        calls.append(kwargs)
        return [
            {
                "subject": "math",
                "question": "q1",
                "choices": ["a", "b", "c", "d"],
                "answer": 0,
            },
            {
                "subject": "math",
                "question": "q2",
                "choices": ["a", "b", "c", "d"],
                "answer": 1,
            },
        ]

    _install_loader(monkeypatch, load_dataset)

    assert len(mmlu._load_dataset_examples(limit=2)) == 2
    assert calls == [{"split": "test", "revision": mmlu.DATASET_REVISION}]


def test_gsm8k_loader_uses_pinned_revision(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []

    def load_dataset(*_args: object, **kwargs: object) -> list[dict[str, object]]:
        calls.append(kwargs)
        return [
            {"question": "q1", "answer": "work\n#### 1"},
            {"question": "q2", "answer": "work\n#### 2"},
        ]

    _install_loader(monkeypatch, load_dataset)

    assert len(gsm8k._load_dataset_examples(limit=2)) == 2
    assert calls == [{"split": "test", "revision": gsm8k.DATASET_REVISION}]


def test_humaneval_loader_uses_pinned_revision(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []

    def load_dataset(*_args: object, **kwargs: object) -> list[dict[str, object]]:
        calls.append(kwargs)
        return [
            {
                "task_id": f"HumanEval/{index}",
                "prompt": "def f():\n",
                "canonical_solution": "    return 1\n",
                "test": "def check(candidate):\n    assert candidate() == 1\n",
                "entry_point": "f",
            }
            for index in range(2)
        ]

    _install_loader(monkeypatch, load_dataset)

    assert len(humaneval._load_dataset_examples(limit=2)) == 2
    assert calls == [{"split": "test", "revision": humaneval.DATASET_REVISION}]


def test_mt_bench_loader_uses_pinned_revision(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []

    def load_dataset(*_args: object, **kwargs: object) -> list[dict[str, object]]:
        calls.append(kwargs)
        return [
            {
                "question_id": 81 + index,
                "conversation_a": [
                    {"role": "user", "content": "first"},
                    {"role": "assistant", "content": "answer"},
                    {"role": "user", "content": "second"},
                ],
            }
            for index in range(2)
        ]

    _install_loader(monkeypatch, load_dataset)

    assert len(mt_bench._load_dataset_questions(limit=2)) == 2
    assert calls == [{"split": "human", "revision": mt_bench.DATASET_REVISION}]


@pytest.mark.parametrize(
    ("module", "loader_name"),
    [
        (mmlu, "_load_dataset_examples"),
        (gsm8k, "_load_dataset_examples"),
        (humaneval, "_load_dataset_examples"),
        (mt_bench, "_load_dataset_questions"),
    ],
)
def test_real_loaders_propagate_dataset_failures(
    monkeypatch: pytest.MonkeyPatch,
    module: ModuleType,
    loader_name: str,
) -> None:
    def unavailable(*_args: object, **_kwargs: object) -> object:
        raise OSError("corpus unavailable")

    _install_loader(monkeypatch, unavailable)

    with pytest.raises(OSError, match="corpus unavailable"):
        getattr(module, loader_name)(1)


@pytest.mark.parametrize(
    ("module", "loader_name", "expected_name"),
    [
        (mmlu, "_load_dataset_examples", "EXPECTED_TEST_EXAMPLES"),
        (gsm8k, "_load_dataset_examples", "EXPECTED_TEST_EXAMPLES"),
        (humaneval, "_load_dataset_examples", "EXPECTED_TEST_EXAMPLES"),
        (mt_bench, "_load_dataset_questions", "EXPECTED_QUESTIONS"),
    ],
)
def test_real_loaders_reject_empty_corpora(
    monkeypatch: pytest.MonkeyPatch,
    module: ModuleType,
    loader_name: str,
    expected_name: str,
) -> None:
    _install_loader(monkeypatch, lambda *_args, **_kwargs: [])
    monkeypatch.setattr(module, expected_name, 2)

    with pytest.raises(RuntimeError, match="expected 2"):
        getattr(module, loader_name)(None)
