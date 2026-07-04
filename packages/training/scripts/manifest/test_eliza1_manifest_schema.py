"""Keep the manifest JSON Schema honest against a versioned fixture.

The manifest's `$schema` URL (https://elizaos.ai/schemas/eliza-1.manifest.v1.json)
now has a real backing file — eliza-1.manifest.schema.json in this directory.
This test pins a committed, valid manifest fixture and runs it through BOTH
gates that a published manifest must pass:

  1. validate_manifest()  — the authoritative cross-field / §3 / §6 contract.
  2. the JSON Schema       — the structural shape backing the $schema URL.

If either the schema or the fixture drifts from what build_manifest() emits, a
regeneration of the fixture (via test_eliza1_manifest.py::build_manifest) fails
one of these checks and the drift is caught.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.manifest.eliza1_manifest import (
    ELIZA_1_MANIFEST_SCHEMA_URL,
    validate_manifest,
)

_HERE = Path(__file__).resolve().parent
_SCHEMA_PATH = _HERE / "eliza-1.manifest.schema.json"
_FIXTURE_PATH = _HERE / "fixtures" / "eliza-1-4b.manifest.json"


def _load(path: Path) -> dict:
    return json.loads(path.read_text())


def test_schema_file_exists_and_matches_schema_url():
    assert _SCHEMA_PATH.exists(), f"missing backing schema at {_SCHEMA_PATH}"
    schema = _load(_SCHEMA_PATH)
    # The manifest's $schema URL and the schema's own $id must agree — the URL
    # is aspirational (unhosted) but the file it points at is real and versioned.
    assert schema["$id"] == ELIZA_1_MANIFEST_SCHEMA_URL


def test_fixture_is_present_and_self_describes():
    assert _FIXTURE_PATH.exists(), f"missing manifest fixture at {_FIXTURE_PATH}"
    manifest = _load(_FIXTURE_PATH)
    assert manifest["$schema"] == ELIZA_1_MANIFEST_SCHEMA_URL
    assert manifest["tier"] == "4b"
    assert manifest["id"] == "eliza-1-4b"


def test_fixture_passes_validate_manifest():
    manifest = _load(_FIXTURE_PATH)
    errors = validate_manifest(manifest)
    assert errors == (), f"fixture failed validate_manifest: {errors}"


def test_fixture_passes_json_schema():
    jsonschema = pytest.importorskip("jsonschema")
    manifest = _load(_FIXTURE_PATH)
    schema = _load(_SCHEMA_PATH)
    # Raises jsonschema.ValidationError on any structural violation.
    jsonschema.validate(instance=manifest, schema=schema)


def test_schema_rejects_a_broken_manifest():
    jsonschema = pytest.importorskip("jsonschema")
    schema = _load(_SCHEMA_PATH)
    broken = _load(_FIXTURE_PATH)
    broken["tier"] = "999b"  # not a real tier
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=broken, schema=schema)


def test_schema_rejects_bad_sha256():
    jsonschema = pytest.importorskip("jsonschema")
    schema = _load(_SCHEMA_PATH)
    broken = _load(_FIXTURE_PATH)
    broken["files"]["text"][0]["sha256"] = "not-a-real-hash"
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=broken, schema=schema)


def test_schema_and_validate_manifest_agree_on_the_fixture():
    """Both gates must PASS the same fixture — a fixture that only one accepts
    means the schema and validate_manifest have diverged."""
    jsonschema = pytest.importorskip("jsonschema")
    manifest = _load(_FIXTURE_PATH)
    schema = _load(_SCHEMA_PATH)
    assert validate_manifest(manifest) == ()
    jsonschema.validate(instance=manifest, schema=schema)
