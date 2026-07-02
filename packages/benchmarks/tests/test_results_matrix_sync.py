"""Pin docs/RESULTS_MATRIX.md to the benchmark registry and adapter discovery.

#11374: the results matrix is a human-readable artifact, but its registered and
adapter-only rows must be owned by tests just like orchestrator/ci_coverage.py.
This keeps a registry addition/removal from silently drifting the committed
scoreboard.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

BENCHMARKS_ROOT = Path(__file__).resolve().parent.parent
PACKAGES_ROOT = BENCHMARKS_ROOT.parent
sys.path.insert(0, str(BENCHMARKS_ROOT))
sys.path.insert(0, str(PACKAGES_ROOT))

from benchmarks.orchestrator.adapters import discover_adapters  # noqa: E402
from benchmarks.orchestrator.ci_coverage import ci_lane_for  # noqa: E402
from benchmarks.registry import get_benchmark_registry  # noqa: E402

MATRIX_PATH = BENCHMARKS_ROOT / "docs" / "RESULTS_MATRIX.md"
CERTIFICATION_PATH = BENCHMARKS_ROOT / "docs" / "CERTIFICATION.md"
MATRIX_COLUMNS = ("benchmark", "lane", "eliza", "hermes", "openclaw", "smithers")
CERTIFICATION_COLUMNS = ("benchmark", "eliza", "hermes", "openclaw", "smithers")
NON_SCORE_CELLS = {"not-run", "gated", "incompatible"}
SCORE_RE = re.compile(r"^(?:0|1)(?:\.\d+)?$")


def _markdown_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _strip_cell(cell: str) -> str:
    return re.sub(r"[*`]", "", cell.strip()).strip()


def _split_table_row(line: str) -> tuple[str, ...]:
    return tuple(_strip_cell(cell) for cell in line.strip().strip("|").split("|"))


def _is_separator(row: tuple[str, ...]) -> bool:
    return bool(row) and all(re.fullmatch(r":?-{3,}:?", cell.strip()) for cell in row)


def _table_after_heading(text: str, heading_re: str) -> list[tuple[str, ...]]:
    heading_match = re.search(heading_re, text, flags=re.MULTILINE)
    assert heading_match, f"heading not found: {heading_re}"

    rows: list[tuple[str, ...]] = []
    in_table = False
    for line in text[heading_match.end() :].splitlines():
        if line.startswith("|"):
            in_table = True
            row = _split_table_row(line)
            if not _is_separator(row):
                rows.append(row)
            continue
        if in_table:
            break

    assert rows, f"table not found after heading: {heading_re}"
    return rows


def _section_count(text: str, heading_re: str) -> int:
    match = re.search(heading_re, text, flags=re.MULTILINE)
    assert match, f"heading not found: {heading_re}"
    return int(match.group("count"))


def _rows_by_benchmark(
    text: str,
    heading_re: str,
    expected_columns: tuple[str, ...],
) -> dict[str, tuple[str, ...]]:
    rows = _table_after_heading(text, heading_re)
    header = rows[0]
    assert header == expected_columns

    parsed: dict[str, tuple[str, ...]] = {}
    for row in rows[1:]:
        assert len(row) == len(expected_columns), f"malformed row: {row!r}"
        benchmark_id = row[0]
        assert benchmark_id not in parsed, f"duplicate matrix row: {benchmark_id}"
        parsed[benchmark_id] = row
    return parsed


def _registered_registry_ids() -> frozenset[str]:
    return frozenset(entry.id for entry in get_benchmark_registry(PACKAGES_ROOT))


def _adapter_only_ids(registry_ids: frozenset[str]) -> frozenset[str]:
    adapter_ids = frozenset(discover_adapters(PACKAGES_ROOT).adapters)
    return adapter_ids - registry_ids


def _certified_scores() -> dict[str, tuple[str, str, str, str]]:
    rows = _rows_by_benchmark(
        _markdown_text(CERTIFICATION_PATH),
        r"^## Posted 4-harness results\b.*$",
        CERTIFICATION_COLUMNS,
    )
    return {benchmark_id: row[1:] for benchmark_id, row in rows.items()}


def _assert_score_cells_are_honest(
    benchmark_id: str,
    score_cells: tuple[str, ...],
    certified_scores: dict[str, tuple[str, str, str, str]],
) -> None:
    if any(SCORE_RE.fullmatch(cell) for cell in score_cells):
        assert benchmark_id in certified_scores, (
            f"{benchmark_id} has numeric matrix score(s) {score_cells} but is "
            "not backed by the Posted 4-harness results table in CERTIFICATION.md"
        )
        assert score_cells == certified_scores[benchmark_id], (
            f"{benchmark_id} matrix scores {score_cells} do not match "
            f"CERTIFICATION.md {certified_scores[benchmark_id]}"
        )
        return

    unexpected = sorted(set(score_cells) - NON_SCORE_CELLS)
    assert not unexpected, f"{benchmark_id} has unsupported matrix cell(s): {unexpected}"


def test_registered_results_matrix_rows_match_registry_exactly() -> None:
    text = _markdown_text(MATRIX_PATH)
    registry_ids = _registered_registry_ids()
    registered_rows = _rows_by_benchmark(
        text,
        r"^## Registered benchmarks \((?P<count>\d+)\)$",
        MATRIX_COLUMNS,
    )

    assert _section_count(text, r"^## Registered benchmarks \((?P<count>\d+)\)$") == len(
        registry_ids
    )
    assert set(registered_rows) == set(registry_ids)


def test_registered_results_matrix_lanes_match_ci_coverage() -> None:
    text = _markdown_text(MATRIX_PATH)
    registered_rows = _rows_by_benchmark(
        text,
        r"^## Registered benchmarks \((?P<count>\d+)\)$",
        MATRIX_COLUMNS,
    )

    for benchmark_id, row in registered_rows.items():
        assert row[1] == ci_lane_for(benchmark_id), (
            f"{benchmark_id} lane {row[1]!r} does not match "
            f"ci_coverage.py {ci_lane_for(benchmark_id)!r}"
        )


def test_registered_results_matrix_scores_match_certification_or_are_explicitly_unrun() -> None:
    text = _markdown_text(MATRIX_PATH)
    registered_rows = _rows_by_benchmark(
        text,
        r"^## Registered benchmarks \((?P<count>\d+)\)$",
        MATRIX_COLUMNS,
    )
    certified_scores = _certified_scores()

    for benchmark_id, row in registered_rows.items():
        _assert_score_cells_are_honest(benchmark_id, row[2:], certified_scores)


def test_adapter_only_results_matrix_rows_match_discovery_minus_registry() -> None:
    text = _markdown_text(MATRIX_PATH)
    registry_ids = _registered_registry_ids()
    adapter_only_ids = _adapter_only_ids(registry_ids)
    adapter_rows = _rows_by_benchmark(
        text,
        r"^## Adapter-discovered / non-registry \((?P<count>\d+)\)$",
        MATRIX_COLUMNS,
    )

    assert _section_count(
        text, r"^## Adapter-discovered / non-registry \((?P<count>\d+)\)$"
    ) == len(adapter_only_ids)
    assert set(adapter_rows) == set(adapter_only_ids)

    for benchmark_id, row in adapter_rows.items():
        assert row[1] == ci_lane_for(benchmark_id), (
            f"{benchmark_id} lane {row[1]!r} does not match "
            f"ci_coverage.py {ci_lane_for(benchmark_id)!r}"
        )
        unexpected = sorted(set(row[2:]) - NON_SCORE_CELLS)
        assert not unexpected, (
            f"{benchmark_id} is adapter-only and must not carry numeric score "
            f"cells in RESULTS_MATRIX.md: {unexpected}"
        )
