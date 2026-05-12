"""
Test cases for AC Optimal Power Flow task.

Validates the agent's solution using:
1. Schema validation (report structure is correct)
2. Feasibility verification (all AC constraints satisfied)
3. Cost consistency checks

Since ACOPF could have multiple locally optimal solutions, we verify:
- The solution is FEASIBLE (satisfies all AC power flow constraints)
- The reported cost matches the MATPOWER polynomial cost function evaluated at the reported dispatch

We do NOT compare individual dispatch values, as these may differ
between valid solutions due to non-convexity.
"""
import json
import math
import os

import numpy as np
import pytest

OUTPUT_FILE = "/root/report.json"
NETWORK_FILE = "/root/network.json"

# Tolerances for numerical comparisons
TOL_POWER_BALANCE = 1.0      # Power balance tolerance (MW/MVAr)
TOL_VOLTAGE = 0.01           # Voltage bound tolerance (pu)
TOL_BRANCH_FLOW = 5.0        # Branch flow limit tolerance (MVA)
TOL_GEN_BOUND = 1.0          # Generator bound tolerance (MW/MVAr)
TOL_ANGLE_DEG = 0.1           # Angle tolerance (deg)
TOL_COST = 1e-2               # Cost self-consistency tolerance ($/hr)
TOL_OPTIMALITY_GAP_REL = 0.10  # +/- 10% objective gap vs solver benchmark (relative)


def _deg2rad(deg: float) -> float:
    return deg * math.pi / 180.0


def _compute_branch_flows_pu(Vm, Va, br, bus_id_to_idx):
    """
    Compute branch flows in per-unit (P_ij, Q_ij, P_ji, Q_ji) using the exact
    pi-model equations in acopf-math-model.md (matching MATPOWER branch fields).
    """
    # MATPOWER: [fbus, tbus, r, x, b, rateA, rateB, rateC, ratio, angle, status, angmin, angmax]
    r = br[2]
    x = br[3]
    bc = br[4]
    # Match solve.sh: treat very small ratios as "no transformer" (ratio=1)
    ratio = br[8] if abs(br[8]) >= 1e-12 else 1.0
    shift = _deg2rad(br[9])

    # Series admittance y = 1/(r + jx) = g + jb
    if abs(r) < 1e-12 and abs(x) < 1e-12:
        g = 0.0
        b = 0.0
    else:
        denom = r * r + x * x
        g = r / denom
        b = -x / denom

    f = bus_id_to_idx[int(br[0])]
    t = bus_id_to_idx[int(br[1])]

    Vm_i = Vm[f]
    Vm_j = Vm[t]
    Va_i = Va[f]
    Va_j = Va[t]

    inv_t = 1.0 / ratio
    inv_t2 = inv_t * inv_t

    # i -> j
    delta = Va_i - Va_j - shift
    c = math.cos(delta)
    s = math.sin(delta)
    P_ij = g * Vm_i * Vm_i * inv_t2 - Vm_i * Vm_j * inv_t * (g * c + b * s)
    Q_ij = -(b + bc / 2.0) * Vm_i * Vm_i * inv_t2 - Vm_i * Vm_j * inv_t * (g * s - b * c)

    # j -> i
    delta2 = Va_j - Va_i + shift
    c2 = math.cos(delta2)
    s2 = math.sin(delta2)
    P_ji = g * Vm_j * Vm_j - Vm_i * Vm_j * inv_t * (g * c2 + b * s2)
    Q_ji = -(b + bc / 2.0) * Vm_j * Vm_j - Vm_i * Vm_j * inv_t * (g * s2 - b * c2)

    return P_ij, Q_ij, P_ji, Q_ji


def _extract_solution_arrays(report, network):
    """
    Returns (Vm, Va, Pg, Qg) aligned to network ordering.
    Vm in pu, Va in radians, Pg/Qg in MW/MVAr.
    """
    buses = network["bus"]
    gens = network["gen"]
    n_bus = len(buses)
    n_gen = len(gens)

    bus_ids = [int(b[0]) for b in buses]
    bus_id_to_idx = {bid: i for i, bid in enumerate(bus_ids)}

    Vm = np.zeros(n_bus, dtype=float)
    Va = np.zeros(n_bus, dtype=float)
    for b in report["buses"]:
        i = bus_id_to_idx[int(b["id"])]
        Vm[i] = float(b["vm_pu"])
        Va[i] = _deg2rad(float(b["va_deg"]))

    # Generators are expected to be 1..n_gen ids
    Pg = np.zeros(n_gen, dtype=float)
    Qg = np.zeros(n_gen, dtype=float)
    for g in report["generators"]:
        idx = int(g["id"]) - 1
        Pg[idx] = float(g["pg_MW"])
        Qg[idx] = float(g["qg_MVAr"])

    return Vm, Va, Pg, Qg, bus_id_to_idx


