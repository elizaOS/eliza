"""Evidence-gate tests for Step 2 completion claims."""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from types import ModuleType
from typing import Any, cast

from conftest import load_script

REPO_ROOT = Path(__file__).resolve().parents[1]
CRITERIA_PATH = REPO_ROOT / "docs" / "research" / "step2_completion_criteria.md"
_SCRIPT_PATH = REPO_ROOT / "benchmarks" / "step2_associative_opmnist_confirmation.py"


def load_criteria() -> dict[str, Any]:
    """Load the machine-readable JSON block from the criteria note."""
    text = CRITERIA_PATH.read_text()
    match = re.search(r"```json\n(?P<payload>.*?)\n```", text, flags=re.DOTALL)
    assert match is not None
    return cast(dict[str, Any], json.loads(match.group("payload")))


def load_opmnist_module() -> ModuleType:
    return load_script(_SCRIPT_PATH, "step2_associative_opmnist_confirmation_completion")


def claim_supported(theorem_gate: dict[str, Any], claim: str) -> bool:
    """Return whether a theorem claim is positively supported."""
    return claim in set(theorem_gate["passing_claims"])


def rejected_claim_has_formal_replacement(theorem_gate: dict[str, Any], claim: str) -> bool:
    """Return whether a rejected stronger claim has a formal replacement boundary."""
    return bool(
        claim in set(theorem_gate["rejected_claims"])
        and theorem_gate.get("replacement_theorem")
        and theorem_gate.get("impossibility_references")
    )


def full_published_payload(module: ModuleType) -> dict[str, Any]:
    """Construct a full-scale payload fixture without running 48M updates."""
    args = module.parse_args(
        [
            "--scale",
            "full",
            "--allow-published-scale",
            "--allow-openml-download",
            "--mnist-source",
            "openml",
            "--evaluate-all-permutation-views",
        ]
    )
    dataset_meta = {
        "source": "openml",
        "source_kind": "openml_mnist_784",
        "fallback_used": False,
        "is_true_mnist": True,
        "is_full_mnist_split": True,
        "feature_dim": 784,
        "n_classes": module.N_CLASSES,
        "n_train": module.DOHARE_OPMNIST_TASK_BLOCK_SIZE,
        "n_test": 10_000,
        "train_fraction": "canonical_60000_10000",
    }
    observed = module.observed_task_ids_for_steps(
        steps=args.steps,
        task_block_size=args.task_block_size,
        n_permutations=args.n_permutations,
    )
    test_ids = module.test_task_ids_for_protocol(args, observed)
    protocol = module.protocol_metadata(
        args,
        dataset_meta,
        completed_steps=module.DOHARE_OPMNIST_TOTAL_STEPS,
        observed_task_ids=observed,
        test_task_ids=test_ids,
    )
    guard = module.published_scale_guard(args)
    status = module.benchmark_status(
        args=args,
        dataset_meta=dataset_meta,
        protocol=protocol,
        completed_steps=module.DOHARE_OPMNIST_TOTAL_STEPS,
    )
    manifest = module.build_manifest(
        args=args,
        argv=[
            "--scale",
            "full",
            "--allow-published-scale",
            "--mnist-source",
            "openml",
            "--evaluate-all-permutation-views",
        ],
        dataset_meta=dataset_meta,
        protocol=protocol,
        guard=guard,
    )
    records = [
        {"seed": int(seed), "steps": module.DOHARE_OPMNIST_TOTAL_STEPS}
        for seed in args.seed_list
    ]
    return {
        "schema": "alberta.step2.associative_opmnist.results.v1",
        "dry_run": False,
        "manifest": manifest,
        "datasets": {"permuted_mnist_like": dataset_meta},
        "protocol": protocol,
        "published_scale_guard": guard,
        "records": records,
        "aggregate": {"permuted_mnist_like": {}},
        "status": status,
    }


def test_completion_criteria_define_separate_evidence_gates() -> None:
    criteria = load_criteria()
    gates = criteria["evidence_gates"]

    assert criteria["schema"] == "alberta.step2.completion_criteria.v1"
    assert criteria["overall_100000_percent_complete"] is False
    assert set(gates) == {
        "theorem_complete",
        "implementation_complete",
        "smoke_confirmed",
        "external_confirmed",
        "published_scale_confirmed",
    }
    assert gates["theorem_complete"]["passes"] is True
    assert gates["implementation_complete"]["passes"] is True
    assert gates["smoke_confirmed"]["passes"] is True
    assert gates["external_confirmed"]["passes"] is True
    assert gates["published_scale_confirmed"]["passes"] is True


