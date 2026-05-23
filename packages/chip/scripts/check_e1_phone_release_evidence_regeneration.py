#!/usr/bin/env python3
"""Verify generated E1 phone readiness reports match the checked-in artifacts."""

from __future__ import annotations

import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
PYTHON = sys.executable


@dataclass(frozen=True)
class OutputSpec:
    generated: Path
    committed: Path


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def run_generator(args: list[str]) -> None:
    completed = subprocess.run(
        [PYTHON, *args],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if completed.returncode != 0:
        output = (completed.stdout or "").strip()
        raise RuntimeError(
            f"{args[0]} exited {completed.returncode}"
            + (f": {output}" if output else "")
        )


def write_stdout(args: list[str], output: Path) -> None:
    completed = subprocess.run(
        [PYTHON, *args],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if completed.returncode != 0:
        output_text = (completed.stdout or "").strip()
        raise RuntimeError(
            f"{args[0]} exited {completed.returncode}"
            + (f": {output_text}" if output_text else "")
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(completed.stdout, encoding="utf-8")


def path_replacements(outputs: list[OutputSpec]) -> dict[str, str]:
    replacements: dict[str, str] = {}
    for spec in outputs:
        generated_rel = rel(spec.generated)
        committed_rel = rel(spec.committed)
        replacements[generated_rel] = committed_rel
        replacements[spec.generated.as_posix()] = spec.committed.as_posix()
    return replacements


def normalize_text(text: str, replacements: dict[str, str]) -> str:
    normalized = text
    for old, new in sorted(replacements.items(), key=lambda item: len(item[0]), reverse=True):
        normalized = normalized.replace(old, new)
    return normalized


def compare_yaml(generated: str, committed: str) -> bool:
    return yaml.safe_load(generated) == yaml.safe_load(committed)


def compare_outputs(outputs: list[OutputSpec]) -> list[str]:
    failures: list[str] = []
    replacements = path_replacements(outputs)
    for spec in outputs:
        if not spec.committed.is_file():
            failures.append(f"missing committed report: {rel(spec.committed)}")
            continue
        if not spec.generated.is_file():
            failures.append(f"missing regenerated report: {spec.generated}")
            continue
        committed = normalize_text(spec.committed.read_text(encoding="utf-8"), replacements)
        generated = normalize_text(spec.generated.read_text(encoding="utf-8"), replacements)
        if spec.committed.suffix in {".yaml", ".yml"}:
            matches = compare_yaml(generated, committed)
        else:
            matches = generated == committed
        if not matches:
            failures.append(f"stale generated report: {rel(spec.committed)}")
    return failures


def main() -> int:
    try:
        tmp_parent = ROOT / "build/e1-phone-release-evidence-regeneration"
        tmp_parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=tmp_parent) as tmp_text:
            tmp = Path(tmp_text)
            route_inventory = tmp / "kicad-route-readiness-inventory-2026-05-22.yaml"
            supplier_yaml = tmp / "supplier-return-evidence-acceptance-matrix-2026-05-22.yaml"
            supplier_md = supplier_yaml.with_suffix(".md")
            routed_yaml = tmp / "routed-board-release-acceptance-matrix-2026-05-22.yaml"
            routed_md = routed_yaml.with_suffix(".md")
            production_presence = (
                tmp / "production-factory-required-output-presence-inventory-2026-05-22.yaml"
            )
            first_article = (
                tmp / "e1-phone-first-article-bench-acceptance-matrix-2026-05-22.yaml"
            )
            mechanical_cad = tmp / "mechanical-cad-evidence-inventory-2026-05-22.yaml"
            objective_audit = tmp / "e1-phone-objective-completion-audit-2026-05-22.yaml"
            unblock_register = tmp / "e1-phone-readiness-unblock-register-2026-05-22.yaml"
            content_contract = tmp / "release-evidence-content-contract-2026-05-22.yaml"
            validation_dry_run = tmp / "release-evidence-validation-dry-run-2026-05-22.yaml"
            release_gate = tmp / "fabrication-enclosure-e2e-release-gate-2026-05-22.yaml"

            run_generator(
                [
                    "scripts/e1_phone_kicad_route_inventory.py",
                    "--report",
                    str(route_inventory),
                    "--write-report",
                ]
            )
            run_generator(
                [
                    "scripts/generate_e1_phone_supplier_return_evidence_acceptance_matrix.py",
                    "--report",
                    str(supplier_yaml),
                    "--markdown-report",
                    str(supplier_md),
                    "--write-report",
                ]
            )
            run_generator(
                [
                    "scripts/e1_phone_routed_board_release_acceptance_matrix.py",
                    "--route-inventory",
                    str(route_inventory),
                    "--yaml-report",
                    str(routed_yaml),
                    "--md-report",
                    str(routed_md),
                    "--write-report",
                ]
            )
            run_generator(
                [
                    "scripts/e1_phone_production_factory_output_presence_inventory.py",
                    "--report",
                    str(production_presence),
                    "--write-report",
                ]
            )
            run_generator(
                [
                    "scripts/e1_phone_first_article_bench_acceptance_matrix.py",
                    "--report",
                    str(first_article),
                    "--write-report",
                ]
            )
            run_generator(
                [
                    "scripts/e1_phone_mechanical_cad_evidence_inventory.py",
                    "--write",
                    "--output",
                    str(mechanical_cad),
                ]
            )
            write_stdout(
                ["scripts/e1_phone_objective_completion_audit.py"],
                objective_audit,
            )
            write_stdout(
                ["scripts/e1_phone_readiness_unblock_register.py"],
                unblock_register,
            )
            run_generator(
                [
                    "scripts/e1_phone_release_evidence_content_contract.py",
                    "--supplier-matrix",
                    str(supplier_yaml),
                    "--routed-matrix",
                    str(routed_yaml),
                    "--first-article-matrix",
                    str(first_article),
                    "--production-presence",
                    str(production_presence),
                    "--mechanical-cad",
                    str(mechanical_cad),
                    "--report",
                    str(content_contract),
                    "--write-report",
                ]
            )
            run_generator(
                [
                    "scripts/e1_phone_release_evidence_validation_dry_run.py",
                    "--contract",
                    str(content_contract),
                    "--report",
                    str(validation_dry_run),
                    "--write-report",
                ]
            )
            run_generator(
                [
                    "scripts/e1_phone_fabrication_enclosure_e2e_release_gate.py",
                    "--content-contract",
                    str(content_contract),
                    "--validation-dry-run",
                    str(validation_dry_run),
                    "--routed-matrix",
                    str(routed_yaml),
                    "--first-article-matrix",
                    str(first_article),
                    "--production-presence",
                    str(production_presence),
                    "--mechanical-cad",
                    str(mechanical_cad),
                    "--objective-audit",
                    str(objective_audit),
                    "--report",
                    str(release_gate),
                    "--write-report",
                ]
            )

            outputs = [
                OutputSpec(
                    route_inventory,
                    ROOT
                    / "board/kicad/e1-phone/kicad-route-readiness-inventory-2026-05-22.yaml",
                ),
                OutputSpec(
                    supplier_yaml,
                    ROOT
                    / "board/kicad/e1-phone/production/sourcing/readiness/"
                    "supplier-return-evidence-acceptance-matrix-2026-05-22.yaml",
                ),
                OutputSpec(
                    supplier_md,
                    ROOT
                    / "board/kicad/e1-phone/production/sourcing/readiness/"
                    "supplier-return-evidence-acceptance-matrix-2026-05-22.md",
                ),
                OutputSpec(
                    routed_yaml,
                    ROOT
                    / "board/kicad/e1-phone/production/readiness/"
                    "routed-board-release-acceptance-matrix-2026-05-22.yaml",
                ),
                OutputSpec(
                    routed_md,
                    ROOT
                    / "board/kicad/e1-phone/production/readiness/"
                    "routed-board-release-acceptance-matrix-2026-05-22.md",
                ),
                OutputSpec(
                    production_presence,
                    ROOT
                    / "board/kicad/e1-phone/production/readiness/"
                    "production-factory-required-output-presence-inventory-2026-05-22.yaml",
                ),
                OutputSpec(
                    first_article,
                    ROOT
                    / "board/kicad/e1-phone/production/test/readiness/"
                    "e1-phone-first-article-bench-acceptance-matrix-2026-05-22.yaml",
                ),
                OutputSpec(
                    mechanical_cad,
                    ROOT / "mechanical/e1-phone/review/mechanical-cad-evidence-inventory-2026-05-22.yaml",
                ),
                OutputSpec(
                    objective_audit,
                    ROOT / "board/kicad/e1-phone/e1-phone-objective-completion-audit-2026-05-22.yaml",
                ),
                OutputSpec(
                    unblock_register,
                    ROOT / "board/kicad/e1-phone/e1-phone-readiness-unblock-register-2026-05-22.yaml",
                ),
                OutputSpec(
                    content_contract,
                    ROOT
                    / "board/kicad/e1-phone/production/readiness/"
                    "release-evidence-content-contract-2026-05-22.yaml",
                ),
                OutputSpec(
                    validation_dry_run,
                    ROOT
                    / "board/kicad/e1-phone/production/readiness/"
                    "release-evidence-validation-dry-run-2026-05-22.yaml",
                ),
                OutputSpec(
                    release_gate,
                    ROOT
                    / "board/kicad/e1-phone/production/readiness/"
                    "fabrication-enclosure-e2e-release-gate-2026-05-22.yaml",
                ),
            ]
            failures = compare_outputs(outputs)
    except RuntimeError as exc:
        print(f"FAIL: E1 phone release evidence regeneration failed: {exc}")
        return 1

    if failures:
        print("FAIL: E1 phone release evidence regeneration drift detected")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print(f"STATUS: PASS E1 phone release evidence regeneration ({len(outputs)} reports)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
