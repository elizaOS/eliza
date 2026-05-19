#!/usr/bin/env python3
"""Fail-closed checks for the selected Chipyard/Rocket CPU/AP path."""

from __future__ import annotations

import argparse
from pathlib import Path

from cpu_ap_evidence_lib import (
    artifact_specs,
    load_evidence_manifest,
    load_json,
    reject_duplicate_json_keys,
    text_problems,
    transcript_specs,
    validate_path_kind,
    validate_sha256,
)

ROOT = Path(__file__).resolve().parents[1]
SELECTED = ROOT / "docs/generators/chipyard/eliza-rocket-manifest.json"
TEMPLATE = ROOT / "docs/generators/chipyard/import-manifest.template.json"
BUILD_MANIFEST = ROOT / "build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json"


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def check_import_template(errors: list[str]) -> None:
    reject_duplicate_json_keys(TEMPLATE, errors)
    if not TEMPLATE.is_file() or errors:
        return
    manifest = load_json(TEMPLATE)
    chipyard = manifest.get("chipyard", {})
    require(
        manifest.get("schema") == "eliza.cpu_ap_import_manifest.v1",
        "unexpected import manifest template schema",
        errors,
    )
    require(manifest.get("status") == "template", "import manifest template status drifted", errors)
    if not isinstance(chipyard, dict):
        errors.append("import manifest template chipyard section must be an object")
        return
    require(
        chipyard.get("commit") == "69eba860a352343e4ac6b6df0f3638a79a86ec78",
        "import manifest template must keep the full pinned Chipyard commit",
        errors,
    )


def check_selected_manifest(errors: list[str]) -> None:
    require(SELECTED.is_file(), f"missing selected generator manifest: {SELECTED}", errors)
    require(TEMPLATE.is_file(), f"missing import manifest template: {TEMPLATE}", errors)
    if errors:
        return

    reject_duplicate_json_keys(SELECTED, errors)
    check_import_template(errors)
    if errors:
        return

    manifest = load_json(SELECTED)
    selected = manifest.get("selected_path", {})
    policy = manifest.get("claim_policy", {})

    require(
        manifest.get("schema") == "eliza.cpu_ap_generator_manifest.v1",
        "unexpected selected manifest schema",
        errors,
    )
    require(
        manifest.get("status") == "selected_not_generated",
        "selected manifest must remain selected_not_generated until artifacts exist",
        errors,
    )
    require(selected.get("generator") == "Chipyard", "selected generator must be Chipyard", errors)
    require(selected.get("chipyard_tag") == "1.13.0", "Chipyard tag must stay pinned", errors)
    require(
        selected.get("chipyard_release_commit") == "69eba86",
        "Chipyard release commit must stay pinned",
        errors,
    )
    require(selected.get("core") == "Rocket", "selected CPU core must be Rocket", errors)
    require(selected.get("isa") == "RV64GC", "selected CPU ISA must be RV64GC", errors)
    require(
        selected.get("harts") == 1,
        "initial AP integration must be single-hart until boot evidence exists",
        errors,
    )
    require(
        selected.get("config_name") == "ElizaRocketConfig",
        "config name must be ElizaRocketConfig",
        errors,
    )
    require(
        policy.get("linux_capable_cpu_claim") is False,
        "Linux CPU claim must be false without boot evidence",
        errors,
    )
    require(
        policy.get("platform_contract_has_cpu_may_flip_to_true") is False,
        "platform has_cpu flip must remain blocked without generated artifacts",
        errors,
    )

    for path in (
        "build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json",
        "build/chipyard/eliza_rocket/eliza-e1.dts",
        "build/chipyard/eliza_rocket/eliza_rocket_ap.v",
        "build/chipyard/eliza_rocket/simulator",
    ):
        require(
            path in manifest.get("expected_generated_artifacts", []),
            f"selected manifest lacks generated artifact: {path}",
            errors,
        )

    evidence_errors: list[str] = []
    evidence_manifest = load_evidence_manifest(evidence_errors)
    errors.extend(evidence_errors)
    for spec in transcript_specs(evidence_manifest).values():
        path = spec.get("path")
        if not isinstance(path, str):
            errors.append(f"CPU/AP evidence manifest contains invalid evidence path: {path!r}")
            continue
        require(
            path in manifest.get("required_evidence", []),
            f"selected manifest lacks evidence artifact: {path}",
            errors,
        )


