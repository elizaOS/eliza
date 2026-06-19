#!/usr/bin/env python3
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFESTS = [
    "pd/signoff/si-pi/local-evidence.yaml",
    "pd/signoff/pdn-current/local-budget.yaml",
]
ALLOWED_STATUS = {"blocked", "draft_local_evidence", "complete_local_evidence"}
REQUIRED_TOP_KEYS = {
    "schema",
    "status",
    "release_use",
    "source_artifacts",
    "release_blockers",
}


def as_list(value: object) -> list[str]:
    return value if isinstance(value, list) and all(isinstance(item, str) for item in value) else []


def repo_path(value: str) -> Path:
    return ROOT / value


def validate_paths(field: str, paths: object, failures: list[str]) -> None:
    path_list = as_list(paths)
    if not path_list:
        failures.append(f"{field}: missing repo-relative paths")
        return
    for item in path_list:
        path = Path(item)
        if path.is_absolute() or ".." in path.parts:
            failures.append(f"{field}: path must be repo-relative: {item}")
        elif not repo_path(item).is_file():
            failures.append(f"{field}: referenced file is missing: {item}")


def validate_manifest(path: Path) -> list[str]:
    rel = path.relative_to(ROOT)
    failures: list[str] = []
    if not path.is_file():
        return [f"{rel}: missing manifest"]
    payload = yaml.safe_load(path.read_text())
    if not isinstance(payload, dict):
        return [f"{rel}: manifest must be a mapping"]

    missing = sorted(REQUIRED_TOP_KEYS - set(payload))
    if missing:
        failures.append(f"{rel}: missing keys: {', '.join(missing)}")

    status = payload.get("status")
    if status not in ALLOWED_STATUS:
        failures.append(f"{rel}: status must be one of {', '.join(sorted(ALLOWED_STATUS))}")
    if payload.get("release_use") != "prohibited_until_external_review":
        failures.append(f"{rel}: release_use must be prohibited_until_external_review")

    validate_paths(f"{rel}.source_artifacts", payload.get("source_artifacts"), failures)

    blockers = as_list(payload.get("release_blockers"))
    if status != "complete_local_evidence" and not blockers:
        failures.append(f"{rel}: blocked/draft manifests require release_blockers")

    derived = payload.get("derived_values", [])
    if derived and not isinstance(derived, list):
        failures.append(f"{rel}: derived_values must be a list")
    for index, item in enumerate(derived if isinstance(derived, list) else []):
        field = f"{rel}.derived_values[{index}]"
        if not isinstance(item, dict):
            failures.append(f"{field}: item must be a mapping")
            continue
        for key in ("name", "value", "source"):
            if item.get(key) in (None, ""):
                failures.append(f"{field}: missing {key}")

    return failures


def main() -> int:
    failures: list[str] = []
    for manifest in DEFAULT_MANIFESTS:
        failures.extend(validate_manifest(repo_path(manifest)))
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1
    print("SI/PI and PDN/current local evidence manifests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
