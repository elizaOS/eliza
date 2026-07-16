"""GPU training instrumentation and numerical integrity gates for HF runs.

What this provides:

1. ``GpuMemoryTracker`` — context manager that captures torch.cuda peak memory
   between ``__enter__`` and ``__exit__``. Resets the peak counter on enter.

2. ``InstrumentationCallback`` — a TrainerCallback that:
     - logs allocated / reserved / peak GPU memory each ``log_every_steps``,
     - tracks tokens/sec from ``state.global_step`` * effective batch * seq_len,
     - persists a JSONL trace at ``out_dir/instrumentation.jsonl``,
     - hard-fails the run when peak memory exceeds the budget by
       ``hard_ceiling_pct``.

3. ``log_environment(out_dir)`` — captures GPU model, driver, torch version,
   CUDA version, and a snapshot of nvidia-smi at run start.

4. Finite-value guards — stop on NaN/Inf loss or weights during training and
   scan the persisted model tensors before downstream benchmark or publish.

The point: numbers come from torch's own counters and a JSONL trace anyone
can re-read. No claims of "trained Gemma on 16GB" without proof.
"""

from __future__ import annotations

import json
import logging
import os
import platform
import shutil
import signal
import subprocess
import time
from collections.abc import Iterable, Mapping
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger("instrumentation")


@dataclass
class MemorySnapshot:
    allocated_gb: float
    reserved_gb: float
    peak_allocated_gb: float
    peak_reserved_gb: float


def gpu_memory(device: int = 0) -> MemorySnapshot:
    import torch

    if not torch.cuda.is_available():
        return MemorySnapshot(0.0, 0.0, 0.0, 0.0)
    return MemorySnapshot(
        allocated_gb=torch.cuda.memory_allocated(device) / 1024**3,
        reserved_gb=torch.cuda.memory_reserved(device) / 1024**3,
        peak_allocated_gb=torch.cuda.max_memory_allocated(device) / 1024**3,
        peak_reserved_gb=torch.cuda.max_memory_reserved(device) / 1024**3,
    )


def reset_peak_memory(device: int = 0) -> None:
    import torch

    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats(device)


class GpuMemoryTracker:
    """Context manager: captures peak memory between enter/exit."""

    def __init__(self, device: int = 0):
        self.device = device
        self.start: MemorySnapshot | None = None
        self.end: MemorySnapshot | None = None

    def __enter__(self) -> "GpuMemoryTracker":
        reset_peak_memory(self.device)
        self.start = gpu_memory(self.device)
        return self

    def __exit__(self, *_exc: object) -> None:
        self.end = gpu_memory(self.device)

    @property
    def peak_allocated_gb(self) -> float:
        return self.end.peak_allocated_gb if self.end else 0.0

    @property
    def peak_reserved_gb(self) -> float:
        return self.end.peak_reserved_gb if self.end else 0.0


def _gpu_info() -> dict[str, Any]:
    """Snapshot torch + nvidia-smi for the run-start environment record.

    Best-effort: a missing CUDA driver or nvidia-smi binary is reported as a
    structured field, never an exception. Anything else raises.
    """
    import torch

    info: dict[str, Any] = {
        "torch_version": torch.__version__,
        "cuda_available": torch.cuda.is_available(),
    }
    if torch.cuda.is_available():
        cap = torch.cuda.get_device_capability(0)
        info["device_count"] = torch.cuda.device_count()
        info["device_name"] = torch.cuda.get_device_name(0)
        info["compute_capability"] = f"{cap[0]}.{cap[1]}"
        info["total_memory_gb"] = (
            torch.cuda.get_device_properties(0).total_memory / 1024**3
        )
        info["cuda_runtime"] = torch.version.cuda

    if shutil.which("nvidia-smi"):
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,driver_version,memory.total",
                "--format=csv,noheader",
            ],
            check=False, capture_output=True, text=True, timeout=5,
        )
        if out.returncode == 0:
            info["nvidia_smi"] = out.stdout.strip()
        else:
            info["nvidia_smi_error"] = out.stderr.strip() or f"exit={out.returncode}"
    return info


