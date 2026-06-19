"""Tests for named Step 2 UPGD ablation configurations."""

from __future__ import annotations

from pathlib import Path
from types import ModuleType
from typing import Any

from conftest import load_script

_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "The Alberta Plan"
    / "Step2"
    / "step2_upgd_ablation.py"
)


def load_ablation_module() -> ModuleType:
    return load_script(_SCRIPT_PATH, "step2_upgd_ablation")


def test_class_blocked_retention_preset_names_are_runnable() -> None:
    module = load_ablation_module()

    names = module.PRESET_CONFIGS["class_blocked_retention"]
    assert {
        "upgd_density_sigma1e_4_adaptk035_065_lr06_repx0_notrunk_tight",
        "upgd_density_sigma1e_4_adaptk035_065_lr06_repx025",
        "upgd_density_sigma1e_4_adaptk035_065_lr06_repx025_meta001_notrunk_tight",
        "upgd_density_sigma1e_4_adaptk035_065_lr06_repx075",
        "upgd_density_sigma1e_4_adaptk035_065_lr06_repx075_meta001_notrunk_tight",
        "upgd_density_sigma1e_4_adaptk035_065_lr06_meta003_notrunk_tight",
        "upgd_density_sigma1e_4_adaptk035_065_lr06_meta003_trunk_head_tight",
        "upgd_density_sigma1e_4_adaptk035_065_lr06_rep_learned_notrunk_tight",
    } == set(names)

    for name in names:
        learner = module.make_upgd(module.UPGD_CATALOG[name], n_heads=10)
        cfg = learner.to_config()
        assert cfg["loss_normalization"] == "target_density"
        assert cfg["adaptive_kappa_mode"] == "loss_ratio"
        assert cfg["adaptive_kappa_min"] == 0.35
        assert cfg["adaptive_kappa_max"] == 0.65


def test_class_blocked_repetition_and_meta_axes_are_explicit() -> None:
    module = load_ablation_module()
    catalog = module.UPGD_CATALOG

    assert (
        catalog[
            "upgd_density_sigma1e_4_adaptk035_065_lr06_repx0_notrunk_tight"
        ].head_repetition_multiplier
        == 0.0
    )
    assert (
        catalog[
            "upgd_density_sigma1e_4_adaptk035_065_lr06_repx025_meta001_notrunk_tight"
        ].head_repetition_multiplier
        == 0.25
    )
    assert (
        catalog[
            "upgd_density_sigma1e_4_adaptk035_065_lr06_repx075_meta001_notrunk_tight"
        ].head_repetition_multiplier
        == 0.75
    )
    assert (
        catalog[
            "upgd_density_sigma1e_4_adaptk035_065_lr06_meta003_notrunk_tight"
        ].meta_plasticity_trunk_enabled
        is False
    )
    assert (
        catalog[
            "upgd_density_sigma1e_4_adaptk035_065_lr06_meta003_trunk_head_tight"
        ].meta_plasticity_trunk_enabled
        is True
    )


def test_structure_adaptive_retention_preset_is_native_structure() -> None:
    module = load_ablation_module()

    names = module.PRESET_CONFIGS["structure_adaptive_retention"]
    assert {
        "upgd_structure_sigma1e_4_adaptk035_065_lr06_meta003_notrunk_tight",
        "upgd_structure_sigma1e_4_adaptk035_065_lr06_repx025_meta001_notrunk_tight",
        "upgd_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_notrunk_tight",
    } == set(names)

    for name in names:
        learner = module.make_upgd(module.UPGD_CATALOG[name], n_heads=10)
        cfg = learner.to_config()
        assert cfg["loss_normalization"] == "target_structure"
        assert cfg["adaptive_kappa_mode"] == "loss_ratio"
        assert cfg["meta_plasticity_mode"] == "gradient_alignment"


