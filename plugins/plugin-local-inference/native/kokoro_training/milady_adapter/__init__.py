"""milady_adapter — bridge between Eliza training scripts and the vendored
jonirajala/kokoro_training trainer.

Stable surface (importable from packages/training/scripts/kokoro/):
  - VendorEnvironment        capability probe (does this host have the trainer
                             deps installed? does the architecture support
                             full fine-tune today?).
  - build_vendor_config(cfg) translate the elizaOS finetune_kokoro config
                             dict into the vendor's EnglishTrainingConfig.
  - run_full_finetune(cfg, *, output_dir, corpus_dir, max_steps=None,
                      smoke=False) drive the vendor's EnglishTrainer end-to-end.
  - smoke_full_finetune(...) two-step smoke that asserts the import surface
                             and one forward+backward pass.

Everything else is private. Stable surface above is what
packages/training/scripts/kokoro/finetune_kokoro.py imports.
"""

from .config import build_vendor_config
from .environment import VendorEnvironment, probe_vendor_environment
from .runner import run_full_finetune, smoke_full_finetune

__all__ = [
    "VendorEnvironment",
    "build_vendor_config",
    "probe_vendor_environment",
    "run_full_finetune",
    "smoke_full_finetune",
]