def _sha256_file(path: Path, *, chunk: int = 1 << 20) -> str:
    """Stream a file through sha256. Raises if the path is not a real file."""
    import hashlib

    h = hashlib.sha256()
    with path.open("rb") as fp:
        while True:
            block = fp.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def _hash_paths(paths: Iterable[Path | str] | None) -> dict[str, str]:
    """sha256 every path that resolves to a local file. Directories are hashed
    by combining their files' hashes (sorted by relative path) so a tokenizer or
    checkpoint directory gets one stable digest. Paths that don't exist locally
    (e.g. a bare HuggingFace repo id) are skipped — reproducibility hashing only
    covers artifacts actually present on disk for this run."""
    import hashlib

    out: dict[str, str] = {}
    for raw in paths or ():
        p = Path(raw)
        if p.is_file():
            out[str(p)] = f"sha256:{_sha256_file(p)}"
        elif p.is_dir():
            combined = hashlib.sha256()
            files = sorted(f for f in p.rglob("*") if f.is_file())
            for f in files:
                combined.update(f.relative_to(p).as_posix().encode("utf-8"))
                combined.update(_sha256_file(f).encode("ascii"))
            out[str(p)] = f"sha256:{combined.hexdigest()}"
    return out


def _run_git(
    args: list[str], *, timeout_seconds: float
) -> subprocess.CompletedProcess[str]:
    """Run a bounded Git probe and tear down its whole POSIX process group.

    ``git status`` may start submodule/fsmonitor children. ``subprocess.run``
    kills only the direct process on timeout, leaving those descendants alive
    with inherited pipes. Training runs are Linux-based, so start a fresh
    session there and terminate the group before re-raising the timeout. Other
    platforms retain the direct-process fallback.
    """
    process = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=os.name == "posix",
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        if os.name == "posix":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            process.kill()
        process.communicate()
        raise
    return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)


def _git_head(*, timeout_seconds: float = 5) -> dict[str, Any]:
    """Capture the training commit for the reproducibility manifest.

    Best-effort: outside a git checkout (or with git absent) the head is
    reported as a structured field, not an exception.
    """
    if not shutil.which("git"):
        return {"available": False, "reason": "git not on PATH"}
    timeout_label = f"{timeout_seconds:g} seconds"
    try:
        out = _run_git(
            ["git", "rev-parse", "HEAD"],
            timeout_seconds=timeout_seconds,
        )
    except subprocess.TimeoutExpired:
        return {
            "available": False,
            "reason": f"git rev-parse timed out after {timeout_label}",
        }
    except OSError as error:
        return {
            "available": False,
            "reason": f"git rev-parse failed to start: {error}",
        }
    if out.returncode != 0:
        detail = out.stderr.strip() or f"exit={out.returncode}"
        return {"available": False, "reason": f"git rev-parse failed: {detail}"}
    head = out.stdout.strip()
    try:
        dirty = _run_git(
            [
                "git",
                # A hard timeout must not strand .git/index.lock.
                "--no-optional-locks",
                # This is best-effort metadata. Do not invoke a configured
                # fsmonitor hook/daemon that could outlive a timed-out probe.
                "-c",
                "core.fsmonitor=false",
                "status",
                "--porcelain",
            ],
            timeout_seconds=timeout_seconds,
        )
    except subprocess.TimeoutExpired:
        return {
            "available": True,
            "head": head,
            "dirty": None,
            "dirty_reason": f"git status timed out after {timeout_label}",
        }
    except OSError as error:
        return {
            "available": True,
            "head": head,
            "dirty": None,
            "dirty_reason": f"git status failed to start: {error}",
        }
    if dirty.returncode != 0:
        detail = dirty.stderr.strip() or f"exit={dirty.returncode}"
        return {
            "available": True,
            "head": head,
            "dirty": None,
            "dirty_reason": f"git status failed: {detail}",
        }
    return {
        "available": True,
        "head": head,
        "dirty": bool(dirty.stdout.strip()),
    }


