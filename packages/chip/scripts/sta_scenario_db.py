#!/usr/bin/env python3
"""MMMC scenario database derived from the corner manifests.

A "scenario" (analysis view) is the Cartesian product of a delay corner
(PVT, from `pvt_corners`), an RC corner (from `rc_corners`) and an operating
mode (functional / scan / test, derived from the modes a node declares or a
single `func` default). This is the canonical thing OpenSTA, and a future
PrimeTime/Tempus importer, both target.

The scenario set is built FROM `pd/corner-manifests/<node_id>.yaml`
(`eliza.pd_corner_manifest.v1`) keyed by node_id. It carries no Liberty/SPEF
of its own — it only references corner names + OCV model so the STA driver
can resolve real files. For advanced NDA nodes
(`blocked_until_foundry_agreement`) the scenario set is PRESENT but EMPTY and
flagged `blocked` with the reason: those nodes ship no Liberty, so no
scenario can be exercised. We never fabricate corners for them.

Schema emitted: `eliza.pd_mmmc_scenario.v1`.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
CORNER_MANIFEST_DIR = ROOT / "pd" / "corner-manifests"

SCHEMA = "eliza.pd_mmmc_scenario.v1"

OPEN_PDK_NODES = frozenset({"sky130", "gf180", "ihp-sg13g2"})
PREDICTIVE_NODES = frozenset({"asap7"})
NDA_BLOCKED_NODES = frozenset(
    {"tsmc-n2p", "tsmc-a14", "intel-14a", "samsung-sf2p"}
)
KNOWN_NODES = OPEN_PDK_NODES | PREDICTIVE_NODES | NDA_BLOCKED_NODES

# Default OCV margin derate (early/late) applied when a manifest does NOT
# declare an LVF/SOCV model. These are documented graph-based OCV margins,
# NOT signoff-accurate statistical numbers. OpenSTA applies them via
# set_timing_derate. The values bound a single-Vt open-PDK flow; they are not
# claimed to match silicon.
DEFAULT_OCV_LATE_DERATE = 1.05
DEFAULT_OCV_EARLY_DERATE = 0.95


@dataclass(frozen=True)
class DelayCorner:
    """A PVT delay corner referencing a Liberty file by name."""

    name: str
    process: str
    voltage_v: float
    temperature_c: float
    role: str
    liberty: str


@dataclass(frozen=True)
class RcCorner:
    """An RC extraction corner referencing an extraction view by name."""

    name: str
    role: str
    view: str | None = None


@dataclass(frozen=True)
class OcvModel:
    """How on-chip-variation is modeled for a scenario.

    `kind` is one of:
      - "lvf"  : manifest declares LVF/SOCV; emit read_lvf + statistical OCV.
      - "ocv"  : default graph-based OCV margin derate (early/late).
    For "lvf" we still record the margin derates as a documented fallback the
    importer may use if the LVF files are not resolvable at run time.
    """

    kind: str
    late_derate: float
    early_derate: float
    lvf_declared: bool


@dataclass(frozen=True)
class Scenario:
    """One analysis view: delay_corner x rc_corner x mode."""

    name: str
    mode: str
    delay_corner: DelayCorner
    rc_corner: RcCorner
    ocv: OcvModel
    analysis_type: str  # "max" (setup) | "min" (hold) | "max_min"


@dataclass
class ScenarioSet:
    """The full scenario DB for one node_id."""

    node_id: str
    pdk: str
    node_class: str
    status: str
    evidence_class: str
    blocked: bool
    blocked_reason: str | None
    scenarios: list[Scenario] = field(default_factory=list)


def _manifest_path(node_id: str) -> Path:
    return CORNER_MANIFEST_DIR / f"{node_id}.yaml"


def _load_manifest(node_id: str) -> dict[str, Any]:
    path = _manifest_path(node_id)
    if not path.is_file():
        raise FileNotFoundError(f"corner manifest missing for node '{node_id}': {path}")
    payload = yaml.safe_load(path.read_text())
    if not isinstance(payload, dict):
        raise ValueError(f"corner manifest is not a mapping: {path}")
    schema = payload.get("schema")
    if schema != "eliza.pd_corner_manifest.v1":
        raise ValueError(
            f"corner manifest {path} has unexpected schema '{schema}'; "
            "expected eliza.pd_corner_manifest.v1"
        )
    return payload


def _declares_lvf(manifest: dict[str, Any]) -> bool:
    """True when the manifest declares an LVF/SOCV OCV model.

    Open/predictive manifests do not carry `ocv_model`; advanced nodes carry
    `ocv_model: LVF_or_SOCV` under `required_after_unblock`. We honor an
    explicit top-level `ocv_model` too so an open PDK that later gains LVF
    views can opt in without code changes.
    """
    top = manifest.get("ocv_model")
    if isinstance(top, str) and "lvf" in top.lower():
        return True
    if isinstance(top, str) and "socv" in top.lower():
        return True
    req = manifest.get("required_after_unblock", {})
    if isinstance(req, dict):
        model = req.get("ocv_model")
        if isinstance(model, str) and ("lvf" in model.lower() or "socv" in model.lower()):
            return True
    return False


def _ocv_model(manifest: dict[str, Any]) -> OcvModel:
    lvf = _declares_lvf(manifest)
    return OcvModel(
        kind="lvf" if lvf else "ocv",
        late_derate=DEFAULT_OCV_LATE_DERATE,
        early_derate=DEFAULT_OCV_EARLY_DERATE,
        lvf_declared=lvf,
    )


def _modes(manifest: dict[str, Any]) -> list[str]:
    """Operating modes for the node.

    A manifest may declare `modes: [func, scan, ...]`. Open PDKs today only
    exercise the functional mode, so default to ["func"]. We never invent
    extra modes for a node that doesn't declare them.
    """
    modes = manifest.get("modes")
    if isinstance(modes, list) and modes and all(isinstance(m, str) for m in modes):
        return list(modes)
    return ["func"]


def _delay_corners(manifest: dict[str, Any]) -> list[DelayCorner]:
    out: list[DelayCorner] = []
    for entry in manifest.get("pvt_corners", []) or []:
        if not isinstance(entry, dict):
            continue
        liberty = entry.get("liberty")
        if not liberty:
            # A PVT corner with no Liberty reference is unusable; skip it
            # rather than fabricate a file name.
            continue
        out.append(
            DelayCorner(
                name=str(entry["name"]),
                process=str(entry.get("process", "")).lower(),
                voltage_v=float(entry.get("voltage_v", 0.0)),
                temperature_c=float(entry.get("temperature_c", 0.0)),
                role=str(entry.get("role", "")),
                liberty=str(liberty),
            )
        )
    return out


def _rc_corners(manifest: dict[str, Any]) -> list[RcCorner]:
    out: list[RcCorner] = []
    for entry in manifest.get("rc_corners", []) or []:
        if not isinstance(entry, dict):
            continue
        view = entry.get("view")
        out.append(
            RcCorner(
                name=str(entry["name"]),
                role=str(entry.get("role", "")),
                view=str(view) if view is not None else None,
            )
        )
    return out


def _analysis_type(role: str) -> str:
    """Map a delay-corner role to the dominant analysis check.

    worst_setup -> max (setup), worst_hold -> min (hold), everything else is
    checked both ways. This is advisory metadata; the STA driver still runs
    both setup and hold per corner.
    """
    role_l = role.lower()
    if "setup" in role_l:
        return "max"
    if "hold" in role_l:
        return "min"
    return "max_min"


def build_scenario_set(node_id: str) -> ScenarioSet:
    """Build the scenario DB for one node from its corner manifest."""
    if node_id not in KNOWN_NODES:
        raise ValueError(
            f"unknown node_id '{node_id}'; known nodes: {sorted(KNOWN_NODES)}"
        )
    manifest = _load_manifest(node_id)
    status = str(manifest.get("status", ""))
    pdk = str(manifest.get("pdk", ""))
    node_class = str(manifest.get("node_class", ""))
    evidence_class = str(manifest.get("evidence_class", ""))

    blocked = status == "blocked_until_foundry_agreement" or node_id in NDA_BLOCKED_NODES
    if blocked:
        return ScenarioSet(
            node_id=node_id,
            pdk=pdk,
            node_class=node_class,
            status=status,
            evidence_class=evidence_class,
            blocked=True,
            blocked_reason=(
                "NDA advanced node: no Liberty/extraction may be checked in; "
                "scenario set is present but empty until foundry + commercial-EDA "
                "agreement (see procurement_gate in the corner manifest)."
            ),
            scenarios=[],
        )

    delay_corners = _delay_corners(manifest)
    rc_corners = _rc_corners(manifest)
    ocv = _ocv_model(manifest)
    modes = _modes(manifest)

    if not delay_corners:
        raise ValueError(
            f"node '{node_id}' is not blocked but declares no usable PVT corners "
            "with Liberty references in its corner manifest"
        )
    if not rc_corners:
        raise ValueError(f"node '{node_id}' declares no RC corners in its corner manifest")

    scenarios: list[Scenario] = []
    for mode in modes:
        for dc in delay_corners:
            for rc in rc_corners:
                scenarios.append(
                    Scenario(
                        name=f"{mode}__{dc.name}__rc_{rc.name}",
                        mode=mode,
                        delay_corner=dc,
                        rc_corner=rc,
                        ocv=ocv,
                        analysis_type=_analysis_type(dc.role),
                    )
                )

    return ScenarioSet(
        node_id=node_id,
        pdk=pdk,
        node_class=node_class,
        status=status,
        evidence_class=evidence_class,
        blocked=False,
        blocked_reason=None,
        scenarios=scenarios,
    )


def scenario_set_to_dict(sset: ScenarioSet) -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "node_id": sset.node_id,
        "pdk": sset.pdk,
        "node_class": sset.node_class,
        "status": sset.status,
        "evidence_class": sset.evidence_class,
        "blocked": sset.blocked,
        "blocked_reason": sset.blocked_reason,
        "scenario_count": len(sset.scenarios),
        "scenarios": [
            {
                "name": s.name,
                "mode": s.mode,
                "analysis_type": s.analysis_type,
                "delay_corner": asdict(s.delay_corner),
                "rc_corner": asdict(s.rc_corner),
                "ocv": asdict(s.ocv),
            }
            for s in sset.scenarios
        ],
    }


def dict_to_scenarios(payload: dict[str, Any]) -> list[Scenario]:
    """Rebuild Scenario objects from a serialized scenario DB.

    Used by the STA driver when given a prebuilt scenario JSON via
    --scenario-db. Validates the schema and rejects blocked sets.
    """
    schema = payload.get("schema")
    if schema != SCHEMA:
        raise ValueError(f"scenario DB has schema '{schema}'; expected {SCHEMA}")
    if payload.get("blocked"):
        raise ValueError(
            f"scenario DB for node '{payload.get('node_id')}' is blocked: "
            f"{payload.get('blocked_reason')}"
        )
    out: list[Scenario] = []
    for s in payload.get("scenarios", []):
        dc = s["delay_corner"]
        rc = s["rc_corner"]
        ocv = s["ocv"]
        out.append(
            Scenario(
                name=str(s["name"]),
                mode=str(s["mode"]),
                analysis_type=str(s["analysis_type"]),
                delay_corner=DelayCorner(
                    name=str(dc["name"]),
                    process=str(dc["process"]),
                    voltage_v=float(dc["voltage_v"]),
                    temperature_c=float(dc["temperature_c"]),
                    role=str(dc["role"]),
                    liberty=str(dc["liberty"]),
                ),
                rc_corner=RcCorner(
                    name=str(rc["name"]),
                    role=str(rc["role"]),
                    view=rc.get("view"),
                ),
                ocv=OcvModel(
                    kind=str(ocv["kind"]),
                    late_derate=float(ocv["late_derate"]),
                    early_derate=float(ocv["early_derate"]),
                    lvf_declared=bool(ocv["lvf_declared"]),
                ),
            )
        )
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--node-id",
        required=True,
        help=f"one of: {', '.join(sorted(KNOWN_NODES))}",
    )
    parser.add_argument("--out", help="write scenario DB JSON here (default: stdout)")
    args = parser.parse_args()

    try:
        sset = build_scenario_set(args.node_id)
    except (FileNotFoundError, ValueError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1

    payload = scenario_set_to_dict(sset)
    text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    if args.out:
        out_path = Path(args.out)
        if not out_path.is_absolute():
            out_path = (ROOT / args.out).resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text)
        if sset.blocked:
            print(
                f"BLOCKED: node '{args.node_id}' scenario set is empty "
                f"({sset.blocked_reason}); manifest written: {out_path}"
            )
        else:
            print(
                f"PASS: {len(sset.scenarios)} scenarios for node "
                f"'{args.node_id}' written: {out_path}"
            )
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
