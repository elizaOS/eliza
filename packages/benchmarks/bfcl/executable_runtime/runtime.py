"""
BFCL Executable Runtime
=======================

Adapted from upstream BFCL (Apache 2.0).
Source:
    https://github.com/ShishirPatil/gorilla
    berkeley-function-call-leaderboard/bfcl_eval/eval_checker/multi_turn_eval/multi_turn_utils.py

This module actually instantiates and invokes the upstream BFCL tool
implementations (GorillaFileSystem, MathAPI, MessageAPI, WebSearchAPI,
MemoryAPI_*, etc.). It replaces the previous synthetic always-success mocks.

Network-dependent classes are gated by an ``enable_network`` flag. When
disabled, attempting to use them raises ``RuntimeNetworkRequired`` so the
caller can mark the affected test ``SKIPPED_NO_CREDENTIALS`` and exclude it
from the accuracy denominator.

Deviations from upstream:
  * Per-test instance scope via ``ExecutableRuntime`` instead of stashing
    instances in ``globals()`` (the upstream pattern is not safe under
    concurrent test runs and risks bleed-through between tests).
  * Vendored package path:
        ``benchmarks.bfcl.executable_runtime.func_source_code.*``
    instead of
        ``bfcl_eval.eval_checker.multi_turn_eval.func_source_code.*``
  * Optional shimming of the memory API helpers (see
    ``func_source_code/memory_api_metaclass.py``). Memory categories require
    additional upstream scaffolding we do not vendor; the runner marks them
    SKIPPED_UNSUPPORTED.
"""

from __future__ import annotations

import copy
import importlib
import inspect
import json
import re
import tempfile
from pathlib import Path
from typing import Any, Optional


# Mirrors upstream `bfcl_eval/constants/executable_backend_config.py`.
_BACKEND_PATH_PREFIX = "benchmarks.bfcl.executable_runtime.func_source_code"

CLASS_FILE_PATH_MAPPING: dict[str, str] = {
    "GorillaFileSystem": f"{_BACKEND_PATH_PREFIX}.gorilla_file_system",
    "MathAPI": f"{_BACKEND_PATH_PREFIX}.math_api",
    "MessageAPI": f"{_BACKEND_PATH_PREFIX}.message_api",
    "TwitterAPI": f"{_BACKEND_PATH_PREFIX}.posting_api",
    "TicketAPI": f"{_BACKEND_PATH_PREFIX}.ticket_api",
    "TradingBot": f"{_BACKEND_PATH_PREFIX}.trading_bot",
    "TravelAPI": f"{_BACKEND_PATH_PREFIX}.travel_booking",
    "VehicleControlAPI": f"{_BACKEND_PATH_PREFIX}.vehicle_control",
    "WebSearchAPI": f"{_BACKEND_PATH_PREFIX}.web_search",
    # Memory backends are pseudo-classes — upstream maps the generic
    # "MemoryAPI" involved-class to one of the three concrete variants based
    # on the test category. We register each variant under its concrete name;
    # the generic "MemoryAPI" alias is resolved at runtime via
    # ``MEMORY_BACKEND_CLASSES`` below.
    "MemoryAPI_kv": f"{_BACKEND_PATH_PREFIX}.memory_kv",
    "MemoryAPI_vector": f"{_BACKEND_PATH_PREFIX}.memory_vector",
    "MemoryAPI_rec_sum": f"{_BACKEND_PATH_PREFIX}.memory_rec_sum",
}

# Memory variant class names — used when resolving the generic "MemoryAPI"
# involved-class against a concrete backend.
MEMORY_BACKEND_CLASSES: dict[str, str] = {
    "kv": "MemoryAPI_kv",
    "vector": "MemoryAPI_vector",
    "rec_sum": "MemoryAPI_rec_sum",
}

# Stateless tools don't carry per-test state.
STATELESS_CLASSES = {"MathAPI"}

# Tools that require live network or credentials. Tests touching these are
# skipped (NOT failed) unless the runtime is constructed with enable_network=True.
NETWORK_REQUIRED_CLASSES = {"WebSearchAPI"}

# Memory backends that need heavy ML dependencies (faiss + sentence-transformers
# for vector). Gated separately so the runtime gracefully reports the missing
# dep instead of dying with an opaque ImportError.
HEAVY_DEPS_CLASSES = {"MemoryAPI_vector"}


class RuntimeNetworkRequired(RuntimeError):
    """Raised when a test requires a network-backed class and the runtime
    was not granted network access."""


# Identifiers that we forbid from appearing in eval'd function calls, as a
# defense-in-depth measure on top of the upstream guard. Note this is the
# upstream allowance set, retained verbatim: the eval'd code only invokes
# methods on the upstream tool instances, never arbitrary Python.
_FORBIDDEN_NAMES = {
    "kill", "exit", "quit", "remove", "unlink",
    "popen", "Popen", "run", "system", "spawnl", "spawnle", "spawnv",
    "execv", "execve", "execvp", "execvpe", "execlp", "execle", "execl",
}


