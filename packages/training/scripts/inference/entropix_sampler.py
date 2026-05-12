"""Entropix entropy/varentropy sampler for Eliza inference.

Per-step logit post-processor: picks one of {greedy, forced-clarifier,
temp-bumped resample, mask-and-resample} from (entropy, varentropy) of the
next-token distribution. Refs: https://github.com/xjdr-alt/entropix

NOT compatible with vLLM spec-decode (EAGLE-3 / DFlash); launcher hard-errors.
"""
from __future__ import annotations

from dataclasses import dataclass

import torch
from transformers import LogitsProcessor


@dataclass(frozen=True)
class EntropixThresholds:
    low_ent: float = 0.30        # nats
    high_ent: float = 2.50
    low_varent: float = 1.20
    high_varent: float = 2.50
    helv_temp: float = 0.30
    lehv_temp: float = 1.20
    hehv_temp: float = 1.50
    clarifier_token_id: int = -1  # set per-tokenizer; -1 disables HELV


def ent_varent(logits: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    logp = torch.log_softmax(logits.float(), dim=-1)
    p = logp.exp()
    ent = -(p * logp).sum(dim=-1)
    diff = logp + ent.unsqueeze(-1)
    varent = (p * diff.square()).sum(dim=-1)
    return ent, varent


def entropix_step(logits: torch.Tensor, th: EntropixThresholds) -> torch.Tensor:
    """Return a (B,) tensor of chosen token ids, computed from (B, V) logits."""
    ent, varent = ent_varent(logits)
    out = torch.empty(logits.shape[0], dtype=torch.long, device=logits.device)
    for i in range(logits.shape[0]):
        e, v = float(ent[i]), float(varent[i])
        row = logits[i]
        if e < th.low_ent and v < th.low_varent:
            out[i] = row.argmax()                                # LELV greedy
        elif e > th.high_ent and v < th.low_varent and th.clarifier_token_id >= 0:
            out[i] = th.clarifier_token_id                        # HELV forced clarifier
        elif e < th.high_ent and v > th.high_varent:
            out[i] = torch.distributions.Categorical(             # LEHV temp bump
                logits=row / th.lehv_temp).sample()
        elif e > th.low_varent and v > th.high_varent:
            t = torch.distributions.Categorical(                  # HEHV mask + resample
                logits=row / th.hehv_temp).sample()
            row2 = row.clone()
            row2[t] = float("-inf")
            out[i] = torch.distributions.Categorical(logits=row2 / th.hehv_temp).sample()
        else:
            out[i] = torch.distributions.Categorical(logits=row).sample()
    return out


class EntropixLogitsProcessor(LogitsProcessor):
    def __init__(self, thresholds: EntropixThresholds):
        self.th = thresholds

    def __call__(self, input_ids: torch.LongTensor, scores: torch.Tensor) -> torch.Tensor:
        chosen = entropix_step(scores, self.th)
        out = torch.full_like(scores, float("-inf"))
        out.scatter_(1, chosen.unsqueeze(1), 0.0)        # delta-mass at chosen id
        return out


# vLLM v1 plugin — only loaded when --logits-processors flag is set.
try:
    from vllm.v1.sample.logits_processor import BatchUpdate
    from vllm.v1.sample.logits_processor import LogitsProcessor as VLLMLP

    class VLLMEntropixProcessor(VLLMLP):
        def __init__(self, vocab_size: int, device: torch.device, *_, **__):
            self.th = EntropixThresholds()           # TODO: read from extra_args

        def is_argmax_invariant(self) -> bool:
            return False

        def update_state(self, batch_update: BatchUpdate | None) -> None:
            pass

        def apply(self, logits: torch.Tensor) -> torch.Tensor:
            chosen = entropix_step(logits, self.th)
            out = torch.full_like(logits, float("-inf"))
            out.scatter_(1, chosen.unsqueeze(1), 0.0)
            return out
except ImportError:
    pass