def _solve_acopf_optimal_cost(network: dict) -> float:
    """
    Solve the ACOPF (same formulation as acopf-math-model.md) to obtain a
    benchmark objective value.

    Uses CasADi + IPOPT (installed by tests/test.sh).
    """
    try:
        import casadi as ca  # type: ignore
    except Exception as e:  # pragma: no cover
        raise RuntimeError(
            "CasADi is required for the optimality-gap test. "
            "Ensure tests install casadi (e.g., via tests/test.sh)."
        ) from e

    baseMVA = float(network["baseMVA"])
    bus = np.array(network["bus"], dtype=float)
    gen = np.array(network["gen"], dtype=float)
    branch = np.array(network["branch"], dtype=float)
    gencost = np.array(network["gencost"], dtype=float)

    n_bus = int(bus.shape[0])
    n_gen = int(gen.shape[0])
    n_branch = int(branch.shape[0])

    bus_ids = bus[:, 0].astype(int)
    bus_type = bus[:, 1].astype(int)
    bus_id_to_idx = {int(bus_ids[i]): i for i in range(n_bus)}

    Pd = bus[:, 2] / baseMVA
    Qd = bus[:, 3] / baseMVA
    Gs = bus[:, 4] / baseMVA
    Bs = bus[:, 5] / baseMVA
    Vmax = bus[:, 11]
    Vmin = bus[:, 12]

    # Initial bus voltage guess (MATPOWER VM/VA columns)
    Vm0_bus = np.clip(bus[:, 7], Vmin, Vmax)
    Va0_bus = np.array([_deg2rad(float(a)) for a in bus[:, 8]], dtype=float)

    gen_bus = np.array([bus_id_to_idx[int(b)] for b in gen[:, 0]], dtype=int)
    Pg0 = gen[:, 1] / baseMVA
    Qg0 = gen[:, 2] / baseMVA
    Qmax = gen[:, 3] / baseMVA
    Qmin = gen[:, 4] / baseMVA
    Pmax = gen[:, 8] / baseMVA
    Pmin = gen[:, 9] / baseMVA

    # gencost: [model, startup, shutdown, n, c2, c1, c0]
    c2 = gencost[:, 4]
    c1 = gencost[:, 5]
    c0 = gencost[:, 6]

    # Branch parameters
    f = np.array([bus_id_to_idx[int(x)] for x in branch[:, 0]], dtype=int)
    t = np.array([bus_id_to_idx[int(x)] for x in branch[:, 1]], dtype=int)
    r = branch[:, 2]
    x = branch[:, 3]
    bc = branch[:, 4]
    rate_pu = branch[:, 5] / baseMVA
    tap = np.where(np.abs(branch[:, 8]) < 1e-12, 1.0, branch[:, 8])
    shift = np.array([_deg2rad(float(a)) for a in branch[:, 9]], dtype=float)
    angmin = np.array([_deg2rad(float(a)) for a in branch[:, 11]], dtype=float)
    angmax = np.array([_deg2rad(float(a)) for a in branch[:, 12]], dtype=float)

    # Series admittance y = 1/(r+jx) = g + jb
    g = np.zeros(n_branch, dtype=float)
    bser = np.zeros(n_branch, dtype=float)
    for br_idx in range(n_branch):
        if abs(r[br_idx]) < 1e-12 and abs(x[br_idx]) < 1e-12:
            g[br_idx] = 0.0
            bser[br_idx] = 0.0
        else:
            denom = r[br_idx] * r[br_idx] + x[br_idx] * x[br_idx]
            g[br_idx] = r[br_idx] / denom
            bser[br_idx] = -x[br_idx] / denom

    # Decision variables
    Vm = ca.MX.sym("Vm", n_bus)
    Va = ca.MX.sym("Va", n_bus)
    Pg = ca.MX.sym("Pg", n_gen)
    Qg = ca.MX.sym("Qg", n_gen)

    # Objective (in $/hr, using Pg in MW)
    Pg_MW = Pg * baseMVA
    obj = ca.sum1(ca.DM(c2) * (Pg_MW**2) + ca.DM(c1) * Pg_MW + ca.DM(c0))

    # Branch flows (per unit), aggregated per bus
    P_out = [ca.MX(0) for _ in range(n_bus)]
    Q_out = [ca.MX(0) for _ in range(n_bus)]

    Pij = [None] * n_branch
    Qij = [None] * n_branch
    Pji = [None] * n_branch
    Qji = [None] * n_branch

    for br_idx in range(n_branch):
        i = int(f[br_idx])
        j = int(t[br_idx])
        inv_t = 1.0 / float(tap[br_idx])
        inv_t2 = inv_t * inv_t

        delta_ij = Va[i] - Va[j] - float(shift[br_idx])
        cth = ca.cos(delta_ij)
        sth = ca.sin(delta_ij)
        P_ij = g[br_idx] * Vm[i] ** 2 * inv_t2 - Vm[i] * Vm[j] * inv_t * (
            g[br_idx] * cth + bser[br_idx] * sth
        )
        Q_ij = -(bser[br_idx] + bc[br_idx] / 2.0) * Vm[i] ** 2 * inv_t2 - Vm[i] * Vm[j] * inv_t * (
            g[br_idx] * sth - bser[br_idx] * cth
        )

        delta_ji = Va[j] - Va[i] + float(shift[br_idx])
        c2th = ca.cos(delta_ji)
        s2th = ca.sin(delta_ji)
        P_ji = g[br_idx] * Vm[j] ** 2 - Vm[i] * Vm[j] * inv_t * (
            g[br_idx] * c2th + bser[br_idx] * s2th
        )
        Q_ji = -(bser[br_idx] + bc[br_idx] / 2.0) * Vm[j] ** 2 - Vm[i] * Vm[j] * inv_t * (
            g[br_idx] * s2th - bser[br_idx] * c2th
        )

        Pij[br_idx], Qij[br_idx], Pji[br_idx], Qji[br_idx] = P_ij, Q_ij, P_ji, Q_ji
        P_out[i] += P_ij
        Q_out[i] += Q_ij
        P_out[j] += P_ji
        Q_out[j] += Q_ji

    # Generator aggregation per bus
    Pg_bus = [ca.MX(0) for _ in range(n_bus)]
    Qg_bus = [ca.MX(0) for _ in range(n_bus)]
    for k in range(n_gen):
        i = int(gen_bus[k])
        Pg_bus[i] += Pg[k]
        Qg_bus[i] += Qg[k]

    g_expr = []
    lbg = []
    ubg = []

    # Power balance equalities at each bus
    for i in range(n_bus):
        g_expr.append(Pg_bus[i] - Pd[i] - Gs[i] * (Vm[i] ** 2) - P_out[i])
        lbg.append(0.0)
        ubg.append(0.0)
    for i in range(n_bus):
        g_expr.append(Qg_bus[i] - Qd[i] + Bs[i] * (Vm[i] ** 2) - Q_out[i])
        lbg.append(0.0)
        ubg.append(0.0)

    # Reference bus angle(s): Va = 0 for all BUS_TYPE==3 buses
    ref_idxs = np.where(bus_type == 3)[0]
    if len(ref_idxs) == 0:
        raise RuntimeError("Network has no reference (slack) bus (BUS_TYPE==3)")
    for idx in ref_idxs:
        g_expr.append(Va[int(idx)])
        lbg.append(0.0)
        ubg.append(0.0)

    # Branch apparent power constraints (both directions), only if rateA>0
    for br_idx in range(n_branch):
        if float(rate_pu[br_idx]) > 0:
            limit2 = float(rate_pu[br_idx] ** 2)
            g_expr.append(Pij[br_idx] ** 2 + Qij[br_idx] ** 2)
            lbg.append(0.0)
            ubg.append(limit2)
            g_expr.append(Pji[br_idx] ** 2 + Qji[br_idx] ** 2)
            lbg.append(0.0)
            ubg.append(limit2)

    # Angle difference bounds: angmin <= Va_i - Va_j <= angmax
    for br_idx in range(n_branch):
        g_expr.append(Va[int(f[br_idx])] - Va[int(t[br_idx])])
        lbg.append(float(angmin[br_idx]))
        ubg.append(float(angmax[br_idx]))

    x = ca.vertcat(Vm, Va, Pg, Qg)
    gvec = ca.vertcat(*g_expr)

    # Variable bounds
    lbx = np.concatenate([Vmin, -math.pi * np.ones(n_bus), Pmin, Qmin]).tolist()
    ubx = np.concatenate([Vmax, math.pi * np.ones(n_bus), Pmax, Qmax]).tolist()

    # Candidate starting points (take best objective)
    x0_flat = np.concatenate(
        [
            np.ones(n_bus),
            np.zeros(n_bus),
            np.clip(Pg0, Pmin, Pmax),
            np.clip(Qg0, Qmin, Qmax),
        ]
    )
    x0_bus = np.concatenate(
        [
            Vm0_bus,
            Va0_bus,
            np.clip(Pg0, Pmin, Pmax),
            np.clip(Qg0, Qmin, Qmax),
        ]
    )
    for idx in ref_idxs:
        x0_flat[n_bus + int(idx)] = 0.0
        x0_bus[n_bus + int(idx)] = 0.0

    nlp = {"x": x, "f": obj, "g": gvec}
    opts = {
        "ipopt.print_level": 0,
        "ipopt.sb": "yes",
        "ipopt.max_iter": 2000,
        "ipopt.tol": 1e-7,
        "ipopt.acceptable_tol": 1e-5,
        "ipopt.mu_strategy": "adaptive",
        "print_time": False,
    }
    solver = ca.nlpsol("solver", "ipopt", nlp, opts)

    best_obj = None
    errors = []
    for x0 in (x0_bus, x0_flat):
        try:
            sol = solver(x0=x0.tolist(), lbx=lbx, ubx=ubx, lbg=lbg, ubg=ubg)
            obj_val = float(sol["f"])
            if best_obj is None or obj_val < best_obj:
                best_obj = obj_val
        except Exception as e:  # pragma: no cover
            errors.append(repr(e))
            continue

    if best_obj is None:
        raise RuntimeError("Failed to solve ACOPF with IPOPT. Errors:\n" + "\n".join(errors[:5]))

    return best_obj


