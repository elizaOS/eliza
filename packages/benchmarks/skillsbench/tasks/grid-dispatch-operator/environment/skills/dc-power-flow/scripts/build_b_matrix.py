#!/usr/bin/env python3
"""Build susceptance matrix (B) for DC power flow analysis."""

import numpy as np


def build_susceptance_matrix(branches, buses):
    """
    Build the susceptance matrix from branch data.

    Args:
        branches: Array of branch data (MATPOWER format)
                  Each row: [from_bus, to_bus, r, x, b, rateA, ...]
        buses: Array of bus data (needed for bus number mapping)

    Returns:
        B: n_bus x n_bus susceptance matrix
        branch_susceptances: List of susceptance values for each branch
        bus_num_to_idx: Mapping from bus numbers to 0-indexed positions
    """
    n_bus = len(buses)

    # Create bus number to index mapping (handles non-contiguous bus numbering)
    bus_num_to_idx = {int(buses[i, 0]): i for i in range(n_bus)}

    B = np.zeros((n_bus, n_bus))
    branch_susceptances = []

    for br in branches:
        f = bus_num_to_idx[int(br[0])]  # Map bus number to 0-indexed
        t = bus_num_to_idx[int(br[1])]
        x = br[3]  # Reactance at index 3

        if x != 0:
            b = 1.0 / x  # Susceptance
        else:
            b = 0

        branch_susceptances.append(b)

        if x != 0:
            # Diagonal: positive (sum of incident susceptances)
            B[f, f] += b
            B[t, t] += b
            # Off-diagonal: negative
            B[f, t] -= b
            B[t, f] -= b

    return B, branch_susceptances, bus_num_to_idx


def calculate_line_flows(branches, branch_susceptances, theta, baseMVA, bus_num_to_idx):
    """
    Calculate power flows on all lines.

    Args:
        branches: Array of branch data
        branch_susceptances: Susceptance of each branch
        theta: Bus voltage angles in radians
        baseMVA: Base power for per-unit conversion
        bus_num_to_idx: Mapping from bus numbers to 0-indexed positions

    Returns:
        List of dicts with from, to, flow_MW, limit_MW, loading_pct
    """
    line_flows = []

    for idx, br in enumerate(branches):
        f = bus_num_to_idx[int(br[0])]  # Map bus number to 0-indexed
        t = bus_num_to_idx[int(br[1])]
        b = branch_susceptances[idx]

        flow_MW = b * (theta[f] - theta[t]) * baseMVA
        limit_MW = br[5]  # RATE_A
        loading_pct = abs(flow_MW) / limit_MW * 100 if limit_MW > 0 else 0

        line_flows.append({
            'from': int(br[0]),
            'to': int(br[1]),
            'flow_MW': flow_MW,
            'limit_MW': limit_MW,
            'loading_pct': loading_pct
        })

    return line_flows


if __name__ == '__main__':
    # Example usage with IEEE 14-bus test data
    import json
    import sys

    if len(sys.argv) < 2:
        print("Usage: build_b_matrix.py <network.json>")
        sys.exit(1)

    with open(sys.argv[1]) as f:
        data = json.load(f)

    buses = np.array(data['bus'])
    branches = np.array(data['branch'])
    n_bus = len(buses)

    B, susceptances, bus_num_to_idx = build_susceptance_matrix(branches, buses)

    print(f"Built {n_bus}x{n_bus} susceptance matrix")
    print(f"Non-zero elements: {np.count_nonzero(B)}")
    print(f"Matrix is symmetric: {np.allclose(B, B.T)}")
