"""Component-family constraint coverage proof for ASIMOV fembot thinning."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.fembot_keepouts import build_fembot_keepout_proof
from eliza_robot.asimov_1.fembot_step_body_index import _cadquery_index_step_files
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

COMPONENT_CONSTRAINT_SCHEMA = "asimov-fembot-component-constraint-coverage-v1"
SUPPLIER_CODE_FIT_MARGIN_M = 0.002


REQUIRED_COMPONENT_FAMILIES: tuple[dict[str, Any], ...] = (
    {
        "family": "motor_actuator",
        "label": "Motors and actuators",
        "required_geometry": "motor body envelope, output axis, ctrl range, and non-scaled mounting clearance",
        "clearance_proof_required": True,
    },
    {
        "family": "joint_axis",
        "label": "Joint axes and travel",
        "required_geometry": "hinge axis, range, armature, and mate-interface preservation",
        "clearance_proof_required": True,
    },
    {
        "family": "collision_capsule",
        "label": "Collision capsules and contact geometry",
        "required_geometry": "collision geoms used by MuJoCo motion/collision validation",
        "clearance_proof_required": True,
    },
    {
        "family": "source_mesh_envelope",
        "label": "Source mesh envelopes",
        "required_geometry": "source STL bounding envelopes for every simulation link",
        "clearance_proof_required": True,
    },
    {
        "family": "vendor_off_the_shelf",
        "label": "Off-the-shelf vendor components",
        "required_geometry": "non-scaled vendor STEP envelopes and mounting patterns",
        "clearance_proof_required": True,
    },
    {
        "family": "bearing_or_ring",
        "label": "Bearings, bushings, rings, races, and washers",
        "required_geometry": "named bearing/ring geometry with bore, outer diameter, width, and retained clearance",
        "clearance_proof_required": True,
    },
    {
        "family": "gear_or_pulley_or_belt",
        "label": "Gears, pulleys, belts, and sprockets",
        "required_geometry": "named transmission geometry with pitch/diameter/tooth or belt path envelope",
        "clearance_proof_required": True,
    },
    {
        "family": "fastener_or_thread",
        "label": "Fasteners, inserts, spacers, standoffs, and threads",
        "required_geometry": "screw/bolt/nut/thread geometry with edge-distance and tool-access checks",
        "clearance_proof_required": True,
    },
    {
        "family": "wiring_or_service_access",
        "label": "Wiring, connectors, harnesses, and service access",
        "required_geometry": "wire harness and connector envelopes with bend radius and access clearance",
        "clearance_proof_required": True,
    },
)


STEP_COMPONENT_PATTERNS: dict[str, tuple[str, ...]] = {
    "bearing_or_ring": ("bearing", "bushing", "ring", "race", "washer", "flange"),
    "gear_or_pulley_or_belt": ("gear", "pulley", "belt", "sprocket"),
    "fastener_or_thread": (
        "screw",
        "bolt",
        "nut",
        "thread",
        "insert",
        "spacer",
        "standoff",
    ),
    "motor_actuator": ("motor", "actuator", "servo"),
    "wiring_or_service_access": ("wire", "cable", "connector", "harness", "service"),
}

SUPPLIER_CODE_CLASSIFICATIONS: dict[str, dict[str, Any]] = {
    "1600-0515-0006": {
        "family": "bearing_or_ring",
        "component_type": "bearing or bearing subcomponent in 1602 pillow-block assembly",
        "classification_status": "geometry_inferred_from_step_assembly",
        "datasheet_backed": False,
        "source": "STEP product metadata groups this code with 1602-0032-0006 pillow-block geometry",
        "source_url": None,
    },
    "1602-0032-0006": {
        "family": "bearing_or_ring",
        "component_type": "6 mm bore pillow block with press-fit bearing",
        "classification_status": "classified_from_vendor_catalog",
        "datasheet_backed": True,
        "source": "ServoCity/goBILDA pillow-block catalog",
        "source_url": "https://www.servocity.com/gobilda-pillow-blocks/",
    },
    "2806-0005-0004": {
        "family": "fastener_or_thread",
        "component_type": "M5 x 0.8 mm cup-point set screw, 4 mm length",
        "classification_status": "classified_from_vendor_catalog",
        "datasheet_backed": True,
        "source": "ServoCity set-screw catalog",
        "source_url": "https://www.servocity.com/set-screws/",
    },
    "2920-0001-0006": {
        "family": "bearing_or_ring",
        "component_type": "6 mm bore steel set-screw shaft collar",
        "classification_status": "classified_from_vendor_catalog",
        "datasheet_backed": True,
        "source": "ServoCity collars catalog",
        "source_url": "https://www.servocity.com/collars/",
    },
    "91390A117": {
        "family": "fastener_or_thread",
        "component_type": "M5 x 0.8 mm cup-point set screw, 5 mm length",
        "classification_status": "classified_from_cross_reference",
        "datasheet_backed": True,
        "source": "McMaster-equivalent DIN 916 / ISO 4029 set-screw listing",
        "source_url": "https://www.mcmaster.com/products/set-screws/specifications-met~iso-4029/",
    },
}

_STEP_FILE_NAME_RE = re.compile(r"FILE_NAME\s*\(\s*'([^']+)'")
_STEP_PRODUCT_RE = re.compile(r"PRODUCT\s*\(\s*'([^']+)'")
_LOCAL_ASV_NAME_RE = re.compile(
    r"^(?:Mirror)?ASV1_\d+_\d+[A-Z](?:_SS)?(?:\.step)?(?:\.STEP)*$",
    re.IGNORECASE,
)
_SUPPLIER_CODE_RE = re.compile(
    r"(?<![A-Z0-9])(?:\d{4}-\d{4}-\d{4}|\d{5,6}[A-Z]\d{2,4})(?![A-Z0-9])",
    re.IGNORECASE,
)


def _link_keepouts(keepout_report: dict[str, Any]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for group in keepout_report.get("body_groups", []):
        if not isinstance(group, dict):
            continue
        for record in group.get("link_keepouts", []):
            if isinstance(record, dict):
                records.append(record)
    return records


def _step_candidate_evidence(body_groups: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    evidence = {family: [] for family in STEP_COMPONENT_PATTERNS}
    for group in body_groups:
        group_name = str(group.get("group"))
        links = [str(link).upper() for link in group.get("links", [])]
        for candidate in group.get("step_candidates", []):
            if not isinstance(candidate, dict):
                continue
            path = Path(str(candidate.get("path", "")))
            haystack = "/".join(path.parts).lower()
            for family, patterns in STEP_COMPONENT_PATTERNS.items():
                if not any(pattern in haystack for pattern in patterns):
                    continue
                evidence[family].append(
                    {
                        "group": group_name,
                        "links": links,
                        "path": str(path),
                        "assembly": candidate.get("assembly"),
                        "fabrication_class": candidate.get("fabrication_class"),
                        "sha256": candidate.get("sha256"),
                        "evidence_kind": "step_path_name_pattern",
                    }
                )
    return evidence


def _vendor_evidence(keepout_report: dict[str, Any]) -> list[dict[str, Any]]:
    evidence: list[dict[str, Any]] = []
    for group in keepout_report.get("body_groups", []):
        if not isinstance(group, dict):
            continue
        for keepout in group.get("off_the_shelf_keepouts", []):
            if isinstance(keepout, dict):
                evidence.append(
                    {
                        "group": group.get("group"),
                        "links": group.get("links", []),
                        "source_path": keepout.get("source_path"),
                        "assembly": keepout.get("assembly"),
                        "source_sha256": keepout.get("source_sha256"),
                        "evidence_kind": "off_the_shelf_step_keepout",
                    }
                )
    return evidence


def _cad_body_bbox_extent_m(body: dict[str, Any]) -> list[float] | None:
    bbox = body.get("bbox_mm")
    if not isinstance(bbox, dict):
        return None
    return [
        (float(bbox["xmax"]) - float(bbox["xmin"])) * 0.001,
        (float(bbox["ymax"]) - float(bbox["ymin"])) * 0.001,
        (float(bbox["zmax"]) - float(bbox["zmin"])) * 0.001,
    ]


def _cad_step_geometry_records(paths: list[str]) -> dict[str, dict[str, Any]]:
    if not paths:
        return {}
    cad_records = _cadquery_index_step_files([Path(path) for path in sorted(set(paths))])
    records: dict[str, dict[str, Any]] = {}
    for cad in cad_records:
        path = str(cad.get("path") or "")
        bodies = [body for body in cad.get("bodies", []) if isinstance(body, dict)]
        body_extents = [
            extent for body in bodies if (extent := _cad_body_bbox_extent_m(body)) is not None
        ]
        body_volumes_m3 = [
            float(body["volume_mm3"]) * 1.0e-9
            for body in bodies
            if body.get("volume_mm3") is not None
        ]
        records[path] = {
            "path": path,
            "loaded": bool(cad.get("loaded")),
            "error": cad.get("error"),
            "value_count": int(cad.get("value_count", 0) or 0),
            "solid_count": int(cad.get("solid_count", 0) or 0),
            "body_count": int(cad.get("body_count", 0) or 0),
            "body_bbox_extents_m": body_extents,
            "max_body_bbox_extent_m": max(
                (max(extent) for extent in body_extents),
                default=None,
            ),
            "total_volume_m3": sum(body_volumes_m3) if body_volumes_m3 else None,
        }
    return records


def _load_generated_cad_report() -> dict[str, Any] | None:
    path = ASIMOV_PARAM_PROOFS / "fembot-generated-cad-envelope.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _generated_link_extents(generated_cad_report: dict[str, Any] | None) -> dict[str, list[float]]:
    if not generated_cad_report:
        return {}
    extents: dict[str, list[float]] = {}
    for record in generated_cad_report.get("link_steps", []):
        if not isinstance(record, dict):
            continue
        link = str(record.get("link") or "").upper()
        raw = record.get("reloaded_bbox_extent_m")
        if not link or not isinstance(raw, list) or len(raw) != 3:
            continue
        extents[link] = [float(value) for value in raw]
    return extents


def _orientation_agnostic_bbox_fits(
    *,
    component_extent_m: list[float],
    container_extent_m: list[float],
    margin_m: float,
) -> bool:
    component = sorted(float(value) for value in component_extent_m)
    container = sorted(max(float(value) - 2.0 * margin_m, 0.0) for value in container_extent_m)
    return all(part <= space for part, space in zip(component, container, strict=True))


def _orientation_agnostic_growth_report(
    *,
    component_extents_m: list[list[float]],
    container_extent_m: list[float],
    margin_m: float,
) -> dict[str, Any]:
    sorted_container = sorted(float(value) for value in container_extent_m)
    required = [0.0, 0.0, 0.0]
    for body in component_extents_m:
        sorted_body = sorted(float(value) for value in body)
        for index, value in enumerate(sorted_body):
            required[index] = max(required[index], value + 2.0 * margin_m)
    growth = [
        max(required[index] - sorted_container[index], 0.0)
        for index in range(3)
    ]
    return {
        "sorted_generated_extent_m": sorted_container,
        "required_sorted_extent_m": required,
        "required_sorted_extent_growth_m": growth,
        "max_required_extent_growth_m": max(growth, default=0.0),
    }


def _supplier_code_generated_fit_reports(
    *,
    target: dict[str, Any],
    generated_link_extents: dict[str, list[float]],
    margin_m: float,
) -> list[dict[str, Any]]:
    body_extents = [
        [float(value) for value in body_extent]
        for geometry in target.get("geometry_records", [])
        for body_extent in geometry.get("body_bbox_extents_m", [])
        if isinstance(body_extent, list) and len(body_extent) == 3
    ]
    reports: list[dict[str, Any]] = []
    for link in target.get("referenced_by_links", []):
        link_name = str(link).upper()
        container = generated_link_extents.get(link_name)
        if container is None:
            reports.append(
                {
                    "link": link_name,
                    "generated_extent_m": None,
                    "checked_body_count": len(body_extents),
                    "orientation_agnostic_bbox_fit": False,
                    "blocking_reason": "generated CAD extent missing for referenced link",
                }
            )
            continue
        failed = [
            body
            for body in body_extents
            if not _orientation_agnostic_bbox_fits(
                component_extent_m=body,
                container_extent_m=container,
                margin_m=margin_m,
            )
        ]
        growth = _orientation_agnostic_growth_report(
            component_extents_m=body_extents,
            container_extent_m=container,
            margin_m=margin_m,
        )
        reports.append(
            {
                "link": link_name,
                "generated_extent_m": container,
                **growth,
                "checked_body_count": len(body_extents),
                "failed_body_count": len(failed),
                "orientation_agnostic_bbox_fit": not failed and bool(body_extents),
                "fit_margin_m": margin_m,
                "max_failed_body_extent_m": max(
                    (max(body) for body in failed),
                    default=None,
                ),
                "blocking_reason": (
                    None
                    if not failed and body_extents
                    else "at least one supplier-code body bbox cannot fit inside this generated link envelope with margin"
                ),
            }
        )
    return reports


def _supplier_code_link_growth_summary(
    supplier_code_targets: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    by_link: dict[str, dict[str, Any]] = {}
    for target in supplier_code_targets:
        supplier_code = str(target.get("supplier_code"))
        for report in target.get("generated_link_fit_reports", []):
            if not isinstance(report, dict):
                continue
            link = str(report.get("link") or "").upper()
            if not link:
                continue
            record = by_link.setdefault(
                link,
                {
                    "link": link,
                    "checked_supplier_codes": [],
                    "failed_supplier_codes": [],
                    "fit_check_count": 0,
                    "fit_fail_count": 0,
                    "max_required_extent_growth_m": 0.0,
                    "max_required_sorted_extent_growth_m": [0.0, 0.0, 0.0],
                },
            )
            record["fit_check_count"] += 1
            if supplier_code not in record["checked_supplier_codes"]:
                record["checked_supplier_codes"].append(supplier_code)
            growth = [
                float(value)
                for value in report.get("required_sorted_extent_growth_m", [0.0, 0.0, 0.0])
            ]
            record["max_required_sorted_extent_growth_m"] = [
                max(float(record["max_required_sorted_extent_growth_m"][index]), growth[index])
                for index in range(3)
            ]
            record["max_required_extent_growth_m"] = max(
                float(record["max_required_extent_growth_m"]),
                float(report.get("max_required_extent_growth_m") or 0.0),
            )
            if not report.get("orientation_agnostic_bbox_fit"):
                record["fit_fail_count"] += 1
                if supplier_code not in record["failed_supplier_codes"]:
                    record["failed_supplier_codes"].append(supplier_code)

    records = []
    for record in by_link.values():
        record["checked_supplier_codes"] = sorted(record["checked_supplier_codes"])
        record["failed_supplier_codes"] = sorted(record["failed_supplier_codes"])
        record["fit_pass_count"] = int(record["fit_check_count"]) - int(record["fit_fail_count"])
        record["requires_growth"] = float(record["max_required_extent_growth_m"]) > 0.0
        records.append(record)
    return sorted(records, key=lambda item: (-float(item["max_required_extent_growth_m"]), item["link"]))


def _supplier_code_classification(supplier_code: str) -> dict[str, Any]:
    classification = SUPPLIER_CODE_CLASSIFICATIONS.get(supplier_code)
    if classification is None:
        return {
            "supplier_code": supplier_code,
            "family": None,
            "component_type": None,
            "classification_status": "supplier_code_unclassified",
            "datasheet_backed": False,
            "source": None,
            "source_url": None,
            "classification_required_for_acceptance": True,
        }
    return {
        "supplier_code": supplier_code,
        **classification,
        "classification_required_for_acceptance": True,
    }


def _step_product_metadata(path: str) -> dict[str, Any]:
    source = Path(path)
    metadata = {
        "file_name": None,
        "product_names": [],
        "nonlocal_product_names": [],
        "supplier_codes": [],
        "component_family_keywords": [],
        "metadata_read_error": None,
    }
    try:
        text = source.read_text(encoding="utf-8", errors="ignore")
    except OSError as exc:
        metadata["metadata_read_error"] = f"{type(exc).__name__}: {exc}"
        return metadata

    file_name_match = _STEP_FILE_NAME_RE.search(text)
    if file_name_match:
        metadata["file_name"] = file_name_match.group(1)
    product_names = sorted(set(_STEP_PRODUCT_RE.findall(text)))
    metadata["product_names"] = product_names
    metadata["nonlocal_product_names"] = [
        name
        for name in product_names
        if not _LOCAL_ASV_NAME_RE.match(name) and "assembly" not in name.lower()
    ]
    supplier_codes = sorted(
        {
            code
            for name in [str(metadata["file_name"] or ""), *product_names]
            for code in _SUPPLIER_CODE_RE.findall(name)
        }
    )
    metadata["supplier_codes"] = supplier_codes
    lower_names = " ".join([str(metadata["file_name"] or ""), *product_names]).lower()
    metadata["component_family_keywords"] = sorted(
        {
            family
            for family, patterns in STEP_COMPONENT_PATTERNS.items()
            if any(pattern in lower_names for pattern in patterns)
        }
    )
    return metadata


def _vendor_summary(
    evidence: list[dict[str, Any]],
    *,
    generated_cad_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    unique_by_path: dict[str, dict[str, Any]] = {}
    assembly_paths: dict[str, set[str]] = {}
    duplicated_paths: dict[str, int] = {}
    records_by_hash: dict[str, list[dict[str, Any]]] = {}
    records_by_supplier_code: dict[str, list[dict[str, Any]]] = {}

    for item in evidence:
        path = str(item.get("source_path") or "")
        if not path:
            continue
        unique_by_path.setdefault(
            path,
            {
                "source_path": path,
                "source_sha256": item.get("source_sha256"),
                "assembly": item.get("assembly"),
                "referenced_by_groups": [],
                "referenced_by_links": [],
            },
        )
        record = unique_by_path[path]
        group = item.get("group")
        if group and group not in record["referenced_by_groups"]:
            record["referenced_by_groups"].append(group)
        for link in item.get("links", []):
            if link not in record["referenced_by_links"]:
                record["referenced_by_links"].append(link)
        assembly = str(item.get("assembly") or "unknown")
        assembly_paths.setdefault(assembly, set()).add(path)

    reference_counts: dict[str, int] = {}
    for item in evidence:
        path = str(item.get("source_path") or "")
        if path:
            reference_counts[path] = reference_counts.get(path, 0) + 1
    for path, count in reference_counts.items():
        if count > 1:
            duplicated_paths[path] = count

    unique_records = sorted(unique_by_path.values(), key=lambda item: item["source_path"])
    for record in unique_records:
        record["referenced_by_groups"] = sorted(record["referenced_by_groups"])
        record["referenced_by_links"] = sorted(record["referenced_by_links"])
        record["step_metadata"] = _step_product_metadata(str(record["source_path"]))
        source_hash = str(record.get("source_sha256") or "")
        if source_hash:
            records_by_hash.setdefault(source_hash, []).append(record)
        for supplier_code in record["step_metadata"]["supplier_codes"]:
            records_by_supplier_code.setdefault(supplier_code, []).append(record)

    metadata_records = [
        record for record in unique_records if record["step_metadata"]["product_names"]
    ]
    supplier_code_records = [
        record for record in unique_records if record["step_metadata"]["supplier_codes"]
    ]
    family_keyword_records = [
        record
        for record in unique_records
        if record["step_metadata"]["component_family_keywords"]
    ]
    duplicate_geometry_groups = [
        {
            "source_sha256": source_hash,
            "path_count": len(records),
            "paths": sorted(record["source_path"] for record in records),
            "assemblies": sorted({str(record.get("assembly") or "unknown") for record in records}),
            "referenced_by_groups": sorted(
                {
                    str(group)
                    for record in records
                    for group in record.get("referenced_by_groups", [])
                }
            ),
            "referenced_by_links": sorted(
                {
                    str(link)
                    for record in records
                    for link in record.get("referenced_by_links", [])
                }
            ),
        }
        for source_hash, records in sorted(records_by_hash.items())
        if len(records) > 1
    ]
    supplier_code_targets = [
        {
            "supplier_code": supplier_code,
            "path_count": len(records),
            "paths": sorted(record["source_path"] for record in records),
            "assemblies": sorted({str(record.get("assembly") or "unknown") for record in records}),
            "referenced_by_groups": sorted(
                {
                    str(group)
                    for record in records
                    for group in record.get("referenced_by_groups", [])
                }
            ),
            "referenced_by_links": sorted(
                {
                    str(link)
                    for record in records
                    for link in record.get("referenced_by_links", [])
                }
            ),
            "classification": _supplier_code_classification(supplier_code),
        }
        for supplier_code, records in sorted(records_by_supplier_code.items())
    ]
    supplier_paths = [
        path
        for target in supplier_code_targets
        for path in target["paths"]
    ]
    geometry_by_path = _cad_step_geometry_records(supplier_paths)
    unique_loaded_supplier_geometry_paths = sum(
        1 for record in geometry_by_path.values() if record.get("loaded")
    )
    unique_failed_supplier_geometry_paths = len(geometry_by_path) - unique_loaded_supplier_geometry_paths
    generated_link_extents = _generated_link_extents(generated_cad_report)
    for target in supplier_code_targets:
        geometry_records = [
            geometry_by_path.get(path)
            or {
                "path": path,
                "loaded": False,
                "error": "missing CAD-kernel measurement",
            }
            for path in target["paths"]
        ]
        target["geometry_records"] = geometry_records
        target["geometry_loaded_count"] = sum(
            1 for record in geometry_records if record.get("loaded")
        )
        target["geometry_failed_count"] = len(geometry_records) - int(
            target["geometry_loaded_count"]
        )
        target["max_body_bbox_extent_m"] = max(
            (
                float(record["max_body_bbox_extent_m"])
                for record in geometry_records
                if record.get("max_body_bbox_extent_m") is not None
            ),
            default=None,
        )
        target["total_volume_m3"] = sum(
            float(record["total_volume_m3"])
            for record in geometry_records
            if record.get("total_volume_m3") is not None
        )
        fit_reports = _supplier_code_generated_fit_reports(
            target=target,
            generated_link_extents=generated_link_extents,
            margin_m=SUPPLIER_CODE_FIT_MARGIN_M,
        )
        target["generated_link_fit_reports"] = fit_reports
        target["generated_link_fit_checked_count"] = len(fit_reports)
        target["generated_link_fit_pass_count"] = sum(
            1 for report in fit_reports if report["orientation_agnostic_bbox_fit"]
        )
        target["generated_link_fit_fail_count"] = sum(
            1 for report in fit_reports if not report["orientation_agnostic_bbox_fit"]
        )
        target["max_required_generated_extent_growth_m"] = max(
            (
                float(report.get("max_required_extent_growth_m") or 0.0)
                for report in fit_reports
            ),
            default=0.0,
        )
        target["classification"]["geometry_loaded_count"] = target["geometry_loaded_count"]
        target["classification"]["geometry_failed_count"] = target["geometry_failed_count"]
        target["classification"]["generated_link_fit_checked_count"] = target[
            "generated_link_fit_checked_count"
        ]
        target["classification"]["generated_link_fit_fail_count"] = target[
            "generated_link_fit_fail_count"
        ]
    supplier_code_link_growth_summary = _supplier_code_link_growth_summary(
        supplier_code_targets
    )
    supplier_code_growth_links = [
        record for record in supplier_code_link_growth_summary if record["requires_growth"]
    ]
    classified_supplier_code_targets = [
        target
        for target in supplier_code_targets
        if target["classification"].get("family")
    ]
    supplier_code_family_counts: dict[str, int] = {}
    for target in classified_supplier_code_targets:
        family = str(target["classification"]["family"])
        supplier_code_family_counts[family] = supplier_code_family_counts.get(family, 0) + 1

    return {
        "unique_vendor_envelopes": len(unique_by_path),
        "unique_vendor_geometry_hashes": len(records_by_hash),
        "duplicate_vendor_geometry_hashes": len(duplicate_geometry_groups),
        "duplicate_vendor_geometry_paths": sum(
            record["path_count"] for record in duplicate_geometry_groups
        ),
        "duplicate_vendor_references": len(evidence) - len(unique_by_path),
        "vendor_envelopes_with_step_product_metadata": len(metadata_records),
        "vendor_envelopes_with_supplier_codes": len(supplier_code_records),
        "unique_vendor_supplier_codes": len(records_by_supplier_code),
        "classified_vendor_supplier_codes": len(classified_supplier_code_targets),
        "unclassified_vendor_supplier_codes": len(supplier_code_targets)
        - len(classified_supplier_code_targets),
        "supplier_code_family_counts": dict(sorted(supplier_code_family_counts.items())),
        "supplier_code_geometry_loaded_paths": sum(
            int(target["geometry_loaded_count"]) for target in supplier_code_targets
        ),
        "supplier_code_geometry_failed_paths": sum(
            int(target["geometry_failed_count"]) for target in supplier_code_targets
        ),
        "unique_supplier_code_geometry_loaded_paths": unique_loaded_supplier_geometry_paths,
        "unique_supplier_code_geometry_failed_paths": unique_failed_supplier_geometry_paths,
        "supplier_code_fit_margin_m": SUPPLIER_CODE_FIT_MARGIN_M,
        "supplier_code_generated_link_fit_checked": sum(
            int(target["generated_link_fit_checked_count"]) for target in supplier_code_targets
        ),
        "supplier_code_generated_link_fit_pass": sum(
            int(target["generated_link_fit_pass_count"]) for target in supplier_code_targets
        ),
        "supplier_code_generated_link_fit_fail": sum(
            int(target["generated_link_fit_fail_count"]) for target in supplier_code_targets
        ),
        "supplier_code_max_required_generated_extent_growth_m": max(
            (
                float(target.get("max_required_generated_extent_growth_m") or 0.0)
                for target in supplier_code_targets
            ),
            default=0.0,
        ),
        "supplier_code_generated_links_checked": len(supplier_code_link_growth_summary),
        "supplier_code_generated_links_requiring_growth": len(supplier_code_growth_links),
        "supplier_code_worst_growth_links": [
            record["link"] for record in supplier_code_growth_links[:8]
        ],
        "vendor_envelopes_with_component_family_keywords": len(family_keyword_records),
        "duplicate_vendor_geometry_groups": duplicate_geometry_groups,
        "supplier_code_classification_targets": supplier_code_targets,
        "supplier_code_link_growth_summary": supplier_code_link_growth_summary,
        "duplicated_vendor_paths": [
            {"source_path": path, "reference_count": count}
            for path, count in sorted(duplicated_paths.items())
        ],
        "supplier_code_records": [
            {
                "source_path": record["source_path"],
                "supplier_codes": record["step_metadata"]["supplier_codes"],
                "nonlocal_product_names": record["step_metadata"]["nonlocal_product_names"],
            }
            for record in supplier_code_records
        ],
        "component_family_keyword_records": [
            {
                "source_path": record["source_path"],
                "families": record["step_metadata"]["component_family_keywords"],
                "product_names": record["step_metadata"]["product_names"],
            }
            for record in family_keyword_records
        ],
        "vendor_envelopes_by_assembly": {
            assembly: len(paths) for assembly, paths in sorted(assembly_paths.items())
        },
        "unique_vendor_envelope_records": unique_records,
    }


def _family_record(
    *,
    family: dict[str, Any],
    covered_count: int,
    covered_links: set[str] | None = None,
    evidence: list[dict[str, Any]] | None = None,
    clearance_geometry: bool = False,
    clearance_verified: bool = False,
    acceptance_blocker: str | None = None,
) -> dict[str, Any]:
    covered_links = covered_links or set()
    evidence = evidence or []
    return {
        "family": family["family"],
        "label": family["label"],
        "required": True,
        "required_geometry": family["required_geometry"],
        "clearance_proof_required": bool(family["clearance_proof_required"]),
        "covered_count": covered_count,
        "covered_links": sorted(covered_links),
        "evidence_count": len(evidence),
        "evidence": evidence,
        "clearance_geometry_present": clearance_geometry,
        "clearance_verified": clearance_verified,
        "accepted": bool(covered_count > 0 and clearance_geometry and clearance_verified),
        "acceptance_blocker": acceptance_blocker,
    }


def build_fembot_component_constraint_coverage_proof(
    body_groups: list[dict[str, Any]],
    *,
    keepout_report: dict[str, Any] | None = None,
    generated_cad_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Classify critical component constraints before accepting thinner geometry."""
    if keepout_report is None:
        keepout_report = build_fembot_keepout_proof(body_groups)

    link_keepouts = _link_keepouts(keepout_report)
    step_evidence = _step_candidate_evidence(body_groups)
    vendor_evidence = _vendor_evidence(keepout_report)
    vendor_summary = _vendor_summary(
        vendor_evidence,
        generated_cad_report=generated_cad_report or _load_generated_cad_report(),
    )

    family_by_name = {family["family"]: family for family in REQUIRED_COMPONENT_FAMILIES}
    records: list[dict[str, Any]] = []

    actuator_links = {
        str(record.get("link")).upper()
        for record in link_keepouts
        if record.get("actuator_keepouts")
    }
    joint_links = {
        str(record.get("link")).upper()
        for record in link_keepouts
        if record.get("joint_keepouts")
    }
    collision_links = {
        str(record.get("link")).upper()
        for record in link_keepouts
        if record.get("collision_keepouts")
    }
    source_envelope_links = {
        str(record.get("link")).upper()
        for record in link_keepouts
        if record.get("source_mesh_envelope")
    }

    records.append(
        _family_record(
            family=family_by_name["motor_actuator"],
            covered_count=sum(len(record.get("actuator_keepouts", [])) for record in link_keepouts),
            covered_links=actuator_links,
            evidence=[
                {
                    "link": record.get("link"),
                    "count": len(record.get("actuator_keepouts", [])),
                    "evidence_kind": "mjcf_actuator_keepout",
                }
                for record in link_keepouts
                if record.get("actuator_keepouts")
            ],
            clearance_geometry=True,
            clearance_verified=False,
            acceptance_blocker="actuator envelopes are inventoried, but final generated bodies still need positive clearance proof",
        )
    )
    records.append(
        _family_record(
            family=family_by_name["joint_axis"],
            covered_count=sum(len(record.get("joint_keepouts", [])) for record in link_keepouts),
            covered_links=joint_links,
            evidence=[
                {
                    "link": record.get("link"),
                    "count": len(record.get("joint_keepouts", [])),
                    "evidence_kind": "mjcf_joint_keepout",
                }
                for record in link_keepouts
                if record.get("joint_keepouts")
            ],
            clearance_geometry=True,
            clearance_verified=False,
            acceptance_blocker="joint axes and ranges are inventoried, but mate-interface and swept-clearance proof is still required",
        )
    )
    records.append(
        _family_record(
            family=family_by_name["collision_capsule"],
            covered_count=sum(len(record.get("collision_keepouts", [])) for record in link_keepouts),
            covered_links=collision_links,
            evidence=[
                {
                    "link": record.get("link"),
                    "count": len(record.get("collision_keepouts", [])),
                    "evidence_kind": "mjcf_collision_keepout",
                }
                for record in link_keepouts
                if record.get("collision_keepouts")
            ],
            clearance_geometry=True,
            clearance_verified=False,
            acceptance_blocker="collision geoms exist, but final generated bodies still need component-specific clearance certification",
        )
    )
    records.append(
        _family_record(
            family=family_by_name["source_mesh_envelope"],
            covered_count=len(source_envelope_links),
            covered_links=source_envelope_links,
            evidence=[
                {
                    "link": record.get("link"),
                    "source_path": (record.get("source_mesh_envelope") or {}).get("source_path"),
                    "evidence_kind": "source_stl_envelope",
                }
                for record in link_keepouts
                if record.get("source_mesh_envelope")
            ],
            clearance_geometry=True,
            clearance_verified=False,
            acceptance_blocker="source envelopes are measured, but they are not a substitute for named internal component clearances",
        )
    )
    records.append(
        _family_record(
            family=family_by_name["vendor_off_the_shelf"],
            covered_count=vendor_summary["unique_vendor_envelopes"],
            covered_links={link for item in vendor_evidence for link in item.get("links", [])},
            evidence=vendor_summary["unique_vendor_envelope_records"],
            clearance_geometry=bool(vendor_evidence),
            clearance_verified=False,
            acceptance_blocker=(
                "unique vendor STEP envelopes are indexed, but duplicated body-group "
                "references, mounting semantics, and positive clearance are not yet certified"
            ),
        )
    )

    for family_name in (
        "bearing_or_ring",
        "gear_or_pulley_or_belt",
        "fastener_or_thread",
        "wiring_or_service_access",
    ):
        supplier_evidence = [
            {
                "supplier_code": target["supplier_code"],
                "component_type": target["classification"].get("component_type"),
                "classification_status": target["classification"].get("classification_status"),
                "datasheet_backed": target["classification"].get("datasheet_backed"),
                "source": target["classification"].get("source"),
                "source_url": target["classification"].get("source_url"),
                "referenced_by_groups": target.get("referenced_by_groups", []),
                "referenced_by_links": target.get("referenced_by_links", []),
                "path_count": target.get("path_count"),
                "geometry_loaded_count": target.get("geometry_loaded_count"),
                "geometry_failed_count": target.get("geometry_failed_count"),
                "generated_link_fit_checked_count": target.get("generated_link_fit_checked_count"),
                "generated_link_fit_fail_count": target.get("generated_link_fit_fail_count"),
                "max_body_bbox_extent_m": target.get("max_body_bbox_extent_m"),
                "evidence_kind": "classified_supplier_code_step_geometry",
            }
            for target in vendor_summary["supplier_code_classification_targets"]
            if target["classification"].get("family") == family_name
        ]
        evidence = [*step_evidence[family_name], *supplier_evidence]
        has_supplier_geometry = any(
            int(item.get("geometry_loaded_count") or 0) > 0
            for item in supplier_evidence
        )
        records.append(
            _family_record(
                family=family_by_name[family_name],
                covered_count=len(evidence),
                covered_links={
                    link
                    for item in evidence
                    for link in [*item.get("links", []), *item.get("referenced_by_links", [])]
                },
                evidence=evidence,
                clearance_geometry=has_supplier_geometry,
                clearance_verified=False,
                acceptance_blocker=(
                    "no named STEP, MJCF, or manifest geometry has been classified for this "
                    "component family"
                    if not evidence
                    else "classified STEP/vendor geometry exists, but exact measured dimensions and positive generated-body clearance are not certified"
                ),
            )
        )

    covered_families = [record["family"] for record in records if record["covered_count"] > 0]
    missing_families = [record["family"] for record in records if record["covered_count"] == 0]
    families_with_clearance_geometry = [
        record["family"] for record in records if record["clearance_geometry_present"]
    ]
    accepted_families = [record["family"] for record in records if record["accepted"]]
    ok = bool(keepout_report.get("ok") and records)
    accepted = len(accepted_families) == len(records) and ok

    return {
        "schema": COMPONENT_CONSTRAINT_SCHEMA,
        "ok": ok,
        "accepted": accepted,
        "summary": {
            "required_families": len(REQUIRED_COMPONENT_FAMILIES),
            "covered_families": len(covered_families),
            "missing_families": missing_families,
            "families_with_clearance_geometry": families_with_clearance_geometry,
            "accepted_families": len(accepted_families),
            "links_with_motor_keepouts": len(actuator_links),
            "links_with_joint_axis_keepouts": len(joint_links),
            "links_with_collision_keepouts": len(collision_links),
            "source_mesh_envelopes": len(source_envelope_links),
            "off_the_shelf_vendor_envelopes": len(vendor_evidence),
            "unique_off_the_shelf_vendor_envelopes": vendor_summary[
                "unique_vendor_envelopes"
            ],
            "duplicate_off_the_shelf_vendor_references": vendor_summary[
                "duplicate_vendor_references"
            ],
            "unique_off_the_shelf_vendor_geometry_hashes": vendor_summary[
                "unique_vendor_geometry_hashes"
            ],
            "duplicate_off_the_shelf_vendor_geometry_hashes": vendor_summary[
                "duplicate_vendor_geometry_hashes"
            ],
            "duplicate_off_the_shelf_vendor_geometry_paths": vendor_summary[
                "duplicate_vendor_geometry_paths"
            ],
            "vendor_envelopes_with_step_product_metadata": vendor_summary[
                "vendor_envelopes_with_step_product_metadata"
            ],
            "vendor_envelopes_with_supplier_codes": vendor_summary[
                "vendor_envelopes_with_supplier_codes"
            ],
            "unique_vendor_supplier_codes": vendor_summary[
                "unique_vendor_supplier_codes"
            ],
            "classified_vendor_supplier_codes": vendor_summary[
                "classified_vendor_supplier_codes"
            ],
            "unclassified_vendor_supplier_codes": vendor_summary[
                "unclassified_vendor_supplier_codes"
            ],
            "supplier_code_family_counts": vendor_summary[
                "supplier_code_family_counts"
            ],
            "supplier_code_geometry_loaded_paths": vendor_summary[
                "supplier_code_geometry_loaded_paths"
            ],
            "supplier_code_geometry_failed_paths": vendor_summary[
                "supplier_code_geometry_failed_paths"
            ],
            "unique_supplier_code_geometry_loaded_paths": vendor_summary[
                "unique_supplier_code_geometry_loaded_paths"
            ],
            "unique_supplier_code_geometry_failed_paths": vendor_summary[
                "unique_supplier_code_geometry_failed_paths"
            ],
            "supplier_code_fit_margin_m": vendor_summary["supplier_code_fit_margin_m"],
            "supplier_code_generated_link_fit_checked": vendor_summary[
                "supplier_code_generated_link_fit_checked"
            ],
            "supplier_code_generated_link_fit_pass": vendor_summary[
                "supplier_code_generated_link_fit_pass"
            ],
            "supplier_code_generated_link_fit_fail": vendor_summary[
                "supplier_code_generated_link_fit_fail"
            ],
            "supplier_code_max_required_generated_extent_growth_m": vendor_summary[
                "supplier_code_max_required_generated_extent_growth_m"
            ],
            "supplier_code_generated_links_checked": vendor_summary[
                "supplier_code_generated_links_checked"
            ],
            "supplier_code_generated_links_requiring_growth": vendor_summary[
                "supplier_code_generated_links_requiring_growth"
            ],
            "supplier_code_worst_growth_links": vendor_summary[
                "supplier_code_worst_growth_links"
            ],
            "vendor_envelopes_with_component_family_keywords": vendor_summary[
                "vendor_envelopes_with_component_family_keywords"
            ],
            "vendor_envelopes_by_assembly": vendor_summary["vendor_envelopes_by_assembly"],
            "step_candidate_component_evidence": sum(len(items) for items in step_evidence.values()),
            "accepted": accepted,
            "acceptance_blocker": (
                None
                if accepted
                else (
                    "motors, joints, collision, source mesh, vendor envelopes, bearing/ring "
                    "supplier codes, and fastener/thread supplier codes are inventoried; "
                    "gears/pulleys/belts, wiring/service access, exact measured dimensions, "
                    "and final positive clearance checks still need explicit geometry before "
                    "thinning can be accepted"
                )
            ),
        },
        "vendor_envelope_summary": vendor_summary,
        "component_families": records,
    }


def dump_fembot_component_constraint_coverage_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_component_constraint_coverage_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-component-constraints.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        dump_fembot_component_constraint_coverage_proof_json(report),
        encoding="utf-8",
    )
    return output
