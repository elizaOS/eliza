"""GPU memory + throughput instrumentation for HF training runs.

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

The point: numbers come from torch's own counters and a JSONL trace anyone
can re-read. No claims of "trained Qwen on 16GB" without proof.
"""

from __future__ import annotations

import json
import logging
import os
import platform
import shutil
import subprocess
import time
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


def log_environment(out_dir: Path | str, *, run_meta: dict[str, Any] | None = None) -> Path:
    """Write a one-shot env snapshot for the training run."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    env_path = out / "environment.json"
    payload = {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "cwd": os.getcwd(),
        "gpu": _gpu_info(),
        "run_meta": run_meta or {},
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
    module stays importable when transformers is missing."""
    from transformers import TrainerCallback

    class _Cb(TrainerCallback, InstrumentationCallback):  # type: ignore[misc]
        def __init__(self, cfg: InstrumentationConfig):
            TrainerCallback.__init__(self)
            InstrumentationCallback.__init__(self, cfg)

    return _Cb(cfg)


__all__ = [
    "GpuMemoryTracker",
    "InstrumentationCallback",
    "InstrumentationConfig",
    "MemorySnapshot",
    "gpu_memory",
    "log_environment",
    "make_hf_callback",
    "reset_peak_memory",
]