def test_class_blocked_bias_repetition_rescue_preset_is_runnable() -> None:
    module = load_ablation_module()

    names = module.PRESET_CONFIGS["class_blocked_bias_repetition_rescue"]
    assert {
        "upgd_density_sigma1e_4_adaptk035_065_lr06_repx035_meta001_notrunk_tight",
        "upgd_density_sigma1e_4_adaptk035_065_lr06_repx05_meta001_bias025_notrunk_tight",
        "upgd_density_sigma1e_4_adaptk035_065_lr06_repx05_meta001_bias0_notrunk_tight",
        "upgd_density_sigma1e_4_adaptk035_065_lr06_repx075_meta001_bias0_notrunk_tight",
        "upgd_density_sigma1e_4_adaptk035_065_lr06_meta003_repx025_notrunk_tight",
    } <= set(names)

    repx035 = module.UPGD_CATALOG[
        "upgd_density_sigma1e_4_adaptk035_065_lr06_repx035_meta001_notrunk_tight"
    ]
    bias0 = module.UPGD_CATALOG[
        "upgd_density_sigma1e_4_adaptk035_065_lr06_repx075_meta001_bias0_notrunk_tight"
    ]
    meta003_repx = module.UPGD_CATALOG[
        "upgd_density_sigma1e_4_adaptk035_065_lr06_meta003_repx025_notrunk_tight"
    ]

    assert repx035.head_repetition_multiplier == 0.35
    assert bias0.head_bias_step_size_multiplier == 0.0
    assert meta003_repx.meta_plasticity_step_size == 0.003
    assert meta003_repx.head_repetition_multiplier == 0.25


def test_class_blocked_deep_rescue_preset_is_runnable() -> None:
    module = load_ablation_module()

    names = module.PRESET_CONFIGS["class_blocked_deep_rescue"]
    assert {
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_headx2_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_headscale_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk05_10_lr06_repx075_meta001_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk075_15_lr06_repx075_meta001_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_softmax_notrunk_tight",
    } <= set(names)

    headx2 = module.UPGD_CATALOG[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_headx2_notrunk_tight"
    ]
    wider_kappa = module.UPGD_CATALOG[
        "upgd64_64_structure_sigma1e_4_adaptk075_15_lr06_repx075_meta001_notrunk_tight"
    ]
    softmax = module.UPGD_CATALOG[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_softmax_notrunk_tight"
    ]

    assert headx2.hidden_sizes == (64, 64)
    assert headx2.head_step_size_multiplier == 2.0
    assert wider_kappa.adaptive_kappa_max == 1.5
    assert softmax.readout_mode == "softmax_ce"


def test_class_blocked_softmax_closeout_preset_is_runnable() -> None:
    module = load_ablation_module()

    names = module.PRESET_CONFIGS["class_blocked_softmax_closeout"]
    assert {
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr07_repx075_meta001_softmax_notrunk_tight",
        "upgd64_64_structure_sigma0_adaptk035_065_lr06_repx075_meta001_softmax_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_softmax_headx15_notrunk_tight",
    } <= set(names)

    lr07 = module.UPGD_CATALOG[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr07_repx075_meta001_softmax_notrunk_tight"
    ]
    sigma0 = module.UPGD_CATALOG[
        "upgd64_64_structure_sigma0_adaptk035_065_lr06_repx075_meta001_softmax_notrunk_tight"
    ]

    assert lr07.readout_mode == "softmax_ce"
    assert lr07.step_size == module.STEP_SIZE * 0.7
    assert sigma0.perturbation_sigma == 0.0


def test_readout_consistency_adaptive_preset_is_runnable() -> None:
    module = load_ablation_module()

    names = module.PRESET_CONFIGS["readout_consistency_adaptive"]
    assert {
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr07_repx075_meta001_softmax_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_adaptive_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr07_repx075_meta001_adaptive_notrunk_tight",
    } == set(names)

    adaptive_lr06 = module.UPGD_CATALOG[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_adaptive_notrunk_tight"
    ]
    adaptive_lr07 = module.UPGD_CATALOG[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr07_repx075_meta001_adaptive_notrunk_tight"
    ]

    assert adaptive_lr06.readout_mode == "adaptive_simplex"
    assert adaptive_lr07.readout_mode == "adaptive_simplex"
    assert adaptive_lr07.step_size == module.STEP_SIZE * 0.7


