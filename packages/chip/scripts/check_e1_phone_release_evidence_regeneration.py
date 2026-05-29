#!/usr/bin/env python3
"""Verify generated E1 phone readiness reports match the checked-in artifacts."""

from __future__ import annotations

import argparse
import datetime as _dt
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
PYTHON = sys.executable


@dataclass(frozen=True)
class OutputSpec:
    generated: Path
    committed: Path
    generator_command: tuple[str, ...]
    source_inputs: tuple[Path, ...] = ()


@dataclass(frozen=True)
class DriftFinding:
    code: str
    message: str
    spec: OutputSpec


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def display_path(path: Path) -> str:
    return rel(path) if path.is_relative_to(ROOT) else path.as_posix()


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
            f"{args[0]} exited {completed.returncode}" + (f": {output}" if output else "")
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
            f"{args[0]} exited {completed.returncode}" + (f": {output_text}" if output_text else "")
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


def compare_outputs(outputs: list[OutputSpec]) -> list[DriftFinding]:
    failures: list[DriftFinding] = []
    replacements = path_replacements(outputs)
    for spec in outputs:
        if not spec.committed.is_file():
            failures.append(
                DriftFinding(
                    code="missing_committed_report",
                    message=f"missing committed report: {rel(spec.committed)}",
                    spec=spec,
                )
            )
            continue
        if not spec.generated.is_file():
            failures.append(
                DriftFinding(
                    code="missing_regenerated_report",
                    message=f"missing regenerated report: {spec.generated}",
                    spec=spec,
                )
            )
            continue
        committed = normalize_text(spec.committed.read_text(encoding="utf-8"), replacements)
        generated = normalize_text(spec.generated.read_text(encoding="utf-8"), replacements)
        if spec.committed.suffix in {".yaml", ".yml"}:
            matches = compare_yaml(generated, committed)
        else:
            matches = generated == committed
        if not matches:
            failures.append(
                DriftFinding(
                    code="stale_generated_report",
                    message=f"stale generated report: {rel(spec.committed)}",
                    spec=spec,
                )
            )
    return failures


def display_token(token: str) -> str:
    if token.startswith(ROOT.as_posix() + "/"):
        return Path(token).relative_to(ROOT).as_posix()
    return token


def command_text(args: tuple[str, ...]) -> str:
    return " ".join(["python3", *(display_token(arg) for arg in args)])


def path_details(path: Path) -> dict[str, Any]:
    if not path.is_absolute():
        path = ROOT / path
    details: dict[str, Any] = {
        "path": display_path(path),
        "exists": path.exists(),
    }
    if path.exists():
        details["artifact_kind"] = "directory" if path.is_dir() else "file"
        details["mtime_ns"] = path.stat().st_mtime_ns
    else:
        details["artifact_kind"] = "missing"
    return details


def drift_report(failures: list[DriftFinding]) -> dict[str, Any]:
    status = "blocked_stale_generated_reports" if failures else "pass"
    return {
        "schema": "eliza.e1_phone_release_evidence_regeneration_drift.v1",
        "status": status,
        "release_credit": False,
        "generated_utc": _dt.datetime.now(_dt.UTC).isoformat(),
        "claim_boundary": (
            "Release-evidence regeneration drift diagnostic only. This report does "
            "not grant release credit or satisfy fabrication, supplier, routed "
            "board, factory, first-article, or mechanical evidence gates."
        ),
        "summary": {
            "finding_count": len(failures),
            "stale_generated_report_count": sum(
                1 for failure in failures if failure.code == "stale_generated_report"
            ),
            "missing_committed_report_count": sum(
                1 for failure in failures if failure.code == "missing_committed_report"
            ),
            "missing_regenerated_report_count": sum(
                1 for failure in failures if failure.code == "missing_regenerated_report"
            ),
        },
        "findings": [
            {
                "code": failure.code,
                "message": failure.message,
                "release_credit": False,
                "committed_report": rel(failure.spec.committed),
                "regenerated_report": display_path(failure.spec.generated),
                "generator_command": command_text(failure.spec.generator_command),
                "refresh_committed_command": (
                    "python3 scripts/check_e1_phone_release_evidence_regeneration.py "
                    "--write-committed"
                ),
                "source_inputs": [
                    path_details(source_input) for source_input in failure.spec.source_inputs
                ],
            }
            for failure in failures
        ],
    }


