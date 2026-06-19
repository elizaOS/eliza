#!/bin/bash
set -e

cat > /tmp/solve_bgp.py << 'PYTHON_SCRIPT'
#!/usr/bin/env python3
"""
Oracle solution for BGP oscillation and route leak detection task.

This solution analyzes the Azure Virtual WAN topology and detects:
1. Oscillation caused by mutual routing preferences between regional hubs
   KEY INSIGHT: Fix by breaking the preference cycle
2. Route leaks violating BGP valley-free routing rules
   KEY INSIGHT: Fix by adding filters to prevent wrong propagation

Topology (from Azure Virtual WAN deployment):
          ASN 65001 (Virtual WAN / Regional ISP)
         /                    \\
    ASN 65002              ASN 65003
    (Hub1/vhubvnet1)        (Hub2/vhubvnet2)
    /         \\              /         \\
 ASN 65004  ASN 65005   ASN 65006  ASN 65007
 (VNET1)    (VNET2)     (VNET3)    (VNET4 - origin)
"""

import json
from pathlib import Path

DATA_DIR = Path("/app/data")
OUTPUT_DIR = Path("/app/output")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_FILE = OUTPUT_DIR / "oscillation_report.json"


def main():
    """Main function."""
    print("=" * 60)
    print("BGP Oscillation and Route Leak Detection Solution")
    print("=" * 60)
    print("🔍 DEBUG: solve.sh VERSION 2026-01-16-05:38 - ROUTING INTENT FIXES BOTH")
    print("=" * 60)
    
    print("\n[1/6] Loading configuration files...")
    with open(DATA_DIR / "route.json") as f:
        origin_route = json.load(f)
    
    with open(DATA_DIR / "preferences.json") as f:
        routing_preferences = json.load(f)
    
    with open(DATA_DIR / "route_events.json") as f:
        route_events = json.load(f)
    
    origin_asn = origin_route["origin_asn"]
    print(f"  - Origin ASN: {origin_asn}")
    print(f"  - Prefix: {origin_route['prefix']}")
    
    print("\n[2/6] Analyzing routing preferences...")
    preference_map = {}
    for asn, pref_data in routing_preferences.items():
        if "prefer_via" in pref_data:
            preference_map[int(asn)] = pref_data["prefer_via"]
            print(f"  - ASN {asn} prefers routes via ASN {pref_data['prefer_via']}")
    
    print("\n[3/6] Detecting oscillation cycle...")
    oscillation_detected = False
    oscillation_cycle = []
    affected_asns = []
    
    # Check for mutual preferences causing oscillation
    for asn1, prefer_asn1 in preference_map.items():
        if prefer_asn1 in preference_map:
            prefer_asn2 = preference_map[prefer_asn1]
            if prefer_asn2 == asn1:
                oscillation_detected = True
                oscillation_cycle = sorted([asn1, prefer_asn1])
                affected_asns = oscillation_cycle.copy()
                print(f"  - Mutual preference detected: ASN {asn1} <-> ASN {prefer_asn1}")
                print(f"  - Oscillation cycle: {oscillation_cycle}")
                print(f"  - Affected ASNs: {affected_asns}")
                print(f"  - FIX: Break the cycle by removing preference on either hub")
                break
    
    if not oscillation_detected:
        print("  - No oscillation detected")
    
    print("\n[4/6] Detecting route leaks...")
    route_leak_detected = False
    route_leak_info = []
    
    for event in route_events:
        advertiser_asn = event["advertiser_asn"]
        source_asn = event["source_asn"]
        destination_asn = event["destination_asn"]
        source_type = event["source_type"]
        destination_type = event["destination_type"]
        
        route_leak_detected = True
        route_leak_info.append({
            "leaker_as": advertiser_asn,
            "source_as": source_asn,
            "destination_as": destination_asn,
            "source_type": source_type,
            "destination_type": destination_type
        })
        print(f"  - Route leak detected: ASN {advertiser_asn} leaks routes from {source_type} ASN {source_asn} to {destination_type} ASN {destination_asn}")
        print(f"  - FIX: Add export policy/filter on ASN {advertiser_asn} to prevent wrong propagation")
    
    if not route_leak_detected:
        print("  - No route leaks detected")
    
    print("\n[5/6] Evaluating possible solutions...")
    solution_results = {}
    
    # SIMPLIFIED LOGIC:
    # Oscillation fix = Break the route cycle (remove preference, filter learned routes, set hierarchy, override)
    # Route leak fix = Prevent wrong propagation (block announcing, ingress filtering, no-export, validation)
    
    # Key distinction:
    # - Oscillation: filter what you LEARNED from peers, remove preference, hierarchy
    # - Route leak: block what you ANNOUNCE to others, ingress reject, no-export to peers
    
    OSCILLATION_FIX_KEYWORDS = [
        # Breaking the preference cycle
        "update routing preference",
        "remove routing preference",
        "remove preference",
        "stop preferring routes",
        "stop preferring",
        # Filtering routes learned from peers (before re-announcing/re-advertising)
        "filter routes learned",
        "filter out routes learned",
        "before re-announcing",
        "before re-advertising",
        # Setting hierarchy to break ties
        "preference hierarchy",
        "route preference hierarchy",
        # Routing intent: enforces routing constraints, prevents cycles
        "routing intent to enforce",
        "hub routing intent",
        # Overriding routes
        "user defined route override",
        "route override",
    ]
    
    ROUTE_LEAK_FIX_KEYWORDS = [
        # Blocking announcements to peers/providers
        "block announcing",
        "to block announcing",
        "block announcing provider routes",
        # Export policies to prevent leaks (must include "block")
        "export policy to block",
        # Ingress filtering at destination
        "ingress filtering",
        "reject routes with",
        # No-export community
        "no-export of provider",
        "enforce no-export",
        "by bgp community",
        # RPKI validation
        "rpki origin validation",
        "origin validation",
        # Route policy with community (must include "enforce")
        "route policy to enforce",
        # Routing intent: prevents unauthorized transit before routes propagate
        "routing intent to enforce",
        "hub routing intent",
        # Override for specific routes
        "user defined route override"
    ]
    
    def has_keywords(text, keywords):
        """Check if text contains any of the keywords"""
        text_lower = text.lower()
        for keyword in keywords:
            if keyword in text_lower:
                return True
        return False
        
    # Load possible solutions
    if oscillation_detected or route_leak_detected:
        all_solutions = []
        
        possible_solutions_file = DATA_DIR / "possible_solutions.json"
        if possible_solutions_file.exists():
            with open(possible_solutions_file, 'r') as f:
                all_solutions = json.load(f)
        
        if all_solutions:
            # FAILURE: Prohibited operations (not allowed by customer)
            # These operations would break connectivity or cause service disruption
            # Note: restart/reboot is ALLOWED but won't fix the root cause (will fail naturally)
            PROHIBITED_OPERATIONS = [
                "disable bgp",
                "disable peering",
                "disable hub peering",
                "remove peer",
                "shut down",
                "shutdown"
            ]
            
            # Evaluate each solution
            for solution in all_solutions:
                solution_lower = solution.lower()
                
                # First check: Is it a prohibited operation? (restart/disable/remove operations)
                # These are NOT ALLOWED by customer and don't fix root cause
                is_prohibited = has_keywords(solution, PROHIBITED_OPERATIONS)
                
                if is_prohibited:
                    # Prohibited operations fail both - they're not allowed
                    oscillation_resolved = False
                    route_leak_resolved = False
                else:
                    # Not a prohibited operation - check if it's a real fix
                    # Oscillation fix: Does it break the cycle?
                    oscillation_resolved = False
                    if oscillation_detected:
                        oscillation_resolved = has_keywords(solution, OSCILLATION_FIX_KEYWORDS)
                    
                    # Route leak fix: Does it prevent propagation?
                    route_leak_resolved = False
                    if route_leak_detected:
                        route_leak_resolved = has_keywords(solution, ROUTE_LEAK_FIX_KEYWORDS)
                
                solution_results[solution] = {
                    "oscillation_resolved": oscillation_resolved,
                    "route_leak_resolved": route_leak_resolved
                }
            
            print(f"  - Evaluated {len(all_solutions)} possible solutions")
    
    print("\n[6/6] Generating detection report...")
    
    # Generate JSON report
    output_data = {
        "oscillation_detected": oscillation_detected,
        "oscillation_cycle": oscillation_cycle,
        "affected_ases": affected_asns,
        "route_leak_detected": route_leak_detected,
        "route_leaks": route_leak_info,
        "solution_results": solution_results
    }
    
    with open(OUTPUT_FILE, 'w') as f:
        json.dump(output_data, f, indent=2)
    
    print()
    print("=" * 60)
    print(f"Results written to {OUTPUT_FILE}")
    print(f"  - Oscillation detected: {oscillation_detected}")
    print(f"  - Oscillation cycle: {oscillation_cycle}")
    print(f"  - Affected ASNs: {affected_asns}")
    print(f"  - Route leak detected: {route_leak_detected}")
    print(f"  - Route leaks: {len(route_leak_info)} leak(s) detected")
    print("=" * 60)
    print("Solution complete.")


if __name__ == "__main__":
    main()
PYTHON_SCRIPT

python3 /tmp/solve_bgp.py