def test_readout_consistency_decoupled_preset_is_runnable() -> None:
    module = load_ablation_module()

    names = module.PRESET_CONFIGS["readout_consistency_decoupled"]
    assert {
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_linearloss_softmaxpred_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_celoss_identitypred_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_celoss_clippred_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_gceq07_softmax_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_adaptivegceq07_notrunk_tight",
    } <= set(names)

    linear_softmax = module.UPGD_CATALOG[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_linearloss_softmaxpred_notrunk_tight"
    ]
    ce_identity = module.UPGD_CATALOG[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_celoss_identitypred_notrunk_tight"
    ]
    robust = module.UPGD_CATALOG[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_gceq07_softmax_notrunk_tight"
    ]
    clipped = module.UPGD_CATALOG[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_celoss_clippred_notrunk_tight"
    ]

    assert linear_softmax.readout_loss_mode == "linear_mse"
    assert linear_softmax.readout_prediction_mode == "softmax"
    assert ce_identity.readout_loss_mode == "softmax_ce"
    assert ce_identity.readout_prediction_mode == "identity"
    assert clipped.readout_prediction_mode == "unit_clip"
    assert robust.readout_loss_mode == "gce"
    assert robust.readout_robust_q == 0.7


def test_readout_consistency_factorized_preset_serializes_adapter_fields() -> None:
    module = load_ablation_module()

    names = module.PRESET_CONFIGS["readout_consistency_factorized"]
    assert {
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr07_repx075_meta001_softmax_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_adaptive_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_factorized_adapterslow_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_factorized_adaptermoderate_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_factorized_adapterfast_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr07_repx075_meta001_factorized_adaptermoderate_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_factorized_adaptermoderate_idreg1e_4_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_factorized_adaptermoderate_idreg1e_3_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_factorized_adaptermoderate_idreg1e_2_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_adaptivefactorized_adapterslow_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_adaptivefactorized_adaptermoderate_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_adaptivefactorized_adaptermoderate_idreg1e_3_notrunk_tight",
    } == set(names)

    catalog = module.UPGD_CATALOG
    assert catalog[names[0]].readout_mode == "linear_mse"
    assert catalog[names[1]].readout_mode == "softmax_ce"
    assert catalog[names[2]].readout_mode == "adaptive_simplex"

    slow = catalog[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_factorized_adapterslow_notrunk_tight"
    ]
    moderate = catalog[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_factorized_adaptermoderate_notrunk_tight"
    ]
    fast = catalog[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_factorized_adapterfast_notrunk_tight"
    ]
    lr07 = catalog[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr07_repx075_meta001_factorized_adaptermoderate_notrunk_tight"
    ]
    idreg1e3 = catalog[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_factorized_adaptermoderate_idreg1e_3_notrunk_tight"
    ]
    adaptive_factorized = catalog[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_adaptivefactorized_adaptermoderate_idreg1e_3_notrunk_tight"
    ]

    assert slow.readout_mode == "factorized_simplex"
    assert slow.readout_adapter_step_size == 0.003
    assert moderate.readout_adapter_step_size == 0.01
    assert fast.readout_adapter_step_size == 0.03
    assert lr07.step_size == module.STEP_SIZE * 0.7
    assert lr07.readout_adapter_step_size == 0.01
    assert idreg1e3.readout_adapter_identity_reg == 1e-3
    assert adaptive_factorized.readout_mode == "adaptive_factorized_simplex"
    assert adaptive_factorized.readout_adapter_step_size == 0.01
    assert adaptive_factorized.readout_adapter_identity_reg == 1e-3

    serialized = module.config_to_json(idreg1e3)
    assert serialized["hidden_sizes"] == [64, 64]
    assert serialized["readout_mode"] == "factorized_simplex"
    assert serialized["readout_adapter_step_size"] == 0.01
    assert serialized["readout_adapter_identity_reg"] == 1e-3
    assert serialized["readout_adapter_entropy_reg"] is None


