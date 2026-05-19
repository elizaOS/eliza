#!/usr/bin/env python3
"""Verify pd/upf/e1_soc_top.upf matches docs/pd/rail-plan-2028.yaml.

Every rail in the rail plan must have a matching `create_supply_net` and
`create_supply_port` in the UPF. Every power_domain in
pd/upf/power-domains.yaml must reference a rail that exists in the rail plan.
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


def main() -> int:
    failures: list[str] = []
    for path in (RAIL_PLAN, UPF_FILE, DOMAINS_FILE):
        if not path.is_file():
            failures.append(f"missing file: {path.relative_to(ROOT)}")
    if failures:
        for f in failures:
            print(f"FAIL: {f}", file=sys.stderr)
        return 1

    plan = yaml.safe_load(RAIL_PLAN.read_text())
    upf_text = UPF_FILE.read_text()
    domains = yaml.safe_load(DOMAINS_FILE.read_text())

    plan_rails = {r["id"] for r in plan.get("rails", [])}

    supply_nets = set(re.findall(r"^\s*create_supply_net\s+(\w+)", upf_text, re.M))
    supply_ports = set(re.findall(r"^\s*create_supply_port\s+(\w+)_PORT", upf_text, re.M))
    upf_rails = supply_nets & supply_ports
    upf_rails.discard("VSS")

    missing_in_upf = plan_rails - supply_nets
    if missing_in_upf:
        failures.append(f"UPF missing create_supply_net for rails: {sorted(missing_in_upf)}")
    extra_in_upf = supply_nets - plan_rails - {"VSS"}
    if extra_in_upf:
        failures.append(f"UPF has supply nets not in rail plan: {sorted(extra_in_upf)}")

    missing_ports = plan_rails - supply_ports
    if missing_ports:
        failures.append(f"UPF missing create_supply_port for rails: {sorted(missing_ports)}")

    # Domains file rails must be a subset of plan rails.
    domain_rails = {d["rail"] for d in domains.get("power_domains", [])}
    missing_in_domains = domain_rails - plan_rails
    if missing_in_domains:
        failures.append(
            f"power-domains.yaml references rails not in rail plan: {sorted(missing_in_domains)}"
        )
    missing_in_plan = plan_rails - domain_rails
    if missing_in_plan:
        failures.append(
            f"power-domains.yaml does not reference rail plan rails: {sorted(missing_in_plan)}"
        )

    # UPF must declare a create_power_domain per power-domain entry.
    pd_names = set(re.findall(r"^\s*create_power_domain\s+(\w+)", upf_text, re.M))
    domain_names = {d["upf_name"] for d in domains.get("power_domains", [])}
    if pd_names != domain_names:
        only_upf = pd_names - domain_names
        only_yaml = domain_names - pd_names
        if only_upf:
            failures.append(f"UPF create_power_domain not in YAML: {sorted(only_upf)}")
        if only_yaml:
            failures.append(f"power-domains.yaml entries not in UPF: {sorted(only_yaml)}")

    if failures:
        for f in failures:
            print(f"FAIL: {f}", file=sys.stderr)
        return 1
    print(
        f"UPF {UPF_FILE.relative_to(ROOT)} and power-domains "
        f"consistent with rail plan ({len(plan_rails)} rails)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