def write_drift_report(failures: list[DriftFinding], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(drift_report(failures), sort_keys=False),
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify or refresh generated E1 phone release-evidence reports."
    )
    parser.add_argument(
        "--write-committed",
        action="store_true",
        help="regenerate the checked-in reports in place before comparing them",
    )
    parser.add_argument(
        "--diagnostic-report",
        type=Path,
        default=ROOT / "build/reports/e1-phone-release-evidence-regeneration-drift.yaml",
        help="write structured drift diagnostics here when regenerated reports differ",
    )
    args = parser.parse_args()

    try:
        tmp_parent = ROOT / "build/e1-phone-release-evidence-regeneration"
        tmp_parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=tmp_parent) as tmp_text:
            tmp = Path(tmp_text)
            committed_route_inventory = (
                ROOT / "board/kicad/e1-phone/kicad-route-readiness-inventory-2026-05-22.yaml"
            )
            committed_supplier_yaml = (
                ROOT / "board/kicad/e1-phone/production/sourcing/readiness/"
                "supplier-return-evidence-acceptance-matrix-2026-05-22.yaml"
            )
            committed_routed_yaml = (
                ROOT / "board/kicad/e1-phone/production/readiness/"
                "routed-board-release-acceptance-matrix-2026-05-22.yaml"
            )
            committed_production_presence = (
                ROOT / "board/kicad/e1-phone/production/readiness/"
                "production-factory-required-output-presence-inventory-2026-05-22.yaml"
            )
            committed_first_article = (
                ROOT / "board/kicad/e1-phone/production/test/readiness/"
                "e1-phone-first-article-bench-acceptance-matrix-2026-05-22.yaml"
            )
            committed_first_article_missing = (
                ROOT / "board/kicad/e1-phone/production/test/readiness/"
                "e1-phone-first-article-missing-evidence-2026-05-22.yaml"
            )
            committed_first_article_executed_log_contract = (
                ROOT / "board/kicad/e1-phone/production/test/readiness/"
                "e1-phone-first-article-executed-log-contract-2026-05-22.yaml"
            )
            committed_mechanical_cad = (
                ROOT
                / "mechanical/e1-phone/review/mechanical-cad-evidence-inventory-2026-05-22.yaml"
            )
            committed_objective_audit = (
                ROOT / "board/kicad/e1-phone/e1-phone-objective-completion-audit-2026-05-22.yaml"
            )
            committed_unblock_register = (
                ROOT / "board/kicad/e1-phone/e1-phone-readiness-unblock-register-2026-05-22.yaml"
            )
            committed_content_contract = (
                ROOT / "board/kicad/e1-phone/production/readiness/"
                "release-evidence-content-contract-2026-05-22.yaml"
            )
            committed_validation_dry_run = (
                ROOT / "board/kicad/e1-phone/production/readiness/"
                "release-evidence-validation-dry-run-2026-05-22.yaml"
            )
            committed_release_gate = (
                ROOT / "board/kicad/e1-phone/production/readiness/"
                "fabrication-enclosure-e2e-release-gate-2026-05-22.yaml"
            )
            first_article = tmp / "e1-phone-first-article-bench-acceptance-matrix-2026-05-22.yaml"
            mechanical_cad = tmp / "mechanical-cad-evidence-inventory-2026-05-22.yaml"
            objective_audit = tmp / "e1-phone-objective-completion-audit-2026-05-22.yaml"
            unblock_register = tmp / "e1-phone-readiness-unblock-register-2026-05-22.yaml"
            content_contract = tmp / "release-evidence-content-contract-2026-05-22.yaml"
            validation_dry_run = tmp / "release-evidence-validation-dry-run-2026-05-22.yaml"
            release_gate = tmp / "fabrication-enclosure-e2e-release-gate-2026-05-22.yaml"

            if args.write_committed:
                route_inventory = committed_route_inventory
                supplier_yaml = committed_supplier_yaml
                routed_yaml = committed_routed_yaml
                production_presence = committed_production_presence
                first_article = committed_first_article
                first_article_missing = committed_first_article_missing
                first_article_executed_log_contract = committed_first_article_executed_log_contract
                mechanical_cad = committed_mechanical_cad
                objective_audit = committed_objective_audit
                unblock_register = committed_unblock_register
                content_contract = committed_content_contract
                validation_dry_run = committed_validation_dry_run
                release_gate = committed_release_gate
            else:
                route_inventory = tmp / "kicad-route-readiness-inventory-2026-05-22.yaml"
                supplier_yaml = tmp / "supplier-return-evidence-acceptance-matrix-2026-05-22.yaml"
                routed_yaml = tmp / "routed-board-release-acceptance-matrix-2026-05-22.yaml"
                production_presence = (
                    tmp / "production-factory-required-output-presence-inventory-2026-05-22.yaml"
                )
                first_article = (
                    tmp / "e1-phone-first-article-bench-acceptance-matrix-2026-05-22.yaml"
                )
                first_article_missing = (
                    tmp / "e1-phone-first-article-missing-evidence-2026-05-22.yaml"
                )
                first_article_executed_log_contract = (
                    tmp / "e1-phone-first-article-executed-log-contract-2026-05-22.yaml"
                )
                mechanical_cad = tmp / "mechanical-cad-evidence-inventory-2026-05-22.yaml"
                objective_audit = tmp / "e1-phone-objective-completion-audit-2026-05-22.yaml"
                unblock_register = tmp / "e1-phone-readiness-unblock-register-2026-05-22.yaml"
                content_contract = tmp / "release-evidence-content-contract-2026-05-22.yaml"
                validation_dry_run = tmp / "release-evidence-validation-dry-run-2026-05-22.yaml"
                release_gate = tmp / "fabrication-enclosure-e2e-release-gate-2026-05-22.yaml"

            supplier_md = supplier_yaml.with_suffix(".md")
            routed_md = routed_yaml.with_suffix(".md")

            route_inventory_command = (
                "scripts/e1_phone_kicad_route_inventory.py",
                "--report",
                str(route_inventory),
                "--write-report",
            )
            supplier_command = (
                "scripts/generate_e1_phone_supplier_return_evidence_acceptance_matrix.py",
                "--report",
                str(supplier_yaml),
                "--markdown-report",
                str(supplier_md),
                "--write-report",
            )
            routed_command = (
                "scripts/e1_phone_routed_board_release_acceptance_matrix.py",
                "--route-inventory",
                str(route_inventory),
                "--yaml-report",
                str(routed_yaml),
                "--md-report",
                str(routed_md),
                "--write-report",
            )
            production_presence_command = (
                "scripts/e1_phone_production_factory_output_presence_inventory.py",
                "--report",
                str(production_presence),
                "--write-report",
            )
            first_article_command = (
                "scripts/e1_phone_first_article_bench_acceptance_matrix.py",
                "--report",
                str(first_article),
                "--write-report",
            )
            first_article_missing_command = (
                "scripts/e1_phone_first_article_missing_evidence_diagnostic.py",
                "--matrix",
                str(first_article),
                "--report",
                str(first_article_missing),
                "--write-report",
            )
            first_article_log_contract_command = (
                "scripts/e1_phone_first_article_executed_log_contract.py",
                "--matrix",
                str(first_article),
                "--diagnostic",
                str(first_article_missing),
                "--report",
                str(first_article_executed_log_contract),
                "--write-report",
            )
            mechanical_cad_command = (
                "scripts/e1_phone_mechanical_cad_evidence_inventory.py",
                "--write",
                "--output",
                str(mechanical_cad),
            )
            objective_audit_command = ("scripts/e1_phone_objective_completion_audit.py",)
            unblock_register_command = ("scripts/e1_phone_readiness_unblock_register.py",)
            content_contract_command = (
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
            )
            validation_dry_run_command = (
                "scripts/e1_phone_release_evidence_validation_dry_run.py",
                "--contract",
                str(content_contract),
                "--report",
                str(validation_dry_run),
                "--write-report",
            )
            release_gate_command = (
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
            )

            run_generator(list(route_inventory_command))
            run_generator(list(supplier_command))
            run_generator(list(routed_command))
            run_generator(list(production_presence_command))
            run_generator(list(first_article_command))
            run_generator(list(first_article_missing_command))
            run_generator(list(first_article_log_contract_command))
            run_generator(list(mechanical_cad_command))
            write_stdout(list(objective_audit_command), objective_audit)
            write_stdout(list(unblock_register_command), unblock_register)
            run_generator(list(content_contract_command))
            run_generator(list(validation_dry_run_command))
            run_generator(list(release_gate_command))

            route_inventory_sources = (
                ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb",
                ROOT / "board/kicad/e1-phone/routed-layout-si-drc-burndown-2026-05-22.yaml",
                ROOT / "board/kicad/e1-phone/routed-development-board-intake-2026-05-22.yaml",
                ROOT
                / "board/kicad/e1-phone/real-footprint-development-board-binding-2026-05-22.yaml",
            )
            supplier_sources = (
                ROOT / "board/kicad/e1-phone/production/sourcing/"
                "supplier-evidence-outbound-intake-manifest-2026-05-22.yaml",
                ROOT / "board/kicad/e1-phone/supplier-evidence-drawing-gap-map-2026-05-22.yaml",
            )
            routed_sources = (
                committed_route_inventory,
                ROOT / "board/kicad/e1-phone/routed-layout-si-drc-burndown-2026-05-22.yaml",
                ROOT / "board/kicad/e1-phone/routed-release-plan.yaml",
                ROOT
                / "board/kicad/e1-phone/production/routed-output-candidate-manifest-2026-05-22.yaml",
                ROOT / "board/kicad/e1-phone/production/step/component-3d-model-manifest.yaml",
                ROOT / "board/kicad/e1-phone/production/step/component-models",
            )
            production_presence_sources = (
                ROOT / "board/kicad/e1-phone/production-factory-output-burndown-2026-05-22.yaml",
                ROOT
                / "board/kicad/e1-phone/production/factory-output-candidate-manifest-2026-05-22.yaml",
                ROOT / "board/kicad/e1-phone/manufacturing-closure.yaml",
            )
            first_article_sources = (
                ROOT / "board/kicad/e1-phone/production/test/"
                "bench-first-article-template-manifest-2026-05-22.yaml",
                ROOT / "board/kicad/e1-phone/selected-hardware-first-article-execution.yaml",
                ROOT
                / "board/kicad/e1-phone/production-enclosure-first-article-release-execution.yaml",
                ROOT / "board/kicad/e1-phone/production-factory-output-burndown-2026-05-22.yaml",
            )
            mechanical_sources = (
                ROOT / "mechanical/e1-phone/review/board-step-readiness.json",
                ROOT / "mechanical/e1-phone/review/routed-board-clearance.json",
                ROOT / "board/kicad/e1-phone/enclosure-mechanical-release-burndown-2026-05-22.yaml",
            )
            objective_audit_sources = (
                ROOT / "board/kicad/e1-phone/artifact-manifest.yaml",
                committed_route_inventory,
                ROOT / "board/kicad/e1-phone/production/sourcing/"
                "supplier-evidence-outbound-intake-manifest-2026-05-22.yaml",
                ROOT / "board/kicad/e1-phone/production-factory-output-burndown-2026-05-22.yaml",
                ROOT / "board/kicad/e1-phone/production/readiness/"
                "production-factory-required-output-presence-inventory-2026-05-22.yaml",
                ROOT / "board/kicad/e1-phone/enclosure-mechanical-release-burndown-2026-05-22.yaml",
                ROOT / "board/kicad/e1-phone/production/test/"
                "bench-first-article-template-manifest-2026-05-22.yaml",
                ROOT / "mechanical/e1-phone/review/board-step-readiness.json",
                ROOT / "mechanical/e1-phone/review/cad-connection-coverage.json",
                ROOT
                / "board/kicad/e1-phone/production/routed-output-candidate-manifest-2026-05-22.yaml",
            )
            unblock_register_sources = (
                committed_objective_audit,
                committed_route_inventory,
                ROOT / "board/kicad/e1-phone/production/sourcing/"
                "supplier-evidence-outbound-intake-manifest-2026-05-22.yaml",
                committed_production_presence,
                ROOT / "board/kicad/e1-phone/enclosure-mechanical-release-burndown-2026-05-22.yaml",
                ROOT / "board/kicad/e1-phone/production/test/"
                "bench-first-article-template-manifest-2026-05-22.yaml",
            )
            content_contract_sources = (
                committed_supplier_yaml,
                committed_routed_yaml,
                committed_first_article,
                committed_production_presence,
                committed_mechanical_cad,
                ROOT / "board/kicad/e1-phone/kicad-cad-traceability-matrix-2026-05-22.yaml",
                ROOT
                / "board/kicad/e1-phone/production/routed-output-candidate-manifest-2026-05-22.yaml",
                ROOT
                / "board/kicad/e1-phone/production/factory-output-candidate-manifest-2026-05-22.yaml",
            )
            release_gate_sources = (
                committed_content_contract,
                committed_validation_dry_run,
                committed_routed_yaml,
                committed_first_article,
                committed_production_presence,
                committed_mechanical_cad,
                ROOT / "board/kicad/e1-phone/end-to-end-readiness.yaml",
                committed_objective_audit,
                ROOT / "mechanical/e1-phone/review/board-step-readiness.json",
                ROOT / "mechanical/e1-phone/review/routed-board-clearance.json",
            )

            outputs = [
                OutputSpec(
                    route_inventory,
                    committed_route_inventory,
                    route_inventory_command,
                    route_inventory_sources,
                ),
                OutputSpec(
                    supplier_yaml,
                    committed_supplier_yaml,
                    supplier_command,
                    supplier_sources,
                ),
                OutputSpec(
                    supplier_md,
                    ROOT / "board/kicad/e1-phone/production/sourcing/readiness/"
                    "supplier-return-evidence-acceptance-matrix-2026-05-22.md",
                    supplier_command,
                    supplier_sources,
                ),
                OutputSpec(
                    routed_yaml,
                    committed_routed_yaml,
                    routed_command,
                    routed_sources,
                ),
                OutputSpec(
                    routed_md,
                    ROOT / "board/kicad/e1-phone/production/readiness/"
                    "routed-board-release-acceptance-matrix-2026-05-22.md",
                    routed_command,
                    routed_sources,
                ),
                OutputSpec(
                    production_presence,
                    committed_production_presence,
                    production_presence_command,
                    production_presence_sources,
                ),
                OutputSpec(
                    first_article,
                    committed_first_article,
                    first_article_command,
                    first_article_sources,
                ),
                OutputSpec(
                    first_article_missing,
                    committed_first_article_missing,
                    first_article_missing_command,
                    (first_article,),
                ),
                OutputSpec(
                    first_article_executed_log_contract,
                    committed_first_article_executed_log_contract,
                    first_article_log_contract_command,
                    (first_article, first_article_missing),
                ),
                OutputSpec(
                    mechanical_cad,
                    committed_mechanical_cad,
                    mechanical_cad_command,
                    mechanical_sources,
                ),
                OutputSpec(
                    objective_audit,
                    committed_objective_audit,
                    objective_audit_command,
                    objective_audit_sources,
                ),
                OutputSpec(
                    unblock_register,
                    committed_unblock_register,
                    unblock_register_command,
                    unblock_register_sources,
                ),
                OutputSpec(
                    content_contract,
                    committed_content_contract,
                    content_contract_command,
                    content_contract_sources,
                ),
                OutputSpec(
                    validation_dry_run,
                    committed_validation_dry_run,
                    validation_dry_run_command,
                    (content_contract,),
                ),
                OutputSpec(
                    release_gate,
                    committed_release_gate,
                    release_gate_command,
                    release_gate_sources,
                ),
            ]
            failures = compare_outputs(outputs)
    except RuntimeError as exc:
        print(f"FAIL: E1 phone release evidence regeneration failed: {exc}")
        return 1

    if failures:
        print("STATUS: BLOCKED E1 phone release evidence regeneration drift detected")
        for failure in failures:
            print(f"  - {failure.message}")
            print("    release_credit: false")
            print(f"    generator_command: {command_text(failure.spec.generator_command)}")
            source_inputs = [
                path_details(source_input)["path"] for source_input in failure.spec.source_inputs
            ]
            print(
                "    source_inputs: "
                + (", ".join(source_inputs) if source_inputs else "(none declared)")
            )
        write_drift_report(failures, args.diagnostic_report)
        print(f"  diagnostic_report: {display_path(args.diagnostic_report)}")
        return 2
    write_drift_report([], args.diagnostic_report)
    print(f"STATUS: PASS E1 phone release evidence regeneration ({len(outputs)} reports)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
