"""
Loaders for official AgentBench data (vendored under ``upstream/``).

These loaders read upstream's published task data and convert it into
the local ``AgentBenchTask`` dataclass, preserving the upstream scoring
contract (label-based result equality for DB, set match + F1 for KG,
match/check scripts for OS, BLEU/eval-agent for LTP).

Splits
------
Each loader accepts ``split``: ``"dev"`` (smaller validation set) or
``"test"`` (the official "standard" set used on the AgentBench
leaderboard). ``"test"`` is the default.

Missing or partial environments
-------------------------------
- ALFWorld (HOUSEHOLDING): requires TextWorld + hundreds of MB of
  game files; we read the manifest but actual env execution is
  conditional on a local install (see ``HouseholdingEnvironmentAdapter``).
- Web Browsing (MIND2WEB): we load upstream's prompt fixtures and
  defer to the local ``packages/benchmarks/mind2web`` adapter for the
  full HTML/action loop.
- Card Game: ``src.server.tasks.card_game`` is preserved upstream but
  depends on a native AI SDK. We expose the task indices but actual
  evaluation is conditional on the SDK being built.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from elizaos_agentbench.types import (
    AgentBenchEnvironment,
    AgentBenchTask,
    TaskDifficulty,
)

logger = logging.getLogger(__name__)

# Resolve the vendored upstream directory relative to this file.
_HERE = Path(__file__).resolve().parent
UPSTREAM_ROOT = _HERE.parent / "upstream"
UPSTREAM_DATA = UPSTREAM_ROOT / "data"


class UpstreamDataMissingError(FileNotFoundError):
    """Raised when an upstream data file cannot be located."""


def _check_root() -> None:
    if not UPSTREAM_DATA.is_dir():
        raise UpstreamDataMissingError(
            f"Vendored upstream AgentBench data not found at {UPSTREAM_DATA}. "
            f"See packages/benchmarks/agentbench/upstream/README.md."
        )


def _resolve_split_path(env_dir: str, split: str, candidates: list[str]) -> Path:
    """Resolve a split filename within an upstream env dir.

    ``candidates`` is the list of basenames to try (in order) for the
    requested split. Returns the first one that exists.
    """
    _check_root()
    base = UPSTREAM_DATA / env_dir
    if not base.is_dir():
        raise UpstreamDataMissingError(f"Upstream env dir missing: {base}")
    for name in candidates:
        path = base / name
        if path.exists():
            return path
    raise UpstreamDataMissingError(
        f"No data file for split={split!r} in {base} "
        f"(tried: {', '.join(candidates)})"
    )


def _split_files(split: str, dev: list[str], test: list[str]) -> list[str]:
    if split == "dev":
        return dev
    if split == "test":
        return test
    raise ValueError(f"split must be 'dev' or 'test', got {split!r}")


# ---------------------------------------------------------------------------
# DB Bench
# ---------------------------------------------------------------------------

def load_db_tasks(split: str = "test", limit: int | None = None) -> list[AgentBenchTask]:
    """Load DBBench tasks from upstream.

    Upstream entries have ``description``, ``label`` (the gold answer
    list), ``table`` (inline schema/rows), and ``type`` (SELECT, INSERT,
    UPDATE, DELETE, or ``other``).
    """
    files = _split_files(split, dev=["dev.jsonl"], test=["standard.jsonl"])
    path = _resolve_split_path("dbbench", split, files)
    tasks: list[AgentBenchTask] = []
    with path.open("r", encoding="utf-8") as f:
        for i, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            table = entry.get("table") or {}
            schema_columns = []
            data_rows = []
            if isinstance(table, dict):
                tinfo = table.get("table_info", {})
                cols = tinfo.get("columns", []) if isinstance(tinfo, dict) else []
                for c in cols:
                    schema_columns.append({"name": c["name"], "type": c.get("type", "TEXT")})
                for row in tinfo.get("rows", []):
                    data_rows.append(dict(zip([c["name"] for c in cols], row)))
            t_types = entry.get("type") or ["SELECT"]
            ttype = t_types[0] if isinstance(t_types, list) else str(t_types)
            tasks.append(
                AgentBenchTask(
                    id=f"db-{split}-{i:04d}",
                    environment=AgentBenchEnvironment.DATABASE,
                    description=entry["description"],
                    initial_state={
                        "schema": {table.get("table_name", "t"): schema_columns} if schema_columns else {},
                        "data": {table.get("table_name", "t"): data_rows} if data_rows else {},
                        "evidence": entry.get("evidence", ""),
                        "add_description": entry.get("add_description", ""),
                    },
                    goal=entry["description"],
                    max_steps=15,
                    timeout_ms=120_000,
                    ground_truth=json.dumps(entry.get("label", [])),
                    difficulty=TaskDifficulty.MEDIUM,
                    metadata={
                        "type": ttype,
                        "source": entry.get("source", "agentbench-dbbench"),
                        "table_name": table.get("table_name", ""),
                        "label": entry.get("label", []),
                    },
                )
            )
            if limit is not None and len(tasks) >= limit:
                break
    logger.info(f"[upstream_loader] Loaded {len(tasks)} DB tasks from {path.name}")
    return tasks


# ---------------------------------------------------------------------------
# Knowledge Graph (Freebase subgraph)
# ---------------------------------------------------------------------------

def load_kg_tasks(split: str = "test", limit: int | None = None) -> list[AgentBenchTask]:
    """Load Knowledge Graph tasks from upstream Freebase subgraph data."""
    files = _split_files(split, dev=["dev.json"], test=["std.json"])
    path = _resolve_split_path("knowledgegraph", split, files)
    tasks: list[AgentBenchTask] = []
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    for i, entry in enumerate(data):
        answer_list = entry.get("answer") or []
        gold = sorted({a.get("answer_argument", "") for a in answer_list if isinstance(a, dict)})
        gold_names = sorted({a.get("entity_name", "") for a in answer_list if isinstance(a, dict) and a.get("entity_name")})
        tasks.append(
            AgentBenchTask(
                id=f"kg-{split}-{i:04d}",
                environment=AgentBenchEnvironment.KNOWLEDGE_GRAPH,
                description=entry["question"],
                initial_state={
                    "entities": entry.get("entities", {}),
                    "qid": entry.get("qid", ""),
                    "source": entry.get("source", ""),
                },
                goal=entry["question"],
                max_steps=15,
                timeout_ms=120_000,
                ground_truth=", ".join(gold_names) if gold_names else ", ".join(gold),
                difficulty=TaskDifficulty.HARD,
                metadata={
                    "qid": entry.get("qid", ""),
                    "source": entry.get("source", ""),
                    "gold_ids": gold,
                    "gold_names": gold_names,
                    "s_expression": entry.get("s_expression", ""),
                },
            )
        )
        if limit is not None and len(tasks) >= limit:
            break
    logger.info(f"[upstream_loader] Loaded {len(tasks)} KG tasks from {path.name}")
    return tasks


# ---------------------------------------------------------------------------
# Lateral Thinking Puzzle (xlsx)
# ---------------------------------------------------------------------------

def load_ltp_tasks(split: str = "test", limit: int | None = None) -> list[AgentBenchTask]:
    """Load Lateral Thinking Puzzle tasks from upstream xlsx."""
    files = _split_files(split, dev=["dev.xlsx"], test=["standard.xlsx"])
    path = _resolve_split_path("lateralthinkingpuzzle", split, files)
    try:
        import openpyxl  # type: ignore
    except ImportError as e:
        raise ImportError(
            "openpyxl is required to load LTP tasks. Install with `pip install openpyxl`."
        ) from e
    wb = openpyxl.load_workbook(path, read_only=True)
    ws = wb.active
    tasks: list[AgentBenchTask] = []
    rows = list(ws.iter_rows(values_only=True))
    # Upstream xlsx has no explicit header — col order is story, answer, story_key, answer_key
    # If first row looks like a header (contains "story" or non-puzzle words), skip it.
    start = 0
    if rows and rows[0] and isinstance(rows[0][0], str) and rows[0][0].strip().lower() in {"story", "汤面"}:
        start = 1
    for i, row in enumerate(rows[start:]):
        if not row or row[0] is None:
            continue
        # Cells may be None for shorter rows
        story = (row[0] or "").strip() if isinstance(row[0], str) else str(row[0])
        answer = (row[1] or "").strip() if (len(row) > 1 and isinstance(row[1], str)) else (str(row[1]) if len(row) > 1 and row[1] is not None else "")
        story_key = (row[2] or "").strip() if (len(row) > 2 and isinstance(row[2], str)) else ""
        answer_key = (row[3] or "").strip() if (len(row) > 3 and isinstance(row[3], str)) else ""
        if not story or not answer:
            continue
        tasks.append(
            AgentBenchTask(
                id=f"ltp-{split}-{i:04d}",
                environment=AgentBenchEnvironment.LATERAL_THINKING,
                description=story,
                initial_state={"story_key": story_key, "answer_key": answer_key},
                goal="Deduce the truth ('answer') behind the story by asking yes/no/irrelevant questions.",
                max_steps=25,
                timeout_ms=300_000,
                ground_truth=answer,
                difficulty=TaskDifficulty.HARD,
                metadata={
                    "story_key": story_key,
                    "answer_key": answer_key,
                    "answer_key_count": len([k for k in (answer_key.split("\n") if answer_key else []) if k.strip()]),
                },
            )
        )
        if limit is not None and len(tasks) >= limit:
            break
    wb.close()
    logger.info(f"[upstream_loader] Loaded {len(tasks)} LTP tasks from {path.name}")
    return tasks


# ---------------------------------------------------------------------------
# OS Interaction
# ---------------------------------------------------------------------------

def load_os_tasks(split: str = "test", limit: int | None = None) -> list[AgentBenchTask]:
    """Load OS interaction tasks from upstream.

    Upstream layout: ``data/os_interaction/data/{dev.json,1,2,...,7}``.
    ``dev.json`` is the dev split. ``test`` aggregates per-category
    folders ``1`` through ``7`` (the leaderboard subset).
    """
    base = UPSTREAM_DATA / "os_interaction" / "data"
    if not base.is_dir():
        raise UpstreamDataMissingError(f"OS data missing: {base}")

    files: list[Path] = []
    if split == "dev":
        files = [base / "dev.json"]
    elif split == "test":
        # Per upstream configs/tasks/os.yaml the standard split is a
        # glob over the sub-directory jsons.
        for sub in sorted(base.iterdir()):
            if sub.is_dir():
                for jf in sorted(sub.glob("*.json")):
                    files.append(jf)
    else:
        raise ValueError(f"split must be 'dev' or 'test', got {split!r}")

    tasks: list[AgentBenchTask] = []
    for jf in files:
        if not jf.exists():
            continue
        try:
            raw = json.loads(jf.read_text(encoding="utf-8"))
        except Exception as e:
            logger.warning(f"[upstream_loader] Failed to parse {jf}: {e}")
            continue
        items = raw if isinstance(raw, list) else [raw]
        for j, entry in enumerate(items):
            if not isinstance(entry, dict) or "description" not in entry:
                continue
            evaluation = entry.get("evaluation", {})
            tasks.append(
                AgentBenchTask(
                    id=f"os-{split}-{jf.stem}-{j:03d}",
                    environment=AgentBenchEnvironment.OS,
                    description=entry["description"],
                    initial_state={
                        "create": entry.get("create", {}),
                        "start": entry.get("start"),
                        "labels": entry.get("labels", []),
                    },
                    goal=entry["description"],
                    max_steps=8,
                    timeout_ms=180_000,
                    ground_truth=evaluation.get("match")
                    if isinstance(evaluation.get("match"), str)
                    else None,
                    difficulty=TaskDifficulty.MEDIUM,
                    metadata={
                        "evaluation": evaluation,
                        "file": str(jf.relative_to(UPSTREAM_ROOT)) if jf.is_relative_to(UPSTREAM_ROOT) else jf.name,
                    },
                )
            )
            if limit is not None and len(tasks) >= limit:
                return tasks
    logger.info(f"[upstream_loader] Loaded {len(tasks)} OS tasks for split={split}")
    return tasks


# ---------------------------------------------------------------------------
# ALFWorld (HOUSEHOLDING)
# ---------------------------------------------------------------------------

def load_householding_tasks(split: str = "test", limit: int | None = None) -> list[AgentBenchTask]:
    """Load ALFWorld task manifest (game-file paths grouped by category).

    The actual game files live outside this repo and must be fetched
    with `alfworld-download` (see env adapter). Each manifest entry
    becomes one ``AgentBenchTask`` whose ``metadata.game_file`` points
    at the relative TextWorld game path.
    """
    files = _split_files(
        split,
        dev=["dev.json"],
        # Upstream uses ``new_std.json`` in current configs (the "Bench-Lite"
        # subset); ``standard.json`` is the legacy file.
        test=["new_std.json", "standard.json"],
    )
    path = _resolve_split_path("alfworld", split, files)
    raw = json.loads(path.read_text(encoding="utf-8"))
    tasks: list[AgentBenchTask] = []
    idx = 0
    if isinstance(raw, dict):
        for category, paths in raw.items():
            if not isinstance(paths, list):
                continue
            for game_path in paths:
                tasks.append(
                    AgentBenchTask(
                        id=f"hh-{split}-{idx:04d}",
                        environment=AgentBenchEnvironment.HOUSEHOLDING,
                        description=f"ALFWorld {category} task: follow natural language instructions in a TextWorld household environment.",
                        initial_state={"game_file": game_path, "category": category},
                        goal=f"Complete the household task ({category}) described by the game.",
                        max_steps=30,
                        timeout_ms=300_000,
                        ground_truth=None,
                        difficulty=TaskDifficulty.HARD,
                        metadata={"game_file": game_path, "category": category},
                    )
                )
                idx += 1
                if limit is not None and len(tasks) >= limit:
                    logger.info(f"[upstream_loader] Loaded {len(tasks)} ALFWorld tasks (capped)")
                    return tasks
    logger.info(f"[upstream_loader] Loaded {len(tasks)} ALFWorld tasks from {path.name}")
    return tasks


# ---------------------------------------------------------------------------
# Web Browsing (Mind2Web)
# ---------------------------------------------------------------------------

def load_web_browsing_tasks(split: str = "test", limit: int | None = None) -> list[AgentBenchTask]:
    """Load Mind2Web tasks.

    Upstream only ships the prompt fixtures here; the full
    HTML-trace dataset is hosted on HuggingFace. We delegate the
    dataset load to ``packages/benchmarks/mind2web`` and only return
    task stubs keyed by the prompt index. The Web Browsing adapter
    pulls real samples on demand.
    """
    prompt_file = UPSTREAM_DATA / "mind2web" / "prompt" / "llm_prompt.json"
    if not prompt_file.exists():
        raise UpstreamDataMissingError(f"Mind2Web prompt fixture missing: {prompt_file}")
    raw = json.loads(prompt_file.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError("Mind2Web prompt fixture is not a list")
    tasks: list[AgentBenchTask] = []
    for i, entry in enumerate(raw):
        if not isinstance(entry, dict):
            continue
        content = entry.get("content", "")
        if not isinstance(content, str) or not content.strip():
            continue
        tasks.append(
            AgentBenchTask(
                id=f"m2w-{split}-{i:04d}",
                environment=AgentBenchEnvironment.WEB_BROWSING,
                description="Mind2Web web-action selection task.",
                initial_state={"prompt_index": i, "split": split},
                goal="Select the correct next web action from the candidate list.",
                max_steps=1,
                timeout_ms=30_000,
                ground_truth=None,
                difficulty=TaskDifficulty.MEDIUM,
                metadata={"prompt_role": entry.get("role", ""), "prompt_index": i},
            )
        )
        if limit is not None and len(tasks) >= limit:
            break
    logger.info(f"[upstream_loader] Loaded {len(tasks)} Mind2Web tasks from prompt fixture")
    return tasks


# ---------------------------------------------------------------------------
# Card Game (Avalon proxy)
# ---------------------------------------------------------------------------

def load_card_game_tasks(split: str = "test", limit: int | None = None) -> list[AgentBenchTask]:
    """Load Card Game tasks.

    Upstream re-purposed the Card Game environment to use Avalon-style
    multi-agent play. The data here is the per-game configuration; we
    surface that as a list of N opaque games per split.
    """
    # Upstream config: cg-dev uses test_time=3, cg-std uses test_time=5
    counts = {"dev": 3, "test": 5}
    if split not in counts:
        raise ValueError(f"split must be 'dev' or 'test', got {split!r}")
    n = counts[split]
    if limit is not None:
        n = min(n, limit)
    tasks: list[AgentBenchTask] = []
    for i in range(n):
        tasks.append(
            AgentBenchTask(
                id=f"cg-{split}-{i:03d}",
                environment=AgentBenchEnvironment.CARD_GAME,
                description="AgentBench Card Game (Avalon variant): play a full game as one of the assigned roles and win.",
                initial_state={"game_index": i, "split": split},
                goal="Win the game as the assigned role.",
                max_steps=40,
                timeout_ms=600_000,
                ground_truth=None,
                difficulty=TaskDifficulty.HARD,
                metadata={"game_index": i},
            )
        )
    logger.info(f"[upstream_loader] Loaded {len(tasks)} Card Game tasks (split={split})")
    return tasks


# ---------------------------------------------------------------------------
# WebShop
# ---------------------------------------------------------------------------

def load_webshop_tasks(split: str = "test", limit: int | None = None) -> list[AgentBenchTask]:
    """Load WebShop tasks.

    Upstream's WebShop env relies on the WebShop Flask sim (a separate
    repo) plus a multi-gigabyte product corpus. We don't vendor the
    corpus; instead we read upstream's task list shape and stub each
    task. The Web Shopping adapter pulls items lazily via the local
    WebShop bridge when ``WEBSHOP_DATA_DIR`` is set.
    """
    # Upstream's webshop has no JSON-shipped task list in this snapshot;
    # the official benchmark draws 200 / 500 instructions from the
    # WebShop dataset at run time. We expose those as deterministic IDs.
    counts = {"dev": 20, "test": 500}
    if split not in counts:
        raise ValueError(f"split must be 'dev' or 'test', got {split!r}")
    n = counts[split]
    if limit is not None:
        n = min(n, limit)
    tasks: list[AgentBenchTask] = []
    for i in range(n):
        tasks.append(
            AgentBenchTask(
                id=f"ws-{split}-{i:04d}",
                environment=AgentBenchEnvironment.WEB_SHOPPING,
                description="WebShop task: find and purchase a product matching a natural-language instruction.",
                initial_state={"webshop_index": i, "split": split},
                goal="Purchase a matching product (reward >= 1.0 == exact match).",
                max_steps=15,
                timeout_ms=300_000,
                ground_truth=None,
                difficulty=TaskDifficulty.MEDIUM,
                metadata={"webshop_index": i},
            )
        )
    logger.info(f"[upstream_loader] Stubbed {len(tasks)} WebShop tasks (split={split})")
    return tasks


# ---------------------------------------------------------------------------
# Public dispatcher
# ---------------------------------------------------------------------------

_LOADERS = {
    AgentBenchEnvironment.DATABASE: load_db_tasks,
    AgentBenchEnvironment.KNOWLEDGE_GRAPH: load_kg_tasks,
    AgentBenchEnvironment.LATERAL_THINKING: load_ltp_tasks,
    AgentBenchEnvironment.OS: load_os_tasks,
    AgentBenchEnvironment.HOUSEHOLDING: load_householding_tasks,
    AgentBenchEnvironment.WEB_BROWSING: load_web_browsing_tasks,
    AgentBenchEnvironment.CARD_GAME: load_card_game_tasks,
    AgentBenchEnvironment.WEB_SHOPPING: load_webshop_tasks,
}


def load_tasks(
    env: AgentBenchEnvironment,
    split: str = "test",
    limit: int | None = None,
) -> list[AgentBenchTask]:
    """Load official AgentBench tasks for the given env + split."""
    loader = _LOADERS.get(env)
    if loader is None:
        raise NotImplementedError(f"No upstream loader registered for {env.value}")
    return loader(split=split, limit=limit)


__all__ = [
    "UPSTREAM_ROOT",
    "UPSTREAM_DATA",
    "UpstreamDataMissingError",
    "load_db_tasks",
    "load_kg_tasks",
    "load_ltp_tasks",
    "load_os_tasks",
    "load_householding_tasks",
    "load_web_browsing_tasks",
    "load_card_game_tasks",
    "load_webshop_tasks",
    "load_tasks",
]