class ExecutableRuntime:
    """Per-test runtime that owns the tool instances for a single BFCL entry.

    Replaces upstream's module-globals stash with explicit per-test scope.
    The lifecycle is: construct, then call ``execute_calls`` once per turn,
    feeding the model's predicted python calls (strings, e.g.
    ``"GorillaFileSystem.ls(a=True)"``). Results are stringified the same
    way upstream stringifies them.
    """

    def __init__(
        self,
        involved_classes: list[str],
        initial_config: Optional[dict[str, Any]] = None,
        *,
        long_context: bool = False,
        enable_network: bool = False,
        memory_backend: Optional[str] = None,
    ) -> None:
        self.involved_classes = list(involved_classes or [])
        self.initial_config = initial_config or {}
        self.long_context = long_context
        self.enable_network = enable_network
        self.memory_backend = memory_backend

        self._instances: dict[str, Any] = {}
        self._method_to_class: dict[str, str] = {}
        self._memory_tempdir: Optional[tempfile.TemporaryDirectory] = None

        # Resolve the generic "MemoryAPI" alias (used in raw fixture
        # ``involved_classes``) to a concrete backend class.
        resolved_classes: list[str] = []
        for class_name in self.involved_classes:
            if class_name == "MemoryAPI":
                backend = self.memory_backend or "kv"
                resolved = MEMORY_BACKEND_CLASSES.get(backend)
                if resolved is None:
                    raise ValueError(
                        f"Unknown memory backend {backend!r}; "
                        f"expected one of {list(MEMORY_BACKEND_CLASSES)}"
                    )
                resolved_classes.append(resolved)
            else:
                resolved_classes.append(class_name)
        self.involved_classes = resolved_classes

        for class_name in self.involved_classes:
            if class_name not in CLASS_FILE_PATH_MAPPING:
                raise ValueError(f"Unknown BFCL class: {class_name!r}")
            if class_name in NETWORK_REQUIRED_CLASSES and not enable_network:
                raise RuntimeNetworkRequired(
                    f"Class {class_name!r} requires network access. "
                    f"Pass enable_network=True to allow."
                )

            module_name = CLASS_FILE_PATH_MAPPING[class_name]
            try:
                module = importlib.import_module(module_name)
            except ImportError as exc:
                if class_name in HEAVY_DEPS_CLASSES:
                    raise RuntimeError(
                        f"Class {class_name!r} requires optional ML deps "
                        f"(faiss-cpu, sentence-transformers): {exc}"
                    ) from exc
                raise
            cls = getattr(module, class_name)
            instance = cls()
            if class_name not in STATELESS_CLASSES:
                class_initial_config = self.initial_config.get(class_name, {})
                # Memory classes need a ``model_result_dir`` for the snapshot
                # dance. Provide a per-runtime tempdir so memory tests run
                # fully isolated when the caller didn't supply one.
                if class_name.startswith("MemoryAPI_"):
                    class_initial_config = self._ensure_memory_snapshot_dir(
                        class_initial_config
                    )
                # Deep copy to avoid mutation of the shared config dict
                instance._load_scenario(
                    copy.deepcopy(class_initial_config), long_context=long_context
                )
            self._instances[class_name] = instance

            # Map each public method back to its owning class. Upstream uses
            # a flat method->instance mapping, which has the same name-collision
            # caveat we retain.
            for method_name, _method in inspect.getmembers(
                instance, predicate=inspect.ismethod
            ):
                if method_name.startswith("_"):
                    continue
                self._method_to_class[method_name] = class_name

    def _ensure_memory_snapshot_dir(self, cfg: dict[str, Any]) -> dict[str, Any]:
        """Inject a tempdir-backed ``model_result_dir`` if the caller didn't
        supply one. Memory backends require this path to exist for snapshot
        files; if upstream's full directory layout isn't provided we mint
        a private one and clean it up when the runtime is garbage-collected.
        """
        cfg = dict(cfg)
        if "model_result_dir" in cfg:
            mrd = cfg["model_result_dir"]
            cfg["model_result_dir"] = Path(mrd) if not isinstance(mrd, Path) else mrd
        else:
            if self._memory_tempdir is None:
                self._memory_tempdir = tempfile.TemporaryDirectory(
                    prefix="bfcl_memory_"
                )
            cfg["model_result_dir"] = Path(self._memory_tempdir.name)
        cfg.setdefault("test_id", "memory_unit_test-scenario-0")
        cfg.setdefault("scenario", "scenario")
        return cfg

    def cleanup(self) -> None:
        """Best-effort cleanup of any temp dirs created for memory tests."""
        if self._memory_tempdir is not None:
            try:
                self._memory_tempdir.cleanup()
            except Exception:
                pass
            self._memory_tempdir = None

    def __del__(self) -> None:
        try:
            self.cleanup()
        except Exception:
            pass

    def execute_calls(self, func_call_list: list[str]) -> list[str]:
        """Execute a list of BFCL python call strings against the tool
        instances owned by this runtime. Returns one stringified result per
        call (or an ``"Error during execution: ..."`` marker on failure)."""
        # eval() needs the instance bindings in its locals.
        eval_globals = {name: inst for name, inst in self._instances.items()}

        results: list[str] = []
        for raw_call in func_call_list:
            processed = self._qualify_method_calls(str(raw_call))

            try:
                # Defense-in-depth: refuse to eval if the call mentions a
                # forbidden builtin even after we prefix instance names.
                self._reject_forbidden(processed)
                value = eval(processed, eval_globals, {})  # noqa: S307
            except RuntimeNetworkRequired:
                raise
            except Exception as e:
                results.append(f"Error during execution: {e}")
                continue

            if isinstance(value, str):
                results.append(value)
            elif isinstance(value, dict):
                try:
                    results.append(json.dumps(value))
                except Exception:
                    results.append(str(value))
            else:
                results.append(str(value))

        return results

    def _qualify_method_calls(self, call: str) -> str:
        """Prefix bare method calls with their owning instance name.

        e.g. ``ls(a=True)`` -> ``GorillaFileSystem.ls(a=True)`` when ``ls``
        belongs to GorillaFileSystem.
        """
        def replace(match: re.Match[str]) -> str:
            name = match.group(1)
            return f"{self._method_to_class[name]}.{name}" if name in self._method_to_class else name

        return re.sub(r"\b([a-zA-Z_]\w*)\s*(?=\()", replace, call)

    @staticmethod
    def _reject_forbidden(call: str) -> None:
        head = call
        if "(" in head:
            head = head.split("(", 1)[0]
        if "." in head:
            head = head.rsplit(".", 1)[-1]
        if head in _FORBIDDEN_NAMES:
            raise RuntimeError(f"Function call {head!r} is not allowed.")