def check_generated_import_manifest(errors: list[str]) -> None:
    require(
        BUILD_MANIFEST.is_file(), f"missing generated import manifest: {BUILD_MANIFEST}", errors
    )
    if errors:
        return

    reject_duplicate_json_keys(BUILD_MANIFEST, errors)
    if errors:
        return

    manifest = load_json(BUILD_MANIFEST)
    chipyard = manifest.get("chipyard", {})
    generation = manifest.get("generation", {})
    artifacts = manifest.get("artifacts", {})
    evidence = manifest.get("evidence", {})
    artifact_hashes = manifest.get("artifact_sha256", {})
    evidence_hashes = manifest.get("evidence_sha256", {})

    require(
        manifest.get("schema") == "eliza.cpu_ap_import_manifest.v1",
        "unexpected generated manifest schema",
        errors,
    )
    require(
        chipyard.get("tag") == "1.13.0",
        "generated manifest uses an unapproved Chipyard tag",
        errors,
    )
    commit = str(chipyard.get("commit", ""))
    require(
        commit == "69eba86" or commit.startswith("69eba860a352343e4ac6b6df0f3638a79a86ec78"),
        "generated manifest uses an unapproved Chipyard commit",
        errors,
    )
    require(
        chipyard.get("recursive_submodules_recorded") is True,
        "generated manifest must record recursive submodules",
        errors,
    )
    require(
        bool(chipyard.get("submodules")), "generated manifest must include submodule SHAs", errors
    )
    require(
        generation.get("config") == "ElizaRocketConfig",
        "generated manifest must use ElizaRocketConfig",
        errors,
    )
    require(isinstance(artifacts, dict), "generated manifest artifacts must be an object", errors)
    require(isinstance(evidence, dict), "generated manifest evidence must be an object", errors)
    require(
        isinstance(artifact_hashes, dict),
        "generated manifest artifact_sha256 must be an object",
        errors,
    )
    require(
        isinstance(evidence_hashes, dict),
        "generated manifest evidence_sha256 must be an object",
        errors,
    )
    if not isinstance(artifacts, dict):
        artifacts = {}
    if not isinstance(evidence, dict):
        evidence = {}
    if not isinstance(artifact_hashes, dict):
        artifact_hashes = {}
    if not isinstance(evidence_hashes, dict):
        evidence_hashes = {}

    evidence_errors: list[str] = []
    evidence_manifest = load_evidence_manifest(evidence_errors)
    errors.extend(evidence_errors)
    if errors:
        return

    artifact_specs_by_name = artifact_specs(evidence_manifest)
    for name, spec in artifact_specs_by_name.items():
        manifest_key = spec.get("manifest_key")
        path = artifacts.get(manifest_key, "") if isinstance(manifest_key, str) else ""
        expected_path = spec.get("path")
        require(
            path == expected_path,
            f"generated manifest artifact {name} path drifted: {path!r}",
            errors,
        )
        if not isinstance(path, str) or not path:
            continue
        artifact_path = ROOT / path
        validate_path_kind(artifact_path, spec, errors, name)
        min_bytes = spec.get("min_bytes")
        require(
            not isinstance(min_bytes, int)
            or not artifact_path.is_file()
            or artifact_path.stat().st_size >= min_bytes,
            f"generated {name} is smaller than manifest min_bytes: {path}",
            errors,
        )
        if artifact_path.is_file():
            text = artifact_path.read_text(encoding="utf-8", errors="ignore")
            for token in spec.get("required_strings", []):
                if isinstance(token, str):
                    require(token in text, f"generated {name} missing token: {token}", errors)
        sha_key = spec.get("sha256_key")
        if isinstance(sha_key, str):
            validate_sha256(artifact_path, artifact_hashes, name, sha_key, errors)

    missing_evidence = []
    for name, spec in transcript_specs(evidence_manifest).items():
        manifest_key = spec.get("manifest_key")
        path = evidence.get(manifest_key, "") if isinstance(manifest_key, str) else ""
        expected_path = spec.get("path")
        require(
            path == expected_path,
            f"generated manifest evidence {name} path drifted: {path!r}",
            errors,
        )
        if not isinstance(path, str) or not path:
            continue
        transcript = ROOT / path
        if not transcript.is_file():
            missing_evidence.append(path)
            continue
        text = transcript.read_text(encoding="utf-8", errors="ignore")
        errors.extend(text_problems(text, spec, path, raw=False))
        sha_key = spec.get("sha256_key")
        if isinstance(sha_key, str) and sha_key in evidence_hashes:
            validate_sha256(transcript, evidence_hashes, name, sha_key, errors)
    if missing_evidence:
        print(
            "STATUS: BLOCKED chipyard.generated_evidence - missing " + ", ".join(missing_evidence)
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-generated", action="store_true")
    args = parser.parse_args()

    errors: list[str] = []
    check_selected_manifest(errors)
    if args.require_generated:
        check_generated_import_manifest(errors)

    if errors:
        print("Chipyard/Rocket generator check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1

    print("STATUS: PASS chipyard.generator_manifest - selected Rocket RV64GC AP path is pinned")
    if not BUILD_MANIFEST.is_file():
        print(
            f"STATUS: BLOCKED chipyard.generated_import - missing {BUILD_MANIFEST.relative_to(ROOT)}"
        )
    elif args.require_generated:
        print("STATUS: PASS chipyard.generated_import")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
