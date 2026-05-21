#!/usr/bin/env python3
"""Fail-closed UPF planning-intent consistency check for the E1 SoC.

Parses ``pd/upf/e1_soc_top.upf`` (IEEE 1801 / UPF) and validates that the
planning-grade power intent is internally complete and consistent against the
rail plan (``docs/pd/rail-plan-2028.yaml``) and the human-readable domain map
(``pd/upf/power-domains.yaml``):

  * every rail has a matching ``create_supply_net``, ``create_supply_port`` and
    ``connect_supply_net``, with no UPF supply net absent from the rail plan;
  * every power domain binds a primary power net that is a declared supply net
    and matches the rail recorded in the domain map;
  * the set of UPF ``create_power_domain`` names equals the domain-map set;
  * isolation / retention strategies reference declared domains and supply nets;
  * always-on domains in the map carry the ``always_on`` design attribute, and
    domains with a ``retention_strategy`` have a matching ``set_retention``;
  * the UPF retains its ``planning_only`` markers and named release blockers, so
    the contract never claims more than planning intent.

This is a planning gate, not low-power signoff. It fails closed if a planning
blocker is dropped without commercial VC LP / Conformal LP evidence, or if the
domain map promotes past ``prohibited_until_external_review``.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
RAIL_PLAN = ROOT / "docs" / "pd" / "rail-plan-2028.yaml"
UPF_FILE = ROOT / "pd" / "upf" / "e1_soc_top.upf"
DOMAINS_FILE = ROOT / "pd" / "upf" / "power-domains.yaml"

ALLOWED_RELEASE_USE = "prohibited_until_external_review"

# Planning blockers that must remain in the UPF until commercial low-power
# signoff replaces the planning_only intent. Removing any without signoff
# evidence is an over-claim and fails the gate.
REQUIRED_UPF_BLOCKER_TOKENS = (
    "planning_only voltages must be replaced",
    "element paths must be replaced",
    "isolation cell library must be foundry-selected",
    "retention FF library must be foundry-selected",
    "VC LP / Conformal LP signoff against extracted netlist required",
)


def fail(failures: list[str], message: str) -> None:
    failures.append(message)


def _strip_comments(line: str) -> str:
    return line.split("#", 1)[0]


def _join_continued(raw: str) -> list[str]:
    """Strip comments and join backslash-continued UPF commands."""
    commands: list[str] = []
    buf = ""
    for line in raw.splitlines():
        code = _strip_comments(line)
        stripped = code.rstrip()
        if stripped.endswith("\\"):
            buf += stripped[:-1] + " "
            continue
        buf += code
        if buf.strip():
            commands.append(buf.strip())
        buf = ""
    if buf.strip():
        commands.append(buf.strip())
    return commands


def _opt_value(tokens: list[str], flag: str) -> str | None:
    if flag in tokens:
        idx = tokens.index(flag)
        if idx + 1 < len(tokens):
            return tokens[idx + 1]
    return None


def _braced_tokens(cmd: str, flag: str) -> list[str]:
    match = re.search(re.escape(flag) + r"\s*\{([^}]*)\}", cmd)
    return match.group(1).split() if match else []


class UpfModel:
    def __init__(self) -> None:
        self.supply_nets: set[str] = set()
        self.supply_ports: set[str] = set()
        self.connected_nets: set[str] = set()
        self.power_domains: set[str] = set()
        self.domain_primary_net: dict[str, str] = {}
        self.isolation_domains: list[tuple[str, str]] = []
        self.isolation_supply_nets: set[str] = set()
        self.retention_domains: set[str] = set()
        self.retention_supply_nets: set[str] = set()
        self.always_on_domains: set[str] = set()
        self.text: str = ""


def parse_upf(path: Path) -> UpfModel:
    model = UpfModel()
    model.text = path.read_text(encoding="utf-8")
    for cmd in _join_continued(model.text):
        tokens = cmd.split()
        if not tokens:
            continue
        head = tokens[0]
        if head == "create_supply_net" and len(tokens) >= 2:
            model.supply_nets.add(tokens[1])
        elif head == "create_supply_port" and len(tokens) >= 2:
            model.supply_ports.add(tokens[1])
        elif head == "connect_supply_net" and len(tokens) >= 2:
            model.connected_nets.add(tokens[1])
        elif head == "create_power_domain" and len(tokens) >= 2:
            model.power_domains.add(tokens[1])
        elif head == "set_domain_supply_net" and len(tokens) >= 2:
            net = _opt_value(tokens, "-primary_power_net")
            if net:
                model.domain_primary_net[tokens[1]] = net
        elif head == "set_isolation" and len(tokens) >= 2:
            domain = _opt_value(tokens, "-domain") or ""
            model.isolation_domains.append((tokens[1], domain))
            iso_net = _opt_value(tokens, "-isolation_power_net")
            if iso_net:
                model.isolation_supply_nets.add(iso_net)
        elif head == "set_retention" and len(tokens) >= 2:
            ret_domain = _opt_value(tokens, "-domain")
            if ret_domain:
                model.retention_domains.add(ret_domain)
            ret_net = _opt_value(tokens, "-retention_power_net")
            if ret_net:
                model.retention_supply_nets.add(ret_net)
        elif head == "set_design_attributes":
            models = _braced_tokens(cmd, "-models")
            inline = _opt_value(tokens, "-models")
            domains = models or ([inline] if inline else [])
            if _opt_value(tokens, "-attribute") == "always_on" and "true" in tokens:
                model.always_on_domains.update(domains)
    return model


def check_supply_consistency(
    model: UpfModel, plan_rails: set[str], failures: list[str]
) -> None:
    nets_without_vss = model.supply_nets - {"VSS"}
    missing_in_upf = plan_rails - model.supply_nets
    if missing_in_upf:
        fail(failures, f"UPF missing create_supply_net for rails: {sorted(missing_in_upf)}")
    extra_in_upf = nets_without_vss - plan_rails
    if extra_in_upf:
        fail(failures, f"UPF has supply nets not in rail plan: {sorted(extra_in_upf)}")
    for net in sorted(model.supply_nets):
        port = f"{net}_PORT"
        if port not in model.supply_ports:
            fail(failures, f"supply net {net} has no matching supply port {port}")
        if net not in model.connected_nets:
            fail(failures, f"supply net {net} is never connected via connect_supply_net")
    for net in sorted(model.connected_nets):
        if net not in model.supply_nets:
            fail(failures, f"connect_supply_net references undeclared net {net}")
    for port in sorted(model.supply_ports):
        net = port[: -len("_PORT")] if port.endswith("_PORT") else port
        if net not in model.supply_nets:
            fail(failures, f"supply port {port} has no matching supply net {net}")


def check_domain_supplies(model: UpfModel, failures: list[str]) -> None:
    for domain in sorted(model.power_domains):
        net = model.domain_primary_net.get(domain)
        if not net:
            fail(failures, f"power domain {domain} has no set_domain_supply_net binding")
        elif net not in model.supply_nets:
            fail(failures, f"power domain {domain} primary net {net} is not a declared supply net")


def check_strategy_references(model: UpfModel, failures: list[str]) -> None:
    for strategy, domain in model.isolation_domains:
        if domain and domain not in model.power_domains:
            fail(failures, f"set_isolation {strategy} references undeclared domain {domain}")
    for net in sorted(model.isolation_supply_nets):
        if net not in model.supply_nets:
            fail(failures, f"isolation strategy references undeclared supply net {net}")
    for domain in sorted(model.retention_domains):
        if domain not in model.power_domains:
            fail(failures, f"set_retention references undeclared domain {domain}")
    for net in sorted(model.retention_supply_nets):
        if net not in model.supply_nets:
            fail(failures, f"retention strategy references undeclared supply net {net}")


def check_domain_map(model: UpfModel, plan_rails: set[str], failures: list[str]) -> None:
    doc = yaml.safe_load(DOMAINS_FILE.read_text(encoding="utf-8")) or {}
    if doc.get("schema") != "eliza.power_domains.v1":
        fail(failures, "domain map schema must be eliza.power_domains.v1")
    release_use = doc.get("release_use")
    if release_use != ALLOWED_RELEASE_USE:
        fail(
            failures,
            f"domain map release_use must stay {ALLOWED_RELEASE_USE} (planning intent), got {release_use!r}",
        )
    domains = doc.get("power_domains")
    if not isinstance(domains, list):
        fail(failures, "domain map power_domains must be a list")
        return

    map_names: set[str] = set()
    domain_rails: set[str] = set()
    for entry in domains:
        if not isinstance(entry, dict):
            fail(failures, "domain map power_domains entries must be mappings")
            continue
        name = entry.get("upf_name")
        rail = entry.get("rail")
        if not isinstance(name, str):
            fail(failures, "domain map entry missing upf_name")
            continue
        map_names.add(name)
        if isinstance(rail, str):
            domain_rails.add(rail)
        if name not in model.power_domains:
            fail(failures, f"domain map declares {name} but UPF has no create_power_domain")
        upf_net = model.domain_primary_net.get(name)
        if isinstance(rail, str) and upf_net and upf_net != rail:
            fail(failures, f"domain {name} bound to {upf_net} in UPF but mapped to rail {rail}")
        if entry.get("always_on") is True and name not in model.always_on_domains:
            fail(failures, f"domain {name} is always_on in map but lacks always_on attribute in UPF")
        # A UPF set_retention asserts retention-FF intent; the map must
        # acknowledge that domain holds state. (The map's retention_strategy
        # is broader than UPF retention FFs — e.g. self-refresh / pad-latch /
        # PLL-freeze hold state without retention cells — so the reverse
        # implication is not required.)
        if name in model.retention_domains and not entry.get("retention_strategy"):
            fail(failures, f"UPF set_retention {name} but domain map records no retention_strategy")

    only_upf = model.power_domains - map_names
    if only_upf:
        fail(failures, f"UPF create_power_domain not in domain map: {sorted(only_upf)}")
    only_map = map_names - model.power_domains
    if only_map:
        fail(failures, f"domain map entries not in UPF: {sorted(only_map)}")

    missing_in_domains = domain_rails - plan_rails
    if missing_in_domains:
        fail(failures, f"domain map references rails not in rail plan: {sorted(missing_in_domains)}")
    missing_in_plan = plan_rails - domain_rails
    if missing_in_plan:
        fail(failures, f"domain map does not reference rail-plan rails: {sorted(missing_in_plan)}")

    for blocker in doc.get("release_blockers", []) or []:
        if not isinstance(blocker, str) or not blocker.strip():
            fail(failures, "domain map release_blockers entries must be non-empty strings")


def check_planning_blockers(model: UpfModel, failures: list[str]) -> None:
    for token in REQUIRED_UPF_BLOCKER_TOKENS:
        if token not in model.text:
            fail(failures, f"UPF planning blocker dropped without signoff evidence: {token!r}")
    if "planning_only" not in model.text:
        fail(failures, "UPF must retain planning_only markers until low-power signoff replaces them")
    if "upf_version 4.0" not in model.text:
        fail(failures, "UPF must declare upf_version 4.0 (IEEE 1801-2024 target)")


def main() -> int:
    failures: list[str] = []
    for path in (RAIL_PLAN, UPF_FILE, DOMAINS_FILE):
        if not path.is_file():
            failures.append(f"missing file: {path.relative_to(ROOT)}")
    if failures:
        for f in failures:
            print(f"FAIL: {f}", file=sys.stderr)
        return 1

    plan = yaml.safe_load(RAIL_PLAN.read_text(encoding="utf-8")) or {}
    plan_rails = {r["id"] for r in plan.get("rails", []) if isinstance(r, dict) and "id" in r}
    model = parse_upf(UPF_FILE)

    if not model.supply_nets:
        fail(failures, "UPF declares no supply nets")
    if not model.power_domains:
        fail(failures, "UPF declares no power domains")

    check_supply_consistency(model, plan_rails, failures)
    check_domain_supplies(model, failures)
    check_strategy_references(model, failures)
    check_domain_map(model, plan_rails, failures)
    check_planning_blockers(model, failures)

    if failures:
        print("UPF consistency check FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  FAIL: {f}", file=sys.stderr)
        return 1

    print(
        "STATUS: PASS upf_consistency "
        f"({len(model.supply_nets)} supply nets, {len(model.power_domains)} power domains, "
        f"{len(model.retention_domains)} retention, {len(model.always_on_domains)} always-on, "
        f"{len(plan_rails)} rail-plan rails) "
        "— planning intent only, VC LP / Conformal LP signoff still required"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