def execute_multi_turn_func_call(
    func_call_list: list[str],
    initial_config: dict,
    involved_classes: list,
    model_name: str,  # kept for signature parity with upstream
    test_entry_id: str,  # kept for signature parity with upstream
    long_context: bool = False,
    enable_network: bool = False,
    runtime: Optional[ExecutableRuntime] = None,
) -> tuple[list[str], ExecutableRuntime]:
    """Functional wrapper that mirrors upstream's `execute_multi_turn_func_call`.

    Differences from upstream:
      * Returns the ``ExecutableRuntime`` instead of the bare instance dict,
        so the caller can re-use it across turns (the multi-turn driver
        does so).
      * ``enable_network`` gate (see module docstring).
    """
    if runtime is None:
        runtime = ExecutableRuntime(
            involved_classes=involved_classes,
            initial_config=initial_config,
            long_context=long_context,
            enable_network=enable_network,
        )
    results = runtime.execute_calls(func_call_list)
    return results, runtime


def decode_python_calls(text: str) -> list[str]:
    """Heuristically extract python-style call strings from a model response.

    BFCL expects model output to be a python list of call expressions like
    ``[GorillaFileSystem.ls(a=True), TwitterAPI.post_tweet(content='hi')]``.
    Models often emit it inside fenced code blocks or wrapped in prose, so
    we strip fences and ``ast.literal_eval`` style markers before parsing.
    """
    if not text:
        return []
    s = text.strip()
    # Strip code fences
    if s.startswith("```"):
        s = s.split("\n", 1)[-1] if "\n" in s else s
        if s.endswith("```"):
            s = s[: -3]
        s = s.strip()
    # Pull the first top-level [ ... ] block
    if not s.startswith("["):
        m = re.search(r"\[.*?\]", s, flags=re.DOTALL)
        if not m:
            return []
        s = m.group(0)

    # Split on top-level commas (depth-aware).
    inner = s[1:-1] if s.startswith("[") and s.endswith("]") else s
    parts: list[str] = []
    buf: list[str] = []
    depth = 0
    in_str: Optional[str] = None
    for ch in inner:
        if in_str:
            buf.append(ch)
            if ch == in_str and (len(buf) < 2 or buf[-2] != "\\"):
                in_str = None
        elif ch in ("'", '"'):
            in_str = ch
            buf.append(ch)
        elif ch in "([{":
            depth += 1
            buf.append(ch)
        elif ch in ")]}":
            depth -= 1
            buf.append(ch)
        elif ch == "," and depth == 0:
            piece = "".join(buf).strip()
            if piece:
                parts.append(piece)
            buf = []
        else:
            buf.append(ch)
    tail = "".join(buf).strip()
    if tail:
        parts.append(tail)
    return parts
