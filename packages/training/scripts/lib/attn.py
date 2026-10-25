"""Flash-attention implementation selector.

Picks the most aggressive flash-attention impl the silicon supports:
- FA-3 on sm_90 (H100/H200) only; sm_120 Blackwell consumer/Pro GPUs are not
  yet supported by FA-2 prebuilt wheels (FA #1665/#1810/#1987) and a source
  build takes ~1h.
- FA-2 when flash_attn is installed and sm_90 is not detected.
- PyTorch SDPA fallback when flash_attn is missing or the device is not CUDA.
"""

from __future__ import annotations

import logging

log = logging.getLogger(__name__)


def select_attn_impl(device: str) -> str:
    """Return the attn_implementation string for the given device."""
    if device != "cuda":
        return "sdpa"
    import torch

    cap = torch.cuda.get_device_capability(0)
    try:
        import flash_attn  # noqa: F401

        attn_impl = "flash_attention_2"
        if cap == (9, 0):
            if int(getattr(flash_attn, "__version__", "0").split(".")[0]) >= 3:
                attn_impl = "flash_attention_3"
    except ImportError:
        attn_impl = "sdpa"
    log.info("attn_implementation=%s (compute_capability=%s)", attn_impl, cap)
    return attn_impl