# =============================================================================
# Fixtures
# =============================================================================

@pytest.fixture(scope="module")
def report():
    """Load the agent's report.json."""
    assert os.path.exists(OUTPUT_FILE), f"Output file {OUTPUT_FILE} does not exist"
    with open(OUTPUT_FILE, encoding="utf-8") as f:
        return json.load(f)


@pytest.fixture(scope="module")
def network():
    """Load the network data."""
    with open(NETWORK_FILE, encoding="utf-8") as f:
        return json.load(f)


@pytest.fixture(scope="module")
def parsed_network(network):
    """Parse network into convenient data structures."""
    baseMVA = network["baseMVA"]
    buses = network["bus"]
    gens = network["gen"]
    branches = network["branch"]
    gencost = network["gencost"]

    n_bus = len(buses)
    n_gen = len(gens)
    n_branch = len(branches)

    # Bus number to index mapping
    bus_num_to_idx = {int(buses[i][0]): i for i in range(n_bus)}

    return {
        "baseMVA": baseMVA,
        "buses": buses,
        "gens": gens,
        "branches": branches,
        "gencost": gencost,
        "n_bus": n_bus,
        "n_gen": n_gen,
        "n_branch": n_branch,
        "bus_num_to_idx": bus_num_to_idx
    }


@pytest.fixture(scope="module")
def acopf_benchmark_cost(network) -> float:
    """Solve ACOPF in-test and return the benchmark optimal objective value."""
    return _solve_acopf_optimal_cost(network)