def test_published_scale_gate_points_to_single_seed_opmnist_evidence() -> None:
    published_gate = load_criteria()["evidence_gates"]["published_scale_confirmed"]

    assert published_gate["passes"] is True
    assert published_gate["status"] == "single_seed_published_scale_protocol_pass"
    assert "one configured seed" in set(published_gate["limitations"])
    for evidence_path in published_gate["evidence"]:
        assert (REPO_ROOT / evidence_path).exists()


def test_theorem_gate_passes_only_scoped_finite_resource_claims() -> None:
    theorem_gate = load_criteria()["evidence_gates"]["theorem_complete"]

    assert claim_supported(theorem_gate, "finite_resource_causal")
    assert claim_supported(theorem_gate, "finite_generated_class")
    assert not claim_supported(theorem_gate, "arbitrary_recursive_universality")
    assert not claim_supported(theorem_gate, "distribution_free_universality")
    assert rejected_claim_has_formal_replacement(
        theorem_gate,
        "arbitrary_recursive_universality",
    )
    assert rejected_claim_has_formal_replacement(
        theorem_gate,
        "distribution_free_universality",
    )
    assert (
        theorem_gate["replacement_theorem"]
        == "docs/research/step2_upgd_recursive_feature_discovery_theory.md"
    )
    assert set(theorem_gate["impossibility_references"]) >= {
        "docs/research/step2_distribution_free_limits.md",
        "docs/research/step2_associative_memory_theory.md",
        "docs/research/step2_compositional_no_regret.md",
    }


def test_unproved_universal_claims_fail_without_replacement_theorem() -> None:
    theorem_gate = copy.deepcopy(load_criteria()["evidence_gates"]["theorem_complete"])
    theorem_gate["replacement_theorem"] = ""
    theorem_gate["impossibility_references"] = []

    assert not claim_supported(theorem_gate, "arbitrary_recursive_universality")
    assert not claim_supported(theorem_gate, "distribution_free_universality")
    assert not rejected_claim_has_formal_replacement(
        theorem_gate,
        "arbitrary_recursive_universality",
    )
    assert not rejected_claim_has_formal_replacement(
        theorem_gate,
        "distribution_free_universality",
    )


def test_published_scale_gate_passes_only_full_guarded_manifest() -> None:
    module = load_opmnist_module()
    payload = full_published_payload(module)

    status = module.published_scale_completion_status(payload)

    assert status["published_scale_confirmed"] is True
    assert status["full_guarded_manifest"] is True
    assert status["manifest_consistent"] is True
    assert status["records_complete"] is True


def test_forged_or_partial_opmnist_status_cannot_pass_published_scale_gate() -> None:
    module = load_opmnist_module()
    valid_payload = full_published_payload(module)

    forged_status_only = {
        "schema": "alberta.step2.associative_opmnist.results.v1",
        "dry_run": False,
        "status": valid_payload["status"],
    }
    dry_run_payload = copy.deepcopy(valid_payload)
    dry_run_payload["dry_run"] = True
    short_payload = copy.deepcopy(valid_payload)
    short_payload["protocol"]["completed_steps"] = module.DOHARE_OPMNIST_TASK_BLOCK_SIZE
    short_payload["manifest"]["protocol"] = short_payload["protocol"]
    short_payload["records"][0]["steps"] = module.DOHARE_OPMNIST_TASK_BLOCK_SIZE
    synthetic_payload = copy.deepcopy(valid_payload)
    synthetic_payload["datasets"]["permuted_mnist_like"]["is_true_mnist"] = False
    synthetic_payload["manifest"]["dataset"] = synthetic_payload["datasets"][
        "permuted_mnist_like"
    ]

    assert (
        module.published_scale_completion_status(forged_status_only)[
            "published_scale_confirmed"
        ]
        is False
    )
    assert (
        module.published_scale_completion_status(dry_run_payload)[
            "published_scale_confirmed"
        ]
        is False
    )
    assert (
        module.published_scale_completion_status(short_payload)["published_scale_confirmed"]
        is False
    )
    assert (
        module.published_scale_completion_status(synthetic_payload)[
            "published_scale_confirmed"
        ]
        is False
    )
