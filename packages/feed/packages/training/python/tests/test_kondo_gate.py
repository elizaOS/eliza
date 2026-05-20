from __future__ import annotations

import pytest
import torch
from kondo_gate import KondoGate, KondoGateConfig


def test_kondo_gate_config_rejects_gate_rate_and_price() -> None:
    with pytest.raises(ValueError, match="either gate_rate or price"):
        KondoGate(KondoGateConfig(gate_rate=0.3, price=1.0))


def test_kondo_gate_compute_delight_uses_advantage_times_surprisal() -> None:
    gate = KondoGate()
    log_probs = torch.tensor([-1.0, -2.0, -0.5])
    advantages = torch.tensor([1.0, -1.0, 3.0])

    delight = gate.compute_delight(log_probs, advantages)

    assert torch.allclose(delight, torch.tensor([1.0, -2.0, 1.5]))
    assert not delight.requires_grad


def test_kondo_gate_compute_gate_returns_binary_samples_in_hard_mode() -> None:
    torch.manual_seed(7)
    gate = KondoGate(KondoGateConfig(gate_rate=0.5, hard=True))
    output = gate.compute_gate(torch.randn(8), torch.randn(8))

    assert output.gate_weights.shape == (8,)
    assert torch.allclose(output.gate_weights, output.gate_weights.round())


def test_kondo_gate_forward_supports_attention_mask() -> None:
    torch.manual_seed(11)
    gate = KondoGate(KondoGateConfig(gate_rate=0.5, hard=False))
    logits = torch.randn(2, 4, 16, requires_grad=True)
    actions = torch.randint(0, 16, (2, 4))
    advantages = torch.randn(2, 4)
    attention_mask = torch.tensor([[1, 1, 1, 0], [1, 1, 0, 0]])

    output = gate(
        logits=logits,
        actions=actions,
        advantages=advantages,
        attention_mask=attention_mask,
    )
    output.gated_policy_loss.backward()

    assert output.gated_policy_loss is not None
    assert torch.isfinite(output.gated_policy_loss)
    assert logits.grad is not None


def test_kondo_gate_fixed_price_matches_manual_sigmoid() -> None:
    gate = KondoGate(KondoGateConfig(gate_rate=None, price=1.0, temperature=0.5, hard=False))
    log_probs = torch.tensor([-2.0, -1.0, -0.5])
    advantages = torch.tensor([1.0, 2.0, 3.0])

    output = gate.compute_gate(log_probs, advantages)

    expected = torch.sigmoid(torch.tensor([2.0, 2.0, 1.0]))
    assert torch.allclose(output.gate_probs, expected, atol=1e-6)


def test_kondo_gate_deterministic_hard_mode_uses_threshold_selection() -> None:
    gate = KondoGate(
        KondoGateConfig(
            gate_rate=None,
            price=1.5,
            temperature=0.2,
            hard=True,
            deterministic=True,
        )
    )
    log_probs = torch.tensor([-2.0, -1.0, -0.25])
    advantages = torch.tensor([1.0, 1.0, 1.0])

    output = gate.compute_gate(log_probs, advantages)

    assert torch.equal(output.gate_weights, torch.tensor([1.0, 0.0, 0.0]))
