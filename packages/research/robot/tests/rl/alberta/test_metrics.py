"""Continual-learning metric correctness (pure, fast — no JAX)."""

from __future__ import annotations

import numpy as np

from eliza_robot.rl.alberta.metrics import compute_continual_metrics


def test_perfect_retention_zero_forgetting():
    # Every task stays at its trained level forever -> BWT 0, forgetting 0.
    R = np.array(
        [
            [10.0, 0.0, 0.0],
            [10.0, 10.0, 0.0],
            [10.0, 10.0, 10.0],
        ]
    )
    m = compute_continual_metrics(R)
    assert m.acc == 10.0
    assert m.bwt == 0.0
    assert m.forgetting == 0.0


def test_catastrophic_forgetting_negative_bwt():
    # Each new task wipes the previous ones to 0.
    R = np.array(
        [
            [10.0, 0.0, 0.0],
            [0.0, 10.0, 0.0],
            [0.0, 0.0, 10.0],
        ]
    )
    m = compute_continual_metrics(R)
    assert m.acc == 10.0 / 3.0
    # tasks 0,1 dropped from 10 -> 0 by the final phase.
    assert m.bwt == -10.0
    assert m.forgetting == 10.0


def test_fwt_positive_when_prior_training_helps():
    R = np.array(
        [
            [5.0, 4.0],
            [5.0, 8.0],
        ]
    )
    baseline = np.array([0.0, 0.0])
    m = compute_continual_metrics(R, baseline)
    # task 1 scored 4.0 after phase 0 (before its own phase) vs baseline 0.0
    assert m.fwt == 4.0


def test_forgetting_never_negative_when_later_training_improves_task():
    R = np.array(
        [
            [2.0, 0.0],
            [3.5, 4.0],
        ]
    )
    m = compute_continual_metrics(R)
    assert m.bwt == 1.5
    assert m.forgetting == 0.0


def test_requires_square_matrix():
    import pytest

    with pytest.raises(ValueError):
        compute_continual_metrics(np.zeros((2, 3)))