# =============================================================================
# Schema Validation - Verify report structure
# =============================================================================
class TestSchema:
    """Verify report has correct structure and all required fields."""

    def test_top_level_fields(self, report):
        """Check all required top-level fields exist."""
        required = ["summary", "generators", "buses", "most_loaded_branches", "feasibility_check"]
        for field in required:
            assert field in report, f"Missing top-level field: {field}"

    def test_summary_fields(self, report):
        """Check summary has all required fields."""
        summary = report["summary"]
        required = [
            "total_cost_per_hour",
            "total_load_MW",
            "total_load_MVAr",
            "total_generation_MW",
            "total_generation_MVAr",
            "total_losses_MW",
            "solver_status"
        ]
        for field in required:
            assert field in summary, f"Missing summary field: {field}"

    def test_generator_count(self, report, parsed_network):
        """Verify all generators are reported."""
        n_gen = parsed_network["n_gen"]
        assert len(report["generators"]) == n_gen, \
            f"Expected {n_gen} generators, got {len(report['generators'])}"

    def test_generator_fields(self, report):
        """Verify each generator has required fields."""
        required = ["id", "bus", "pg_MW", "qg_MVAr", "pmin_MW", "pmax_MW", "qmin_MVAr", "qmax_MVAr"]
        for gen in report["generators"]:
            for field in required:
                assert field in gen, f"Generator {gen.get('id', '?')} missing field: {field}"

    def test_bus_count(self, report, parsed_network):
        """Verify all buses are reported."""
        n_bus = parsed_network["n_bus"]
        assert len(report["buses"]) == n_bus, \
            f"Expected {n_bus} buses, got {len(report['buses'])}"

    def test_bus_fields(self, report):
        """Verify each bus has required fields."""
        required = ["id", "vm_pu", "va_deg", "vmin_pu", "vmax_pu"]
        for bus in report["buses"]:
            for field in required:
                assert field in bus, f"Bus {bus.get('id', '?')} missing field: {field}"

    def test_most_loaded_branches(self, report):
        """Verify most_loaded_branches has correct structure."""
        branches = report["most_loaded_branches"]
        assert isinstance(branches, list), "most_loaded_branches must be a list"
        assert len(branches) == 10, f"Expected 10 most loaded branches, got {len(branches)}"

        required = ["from_bus", "to_bus", "loading_pct", "flow_from_MVA", "flow_to_MVA", "limit_MVA"]
        for br in branches:
            for field in required:
                assert field in br, f"Branch missing field: {field}"

        # Should be in descending order
        loadings = [br["loading_pct"] for br in branches]
        assert loadings == sorted(loadings, reverse=True), \
            "most_loaded_branches not in descending order by loading_pct"

    def test_feasibility_check_fields(self, report):
        """Verify feasibility_check has required fields."""
        fc = report["feasibility_check"]
        required = ["max_p_mismatch_MW", "max_q_mismatch_MVAr", "max_voltage_violation_pu", "max_branch_overload_MVA"]
        for field in required:
            assert field in fc, f"Missing feasibility_check field: {field}"