def log_environment(
    out_dir: Path | str,
    *,
    run_meta: dict[str, Any] | None = None,
    dataset_files: Iterable[Path | str] | None = None,
    tokenizer_path: Path | str | None = None,
    base_checkpoint: Path | str | None = None,
) -> Path:
    """Write a one-shot env snapshot for the training run.

    Beyond platform/GPU/torch, this records the AGENTS.md §9 reproducibility
    manifest: sha256 of every dataset file, the tokenizer artifact hash, the
    base-checkpoint hash, and the training git commit — so a run can be tied
    back to the exact inputs that produced it. Hashes only cover artifacts on
    local disk (a bare HF repo id for the base is skipped, not faked)."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    env_path = out / "environment.json"
    payload = {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "cwd": os.getcwd(),
        "gpu": _gpu_info(),
        "run_meta": run_meta or {},
        "reproducibility": {
            "git": _git_head(),
            "dataset_hashes": _hash_paths(dataset_files),
            "tokenizer_hashes": _hash_paths(
                [tokenizer_path] if tokenizer_path is not None else None
            ),
            "base_checkpoint_hashes": _hash_paths(
                [base_checkpoint] if base_checkpoint is not None else None
            ),
        },
        "timestamp": time.time(),
    }
    env_path.write_text(json.dumps(payload, indent=2))
    return env_path


@dataclass
class InstrumentationConfig:
    out_dir: str
    seq_len: int
    effective_batch_size: int
    """per_device_train_batch_size * grad_accum * world_size."""
    memory_budget_gb: float
    """Hard ceiling — run dies if peak exceeds this * (1+hard_ceiling_pct/100)."""
    hard_ceiling_pct: float = 10.0
    log_every_steps: int = 10
    fail_on_budget_breach: bool = True
    extra: dict[str, Any] = field(default_factory=dict)


class InstrumentationCallback:
    """HF Trainer callback. Imports trainer-callback base lazily so this module
    is importable in environments without transformers installed.
    """

    def __init__(self, cfg: InstrumentationConfig):
        self.cfg = cfg
        self.out_dir = Path(cfg.out_dir)
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.trace_path = self.out_dir / "instrumentation.jsonl"
        self._fp = self.trace_path.open("a", buffering=1)
        self._t0: float | None = None
        self._last_step_t: float | None = None
        self._last_step: int = 0
        self._budget_breached: bool = False

    def _emit(self, payload: dict[str, Any]) -> None:
        self._fp.write(json.dumps(payload) + "\n")

    def on_train_begin(self, args, state, control, **kwargs):
        self._t0 = time.perf_counter()
        self._last_step_t = self._t0
        reset_peak_memory()
        self._emit({
            "event": "train_begin",
            "gpu": _gpu_info(),
            "config": asdict(self.cfg),
        })

    def on_step_end(self, args, state, control, **kwargs):
        step = int(state.global_step)
        if step == 0 or step == self._last_step:
            return
        if step % self.cfg.log_every_steps != 0:
            return
        now = time.perf_counter()
        dt = max(now - (self._last_step_t or now), 1e-6)
        steps_done = step - self._last_step
        self._last_step = step
        self._last_step_t = now

        mem = gpu_memory()
        tokens_in_window = steps_done * self.cfg.effective_batch_size * self.cfg.seq_len
        toks_per_sec = tokens_in_window / dt
        elapsed = now - (self._t0 or now)

        self._emit({
            "event": "step",
            "step": step,
            "elapsed_s": elapsed,
            "tokens_per_sec": toks_per_sec,
            "memory_allocated_gb": mem.allocated_gb,
            "memory_reserved_gb": mem.reserved_gb,
            "memory_peak_allocated_gb": mem.peak_allocated_gb,
            "memory_peak_reserved_gb": mem.peak_reserved_gb,
        })

        ceiling = self.cfg.memory_budget_gb * (1.0 + self.cfg.hard_ceiling_pct / 100.0)
        if mem.peak_reserved_gb > ceiling and not self._budget_breached:
            self._budget_breached = True
            self._emit({
                "event": "budget_breach",
                "budget_gb": self.cfg.memory_budget_gb,
                "ceiling_gb": ceiling,
                "peak_reserved_gb": mem.peak_reserved_gb,
            })
            log.error(
                "GPU memory budget exceeded: peak_reserved=%.1fGB > %.1fGB ceiling",
                mem.peak_reserved_gb, ceiling,
            )
            if self.cfg.fail_on_budget_breach:
                raise RuntimeError(
                    f"GPU memory budget breached: {mem.peak_reserved_gb:.1f}GB > "
                    f"{ceiling:.1f}GB (budget {self.cfg.memory_budget_gb:.0f}GB + "
                    f"{self.cfg.hard_ceiling_pct:.0f}% headroom). Reduce micro_batch "
                    "or seq_len."
                )

    def on_train_end(self, args, state, control, **kwargs):
        mem = gpu_memory()
        elapsed = time.perf_counter() - (self._t0 or 0.0)
        total_tokens = state.global_step * self.cfg.effective_batch_size * self.cfg.seq_len
        avg_tps = total_tokens / max(elapsed, 1e-6)
        self._emit({
            "event": "train_end",
            "total_steps": int(state.global_step),
            "elapsed_s": elapsed,
            "avg_tokens_per_sec": avg_tps,
            "final_peak_allocated_gb": mem.peak_allocated_gb,
            "final_peak_reserved_gb": mem.peak_reserved_gb,
        })
        self._fp.close()


def make_hf_callback(cfg: InstrumentationConfig):
    """Factory returning a TrainerCallback subclass at call time so this
    module stays importable when transformers is missing.

    ``InstrumentationCallback`` comes FIRST in the base list so its
    ``on_step_end`` / ``on_train_begin`` / ``on_train_end`` win the MRO.
    ``TrainerCallback`` defines those as real (no-op) methods, so listing the
    base first shadowed the instrumentation hooks entirely — the memory-budget
    breach guard and the tokens/sec trace never fired.
    """
    from transformers import TrainerCallback

    class _Cb(InstrumentationCallback, TrainerCallback):  # type: ignore[misc]
        def __init__(self, cfg: InstrumentationConfig):
            TrainerCallback.__init__(self)
            InstrumentationCallback.__init__(self, cfg)

    return _Cb(cfg)


def assert_finite_step(model: Any, *, step: int, max_reported: int = 5) -> None:
    """Raise ``RuntimeError`` if any trainable parameter holds a non-finite value.

    Walks ``model.named_parameters()``, checks ``torch.isfinite(p).all()`` on
    every parameter with ``requires_grad``, and raises naming the first
    ``max_reported`` offending tensors. This is architecture-agnostic: it fires
    on the *first* NaN/Inf regardless of root cause (a fused kernel that doesn't
    model an arch's layer layout, a bad LR, an overflowing fp16 activation),
    which is exactly the failure mode that let the gemma4_unified 12B run report
    "complete" while saving an all-NaN checkpoint.

    Cheap by design: one ``isfinite().all()`` reduction per parameter, no host
    sync of the full tensor. Callers gate the frequency (every ``logging_steps``)
    so a divergent run dies within one save interval instead of writing a dead
    checkpoint.
    """
    import torch

    offenders: list[str] = []
    for name, param in model.named_parameters():
        if not param.requires_grad:
            continue
        if not torch.isfinite(param).all():
            offenders.append(name)
            if len(offenders) >= max_reported:
                break
    if offenders:
        raise RuntimeError(
            f"non-finite (NaN/Inf) trainable weights at step {step}: "
            f"{', '.join(offenders)}"
            + (" …" if len(offenders) >= max_reported else "")
            + ". Training diverged — aborting before a dead checkpoint is saved."
        )


def assert_finite_loss(loss: Any, *, context: str = "training loss") -> None:
    """Raise ``RuntimeError`` if a trainer loss tensor is NaN or Inf.

    This guard sits at the loss boundary, before optimizer state or checkpoint
    bytes can be polluted. It complements :func:`assert_finite_step`, which
    catches any non-finite trainable weight that appears after a step.
    """
    import torch

    if not torch.is_tensor(loss):
        return
    if torch.isfinite(loss).all():
        return
    detached = loss.detach()
    if detached.numel() == 1:
        observed = str(detached.item())
    else:
        finite = torch.isfinite(detached)
        bad_count = int((~finite).sum().item())
        observed = f"{bad_count}/{detached.numel()} non-finite element(s)"
    raise RuntimeError(
        f"non-finite (NaN/Inf) {context}: {observed}. "
        "Training diverged — aborting before optimizer step or checkpoint save."
    )


def _checkpoint_tensor_files(checkpoint_dir: Path) -> list[Path]:
    # Hugging Face writes runtime metadata such as `training_args.bin` beside
    # model weights. Treating every pickle-shaped file as a tensor shard makes
    # the safe loader reject valid checkpoints and risks deserializing objects
    # that this numerical gate never needs.
    patterns = (
        "*.safetensors",
        "pytorch_model*.bin",
        "adapter_model*.bin",
        "model_state*.pt",
        "model_state*.pth",
    )
    return sorted(
        path
        for pattern in patterns
        for path in checkpoint_dir.rglob(pattern)
        if path.is_file()
    )


def _load_checkpoint_tensors(path: Path) -> Any:
    if path.suffix == ".safetensors":
        try:
            from safetensors.torch import load_file
        except ImportError as exc:
            raise RuntimeError(
                f"cannot scan {path}: safetensors is not installed"
            ) from exc
        return load_file(str(path), device="cpu")

    import torch

    loaded = torch.load(path, map_location="cpu", weights_only=True)
    return loaded


def _iter_checkpoint_tensors(
    value: Any, *, prefix: str = "<root>"
) -> Iterable[tuple[str, Any]]:
    import torch

    if torch.is_tensor(value):
        yield prefix, value
        return
    if isinstance(value, Mapping):
        for name, child in value.items():
            child_prefix = str(name) if prefix == "<root>" else f"{prefix}.{name}"
            yield from _iter_checkpoint_tensors(child, prefix=child_prefix)
        return
    if isinstance(value, (list, tuple)):
        for index, child in enumerate(value):
            child_prefix = f"{prefix}[{index}]"
            yield from _iter_checkpoint_tensors(child, prefix=child_prefix)


def assert_finite_checkpoint(
    checkpoint_dir: Path | str,
    *,
    max_reported: int = 10,
) -> dict[str, Any]:
    """Scan a saved checkpoint directory and fail on any non-finite tensor.

    This is the publish-blocking post-train gate for ``run_pipeline.py``:
    even if a trainer process exits zero, a NaN/Inf tensor in the saved HF
    checkpoint aborts before benchmark, quantization, or publish stages.
    """
    import torch

    root = Path(checkpoint_dir)
    if not root.is_dir():
        raise RuntimeError(f"checkpoint finite scan target is not a directory: {root}")

    files = _checkpoint_tensor_files(root)
    if not files:
        raise RuntimeError(
            f"checkpoint finite scan found no tensor shards under {root}"
        )

    scanned_tensors = 0
    offenders: list[str] = []
    for file_path in files:
        state = _load_checkpoint_tensors(file_path)
        for name, tensor in _iter_checkpoint_tensors(state):
            scanned_tensors += 1
            if torch.isfinite(tensor).all():
                continue
            finite = torch.isfinite(tensor)
            bad_count = int((~finite).sum().item())
            offenders.append(
                f"{file_path.relative_to(root)}:{name} "
                f"({bad_count}/{tensor.numel()} non-finite)"
            )
            if len(offenders) >= max_reported:
                break
        if len(offenders) >= max_reported:
            break

    if scanned_tensors == 0:
        names = ", ".join(path.relative_to(root).as_posix() for path in files)
        raise RuntimeError(
            f"checkpoint finite scan found tensor shard files but no tensors under {root}: {names}"
        )

    if offenders:
        raise RuntimeError(
            "non-finite (NaN/Inf) checkpoint tensor(s): "
            + "; ".join(offenders)
            + (" …" if len(offenders) >= max_reported else "")
            + ". Training diverged — aborting before benchmark, quantize, or publish."
        )

    return {
        "checkpoint": str(root),
        "tensor_files": len(files),
        "tensors": scanned_tensors,
        "passed": True,
    }


class FiniteWeightsCallback:
    """HF Trainer callback that hard-fails a divergent run.

    Runs :func:`assert_finite_step` across trainable parameters every
    ``check_every_steps`` (default: aligned with ``logging_steps``). A run whose
    weights NaN out dies within one logging interval with an explicit error
    naming the offending tensors, rather than completing and silently persisting
    an all-NaN checkpoint. Registered unconditionally — this guard is not gated
    on the optional memory-budget instrumentation.

    Base-class-free like :class:`InstrumentationCallback`; the concrete
    ``TrainerCallback`` subclass is built by :func:`make_finite_weights_callback`
    so this module stays importable without transformers.
    """

    def __init__(self, check_every_steps: int = 10):
        self.check_every_steps = max(1, int(check_every_steps))
        self._last_step = -1

    def on_step_end(self, args, state, control, model=None, **kwargs):
        step = int(state.global_step)
        if step == self._last_step:
            return
        if step % self.check_every_steps != 0:
            return
        self._last_step = step
        if model is None:
            return
        assert_finite_step(model, step=step)


def make_finite_weights_callback(check_every_steps: int = 10):
    """Factory returning a TrainerCallback subclass at call time so this module
    stays importable when transformers is missing.

    ``FiniteWeightsCallback`` comes FIRST in the base list so its ``on_step_end``
    wins the MRO — ``TrainerCallback.on_step_end`` is a real (no-op) override, so
    listing the base first would shadow the guard and it would never fire.
    """
    from transformers import TrainerCallback

    class _Cb(FiniteWeightsCallback, TrainerCallback):  # type: ignore[misc]
        def __init__(self, check_every_steps: int):
            TrainerCallback.__init__(self)
            FiniteWeightsCallback.__init__(self, check_every_steps)

    return _Cb(check_every_steps)


__all__ = [
    "FiniteWeightsCallback",
    "GpuMemoryTracker",
    "InstrumentationCallback",
    "InstrumentationConfig",
    "MemorySnapshot",
    "assert_finite_loss",
    "assert_finite_checkpoint",
    "assert_finite_step",
    "gpu_memory",
    "log_environment",
    "make_finite_weights_callback",
    "make_hf_callback",
    "reset_peak_memory",
]