def test_factorized_adapter_fields_forward_when_constructor_supports_them(
    monkeypatch: Any,
) -> None:
    module = load_ablation_module()
    captured: dict[str, Any] = {}
    missing = object()

    class FakeUPGDLearner:
        def __init__(
            self,
            *,
            readout_label_adapter_step_size: float = 0.0,
            readout_label_adapter_identity_regularization: float = 0.0,
            readout_label_adapter_entropy_regularization: object = missing,
            **kwargs: Any,
        ) -> None:
            captured.update(kwargs)
            captured["readout_label_adapter_step_size"] = (
                readout_label_adapter_step_size
            )
            captured["readout_label_adapter_identity_regularization"] = (
                readout_label_adapter_identity_regularization
            )
            captured["readout_label_adapter_entropy_regularization"] = (
                readout_label_adapter_entropy_regularization
            )

    monkeypatch.setattr(module, "UPGDLearner", FakeUPGDLearner)

    config = module.UPGD_CATALOG[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_factorized_adaptermoderate_idreg1e_3_notrunk_tight"
    ]
    learner = module.make_upgd(config, n_heads=10)

    assert isinstance(learner, FakeUPGDLearner)
    assert captured["readout_mode"] == "factorized_simplex"
    assert captured["readout_label_adapter_step_size"] == 0.01
    assert captured["readout_label_adapter_identity_regularization"] == 1e-3
    assert captured["readout_label_adapter_entropy_regularization"] is missing


def test_readout_consistency_twotime_preset_serializes_fast_head_fields() -> None:
    module = load_ablation_module()

    names = module.PRESET_CONFIGS["readout_consistency_twotime"]
    assert {
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr07_repx075_meta001_softmax_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_adaptive_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_adaptivefactorized_adaptermoderate_idreg1e_3_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx05_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx1_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx2_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr07_repx075_meta001_twotime_fastx1_notrunk_tight",
    } == set(names)
    assert {
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr07_repx075_meta001_softmax_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx1_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx1_trunk025_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx1_trunk05_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx2_trunk05_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx2_trunk1_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx2_trunk2_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx3_trunk1_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx2_trunk2_slow0_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx2_trunk2_slow025_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx3_trunk1_slow0_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx3_trunk1_slow025_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx2_trunk2_slow0_sepbound_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx2_trunk2_slow025_sepbound_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx3_trunk1_slow0_sepbound_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx3_trunk1_slow025_sepbound_notrunk_tight",
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr07_repx075_meta001_twotime_fastx1_trunk05_notrunk_tight",
    } == set(module.PRESET_CONFIGS["readout_consistency_fasttrunk"])

    catalog = module.UPGD_CATALOG
    slow = catalog[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx05_notrunk_tight"
    ]
    base = catalog[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx1_notrunk_tight"
    ]
    fast = catalog[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx2_notrunk_tight"
    ]
    lr07 = catalog[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr07_repx075_meta001_twotime_fastx1_notrunk_tight"
    ]
    trunk05 = catalog[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx1_trunk05_notrunk_tight"
    ]
    trunk1 = catalog[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx2_trunk1_notrunk_tight"
    ]
    slow0 = catalog[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx2_trunk2_slow0_notrunk_tight"
    ]
    sepbound = catalog[
        "upgd64_64_structure_sigma1e_4_adaptk035_065_lr06_repx075_meta001_twotime_fastx2_trunk2_slow025_sepbound_notrunk_tight"
    ]

    assert base.readout_mode == "two_timescale_simplex"
    assert slow.readout_fast_head_step_size_multiplier == 0.5
    assert base.readout_fast_head_step_size_multiplier == 1.0
    assert fast.readout_fast_head_step_size_multiplier == 2.0
    assert lr07.step_size == module.STEP_SIZE * 0.7
    assert trunk05.readout_fast_trunk_gradient_multiplier == 0.5
    assert trunk1.readout_fast_head_step_size_multiplier == 2.0
    assert trunk1.readout_fast_trunk_gradient_multiplier == 1.0
    assert slow0.readout_slow_simplex_gradient_multiplier == 0.0
    assert sepbound.readout_fast_head_bounder_mode == "separate"
    assert sepbound.readout_slow_simplex_gradient_multiplier == 0.25

    serialized = module.config_to_json(fast)
    assert serialized["readout_mode"] == "two_timescale_simplex"
    assert serialized["readout_fast_head_step_size_multiplier"] == 2.0
    assert serialized["readout_fast_trunk_gradient_multiplier"] == 0.0
    assert serialized["readout_fast_head_bounder_mode"] == "shared"
    assert serialized["readout_slow_simplex_gradient_multiplier"] == 1.0