# =============================================================================
# Feasibility Tests - Solution must satisfy all AC constraints
# =============================================================================
class TestFeasibility:
    """Verify the solution satisfies all physical constraints."""

    def test_solver_status(self, report):
        """Solver should report optimal or feasible status."""
        status = report["summary"]["solver_status"].lower()
        assert "optimal" in status or "acceptable" in status or "feasible" in status, \
            f"Solver did not find optimal/feasible solution: {status}"

    def test_voltage_bounds(self, report, parsed_network):
        """All bus voltages must be within bounds."""
        buses = parsed_network["buses"]
        bus_results = {b["id"]: b for b in report["buses"]}

        violations = []
        for bus in buses:
            bus_id = int(bus[0])
            vmin, vmax = bus[12], bus[11]

            if bus_id not in bus_results:
                violations.append(f"Bus {bus_id} not in results")
                continue

            vm = bus_results[bus_id]["vm_pu"]
            if vm < vmin - TOL_VOLTAGE:
                violations.append(f"Bus {bus_id}: Vm={vm:.4f} < Vmin={vmin}")
            if vm > vmax + TOL_VOLTAGE:
                violations.append(f"Bus {bus_id}: Vm={vm:.4f} > Vmax={vmax}")

        assert len(violations) == 0, "Voltage violations:\n" + "\n".join(violations[:10])

    def test_generator_p_bounds(self, report, parsed_network):
        """All generator active power outputs must be within bounds."""
        gens = parsed_network["gens"]

        violations = []
        for k, gen_data in enumerate(report["generators"]):
            pmin = gens[k][9]
            pmax = gens[k][8]
            pg = gen_data["pg_MW"]

            if pg < pmin - TOL_GEN_BOUND:
                violations.append(f"Gen {gen_data['id']}: Pg={pg:.2f} < Pmin={pmin:.2f}")
            if pg > pmax + TOL_GEN_BOUND:
                violations.append(f"Gen {gen_data['id']}: Pg={pg:.2f} > Pmax={pmax:.2f}")

        assert len(violations) == 0, "Generator P violations:\n" + "\n".join(violations[:10])

    def test_generator_q_bounds(self, report, parsed_network):
        """All generator reactive power outputs must be within bounds."""
        gens = parsed_network["gens"]

        violations = []
        for k, gen_data in enumerate(report["generators"]):
            qmin = gens[k][4]
            qmax = gens[k][3]
            qg = gen_data["qg_MVAr"]

            if qg < qmin - TOL_GEN_BOUND:
                violations.append(f"Gen {gen_data['id']}: Qg={qg:.2f} < Qmin={qmin:.2f}")
            if qg > qmax + TOL_GEN_BOUND:
                violations.append(f"Gen {gen_data['id']}: Qg={qg:.2f} > Qmax={qmax:.2f}")

        assert len(violations) == 0, "Generator Q violations:\n" + "\n".join(violations[:10])

    def test_reference_angle(self, report, network):
        """Reference (slack) bus angle(s) must be 0 degrees."""
        buses = network["bus"]
        ref_bus_ids = [int(b[0]) for b in buses if int(b[1]) == 3]
        assert ref_bus_ids, "Network has no reference (slack) bus (BUS_TYPE==3)"

        bus_map = {b["id"]: b for b in report["buses"]}
        violations = []
        for ref_bus_id in ref_bus_ids:
            if ref_bus_id not in bus_map:
                violations.append(f"Reference bus {ref_bus_id} missing from report")
                continue
            va_deg = float(bus_map[ref_bus_id]["va_deg"])
            if abs(va_deg) > TOL_ANGLE_DEG:
                violations.append(f"Reference bus {ref_bus_id}: Va={va_deg:.6f} deg (expected 0)")

        assert not violations, "Reference angle violations:\n" + "\n".join(violations)

    def test_power_balance_acopf(self, report, network):
        """
        Check AC power balance using the formulation in acopf-math-model.md:
          sum_g Sg - sum_d Sd - (Ys)^*|V|^2 = sum_branch_out S_ij
        """
        baseMVA = float(network["baseMVA"])
        buses = network["bus"]
        gens = network["gen"]
        branches = network["branch"]

        Vm, Va, Pg, Qg, bus_id_to_idx = _extract_solution_arrays(report, network)

        n_bus = len(buses)
        n_gen = len(gens)

        Pd_pu = np.array([b[2] for b in buses]) / baseMVA
        Qd_pu = np.array([b[3] for b in buses]) / baseMVA
        Gs_pu = np.array([b[4] for b in buses]) / baseMVA
        Bs_pu = np.array([b[5] for b in buses]) / baseMVA

        # Generator aggregation per bus (per unit)
        Pg_bus = np.zeros(n_bus, dtype=float)
        Qg_bus = np.zeros(n_bus, dtype=float)
        for k in range(n_gen):
            bus_id = int(gens[k][0])
            i = bus_id_to_idx[bus_id]
            Pg_bus[i] += Pg[k] / baseMVA
            Qg_bus[i] += Qg[k] / baseMVA

        # Branch flow aggregation per bus (per unit)
        P_out = np.zeros(n_bus, dtype=float)
        Q_out = np.zeros(n_bus, dtype=float)

        for br in branches:
            fbus = int(br[0])
            tbus = int(br[1])
            f = bus_id_to_idx[fbus]
            t = bus_id_to_idx[tbus]

            P_ij, Q_ij, P_ji, Q_ji = _compute_branch_flows_pu(Vm, Va, br, bus_id_to_idx)
            P_out[f] += P_ij
            Q_out[f] += Q_ij
            P_out[t] += P_ji
            Q_out[t] += Q_ji

        P_mis = Pg_bus - Pd_pu - Gs_pu * (Vm**2) - P_out
        Q_mis = Qg_bus - Qd_pu + Bs_pu * (Vm**2) - Q_out

        max_p_mis = float(np.max(np.abs(P_mis)) * baseMVA)
        max_q_mis = float(np.max(np.abs(Q_mis)) * baseMVA)

        assert max_p_mis <= TOL_POWER_BALANCE, f"Max P mismatch {max_p_mis:.6f} MW"
        assert max_q_mis <= TOL_POWER_BALANCE, f"Max Q mismatch {max_q_mis:.6f} MVAr"

    def test_branch_limits_and_angle_bounds(self, report, network):
        """Verify branch |S_ij|<=rateA and angmin<=Va_i-Va_j<=angmax for all branches."""
        baseMVA = float(network["baseMVA"])
        branches = network["branch"]

        Vm, Va, _, _, bus_id_to_idx = _extract_solution_arrays(report, network)

        violations = []
        for br in branches:
            rateA = float(br[5])
            angmin = float(br[11])
            angmax = float(br[12])
            fbus = int(br[0])
            tbus = int(br[1])
            f = bus_id_to_idx[fbus]
            t = bus_id_to_idx[tbus]

            delta_deg = (Va[f] - Va[t]) * 180.0 / math.pi
            if delta_deg < angmin - TOL_ANGLE_DEG or delta_deg > angmax + TOL_ANGLE_DEG:
                violations.append(
                    f"Branch {fbus}->{tbus} angle {delta_deg:.3f} not in [{angmin},{angmax}]"
                )

            if rateA > 0:
                P_ij, Q_ij, P_ji, Q_ji = _compute_branch_flows_pu(Vm, Va, br, bus_id_to_idx)
                S_ij = math.sqrt(P_ij * P_ij + Q_ij * Q_ij) * baseMVA
                S_ji = math.sqrt(P_ji * P_ji + Q_ji * Q_ji) * baseMVA
                if S_ij > rateA + TOL_BRANCH_FLOW or S_ji > rateA + TOL_BRANCH_FLOW:
                    violations.append(
                        f"Branch {fbus}<->{tbus} overload: "
                        f"|S_ij|={S_ij:.2f}, |S_ji|={S_ji:.2f} > rateA={rateA:.2f}"
                    )

        assert not violations, "Branch violations:\n" + "\n".join(violations[:20])

    def test_branch_current_limits(self, report, network):
        """
        Verify branch current constraint from acopf-math-model.md:
          |S_ij| <= |V_i| * i^u_ij   for all (i,j) in E U E^R

        This test runs only when the network JSON provides a branch current limit
        field (e.g., an extra branch column described as a current limit in
        network["column_info"]["branch"]).
        """
        # Try to find a branch column that represents a current limit.
        col_info = (network.get("column_info") or {}).get("branch") or {}
        current_limit_col = None
        current_limit_desc = None
        for k, desc in col_info.items():
            if not isinstance(desc, str):
                continue
            d = desc.lower()
            if "current" in d or "i_max" in d or "imax" in d:
                try:
                    current_limit_col = int(k)
                    current_limit_desc = desc
                    break
                except (TypeError, ValueError):
                    continue

        if current_limit_col is None:
            pytest.skip(
                "Network does not provide branch current limits; "
                "skipping |S_ij| <= |V_i| * i^u_ij feasibility check."
            )

        # Only support per-unit current limits explicitly labeled as such.
        if current_limit_desc is not None:
            desc_l = current_limit_desc.lower()
            is_pu = ("pu" in desc_l) or ("p.u" in desc_l) or ("per unit" in desc_l)
            if not is_pu:
                pytest.skip(
                    f"Branch current limit column found but units are unclear ({current_limit_desc!r}); "
                    "skipping current-limit feasibility check."
                )

        branches = network["branch"]
        Vm, Va, _, _, bus_id_to_idx = _extract_solution_arrays(report, network)

        violations = []
        for br in branches:
            if current_limit_col >= len(br):
                violations.append(
                    f"Branch {int(br[0])}->{int(br[1])} missing current limit column {current_limit_col}"
                )
                continue

            i_max_pu = float(br[current_limit_col])
            if i_max_pu <= 0:
                # No current limit specified for this branch.
                continue

            fbus = int(br[0])
            tbus = int(br[1])
            f = bus_id_to_idx[fbus]
            t = bus_id_to_idx[tbus]

            P_ij, Q_ij, P_ji, Q_ji = _compute_branch_flows_pu(Vm, Va, br, bus_id_to_idx)
            S_ij_pu = math.sqrt(P_ij * P_ij + Q_ij * Q_ij)
            S_ji_pu = math.sqrt(P_ji * P_ji + Q_ji * Q_ji)

            # Convert |S| <= |V|*Imax into a current magnitude check: |I| = |S|/|V|.
            Vm_i = float(Vm[f])
            Vm_j = float(Vm[t])
            if Vm_i > 1e-12:
                I_ij_pu = S_ij_pu / Vm_i
                if I_ij_pu > i_max_pu + 1e-3:
                    violations.append(
                        f"Branch {fbus}->{tbus} current {I_ij_pu:.6f} pu > limit {i_max_pu:.6f} pu"
                    )
            if Vm_j > 1e-12:
                I_ji_pu = S_ji_pu / Vm_j
                if I_ji_pu > i_max_pu + 1e-3:
                    violations.append(
                        f"Branch {tbus}->{fbus} current {I_ji_pu:.6f} pu > limit {i_max_pu:.6f} pu"
                    )

        assert not violations, "Branch current-limit violations:\n" + "\n".join(violations[:20])

    def test_internal_consistency_generation(self, report):
        """Total generation should match sum of individual generators."""
        gen_sum_p = sum(g["pg_MW"] for g in report["generators"])
        gen_sum_q = sum(g["qg_MVAr"] for g in report["generators"])

        reported_p = report["summary"]["total_generation_MW"]
        reported_q = report["summary"]["total_generation_MVAr"]

        assert abs(gen_sum_p - reported_p) < TOL_POWER_BALANCE, \
            f"Generation sum {gen_sum_p:.2f} != reported {reported_p:.2f}"
        assert abs(gen_sum_q - reported_q) < TOL_POWER_BALANCE, \
            f"Generation sum {gen_sum_q:.2f} != reported {reported_q:.2f}"

    def test_internal_consistency_losses(self, report):
        """Losses should equal generation minus load."""
        summary = report["summary"]
        computed_losses = summary["total_generation_MW"] - summary["total_load_MW"]
        reported_losses = summary["total_losses_MW"]

        assert abs(computed_losses - reported_losses) < TOL_POWER_BALANCE, \
            f"Computed losses {computed_losses:.2f} != reported {reported_losses:.2f}"

    def test_losses_reasonable(self, report):
        """Losses should be positive and reasonable (typically 1-5% of load)."""
        summary = report["summary"]
        losses = summary["total_losses_MW"]
        load = summary["total_load_MW"]

        assert losses > 0, f"Losses {losses:.2f} should be positive"
        loss_pct = losses / load * 100
        assert loss_pct < 10, f"Losses {loss_pct:.2f}% unreasonably high (>10%)"

    def test_no_voltage_violations(self, report):
        """Reported voltage violation should be zero or near-zero."""
        fc = report["feasibility_check"]
        assert fc["max_voltage_violation_pu"] < TOL_VOLTAGE, \
            f"Voltage violation {fc['max_voltage_violation_pu']:.4f} pu exceeds tolerance"

    def test_no_branch_overloads(self, report):
        """Reported branch overload should be zero or near-zero."""
        fc = report["feasibility_check"]
        assert fc["max_branch_overload_MVA"] < TOL_BRANCH_FLOW, \
            f"Branch overload {fc['max_branch_overload_MVA']:.2f} MVA exceeds tolerance"


# =============================================================================
# Optimality Test - Solution should achieve near-minimum cost
# =============================================================================
class TestOptimality:
    """Verify cost reporting is consistent and near-optimal."""

    def test_cost_is_positive(self, report):
        """Generation cost should be positive."""
        cost = report["summary"]["total_cost_per_hour"]
        assert cost > 0, f"Cost {cost} should be positive"

    def test_cost_matches_gencost(self, report, network):
        """Reported cost must match the cost computed from gencost and Pg."""
        gencost = network["gencost"]

        # gencost: [model, startup, shutdown, n, c2, c1, c0]
        c2 = np.array([row[4] for row in gencost], dtype=float)
        c1 = np.array([row[5] for row in gencost], dtype=float)
        c0 = np.array([row[6] for row in gencost], dtype=float)

        Pg = np.array([float(g["pg_MW"]) for g in report["generators"]], dtype=float)
        computed = float(np.sum(c2 * Pg * Pg + c1 * Pg + c0))
        reported = float(report["summary"]["total_cost_per_hour"])

        assert abs(computed - reported) <= max(TOL_COST, 1e-6 * max(1.0, reported)), \
            f"Cost mismatch: computed={computed:.6f}, reported={reported:.6f}"

    def test_cost_within_10pct_of_solved_acopf(self, report, acopf_benchmark_cost):
        """
        Solve the same ACOPF in-test and require the reported objective to be
        within +/-10% of the benchmark objective.
        """
        benchmark = float(acopf_benchmark_cost)
        reported = float(report["summary"]["total_cost_per_hour"])

        lower = (1.0 - TOL_OPTIMALITY_GAP_REL) * benchmark
        upper = (1.0 + TOL_OPTIMALITY_GAP_REL) * benchmark

        assert lower <= reported <= upper, (
            f"Objective gap too large: reported={reported:.6f}, benchmark={benchmark:.6f}, "
            f"allowed=[{lower:.6f}, {upper:.6f}]"
        )
