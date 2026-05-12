import json
import math
import os

import numpy as np
import pytest
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.sparse import coo_matrix


OUTPUT_FILE = "/root/report.json"
CASE_FILE = "/root/network.json"

TOL_POWER_BALANCE_MW = 1e-2
TOL_RESERVE_MW = 1e-2
TOL_GENERATOR_MW = 1e-3
TOL_RAMP_MW = 1e-3
TOL_BINARY = 1e-5
TOL_COST_REL = 1e-4
TOL_COST_ABS = 1e-2
TOL_OPTIMALITY_GAP_REL = 0.10

ACCEPTED_STATUSES = {
    "optimal",
    "feasible",
    "time_limit_feasible",
    "suboptimal_feasible",
    "heuristic_feasible",
}

REQUIRED_CONSTRAINT_CHECKS = {
    "demand_balance",
    "spinning_reserve",
    "reserve_deliverability",
    "generator_limits",
    "must_run",
    "ramping",
    "minimum_up_down",
    "startup_shutdown_logic",
    "initial_conditions",
    "renewable_limits",
    "cost_consistency",
}


def _load_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    assert isinstance(data, dict), f"{path} must contain a JSON object"
    return data


def _require_keys(obj: dict, keys: set[str], label: str) -> None:
    missing = keys - set(obj)
    assert not missing, f"{label} missing keys: {sorted(missing)}"


def _numeric_array(values, length: int, label: str) -> np.ndarray:
    arr = np.asarray(values, dtype=float)
    assert arr.shape == (length,), f"{label} must have length {length}, got shape {arr.shape}"
    assert np.all(np.isfinite(arr)), f"{label} contains non-finite values"
    return arr


def _parse_pglib_uc_case(case: dict) -> dict:
    _require_keys(case, {"time_periods", "demand", "reserves", "thermal_generators", "renewable_generators"}, "case")

    time_periods = int(case["time_periods"])
    assert time_periods > 0, "time_periods must be positive"
    demand = _numeric_array(case["demand"], time_periods, "case demand")
    reserves = _numeric_array(case["reserves"], time_periods, "case reserves")
    assert np.all(demand >= 0), "case demand contains negative values"
    assert np.all(reserves >= 0), "case reserves contains negative values"

    thermal_items = list(case["thermal_generators"].items())
    renewable_items = list(case["renewable_generators"].items())
    assert thermal_items, "case must contain thermal generators"

    thermal = []
    thermal_names = []
    for key, gen in thermal_items:
        _require_keys(
            gen,
            {
                "power_output_minimum",
                "power_output_maximum",
                "ramp_up_limit",
                "ramp_down_limit",
                "ramp_startup_limit",
                "ramp_shutdown_limit",
                "time_up_minimum",
                "time_down_minimum",
                "power_output_t0",
                "unit_on_t0",
                "time_down_t0",
                "time_up_t0",
                "startup",
                "piecewise_production",
            },
            f"thermal generator {key}",
        )
        name = str(gen.get("name", key))
        thermal_names.append(name)
        pmin = float(gen["power_output_minimum"])
        pmax = float(gen["power_output_maximum"])
        assert pmax >= pmin >= 0, f"{name} has invalid output range"
        curve = sorted(
            [(float(point["mw"]), float(point["cost"])) for point in gen["piecewise_production"]],
            key=lambda x: x[0],
        )
        assert len(curve) >= 2, f"{name} must have at least two piecewise cost points"
        assert abs(curve[0][0] - pmin) <= TOL_GENERATOR_MW, (
            f"{name} first piecewise MW {curve[0][0]} does not match Pmin {pmin}"
        )
        assert abs(curve[-1][0] - pmax) <= TOL_GENERATOR_MW, (
            f"{name} last piecewise MW {curve[-1][0]} does not match Pmax {pmax}"
        )
        assert all(curve[i + 1][0] > curve[i][0] for i in range(len(curve) - 1)), (
            f"{name} piecewise MW points must be strictly increasing"
        )
        startups = sorted(
            [(int(item["lag"]), float(item["cost"])) for item in gen["startup"]],
            key=lambda x: x[0],
        )
        assert startups, f"{name} must have at least one startup tier"
        assert all(lag > 0 for lag, _ in startups), f"{name} startup lags must be positive"
        thermal.append(
            {
                "name": name,
                "pmin": pmin,
                "pmax": pmax,
                "cap": pmax - pmin,
                "ru": float(gen["ramp_up_limit"]),
                "rd": float(gen["ramp_down_limit"]),
                "su": float(gen["ramp_startup_limit"]),
                "sd": float(gen["ramp_shutdown_limit"]),
                "min_up": int(gen["time_up_minimum"]),
                "min_down": int(gen["time_down_minimum"]),
                "p0": float(gen["power_output_t0"]),
                "u0": int(round(float(gen["unit_on_t0"]))),
                "time_down_t0": int(gen["time_down_t0"]),
                "time_up_t0": int(gen["time_up_t0"]),
                "must_run": int(gen.get("must_run", 0)),
                "startup": startups,
                "piecewise": curve,
            }
        )

    assert len(set(thermal_names)) == len(thermal_names), "thermal generator names are not unique"

    renewable = []
    renewable_names = []
    for key, gen in renewable_items:
        _require_keys(gen, {"power_output_minimum", "power_output_maximum"}, f"renewable generator {key}")
        name = str(gen.get("name", key))
        renewable_names.append(name)
        pmin = _numeric_array(gen["power_output_minimum"], time_periods, f"{name} renewable minimum")
        pmax = _numeric_array(gen["power_output_maximum"], time_periods, f"{name} renewable maximum")
        assert np.all(pmax + TOL_GENERATOR_MW >= pmin), f"{name} renewable max below min"
        renewable.append({"name": name, "pmin": pmin, "pmax": pmax})

    assert len(set(renewable_names)) == len(renewable_names), "renewable generator names are not unique"
    return {
        "T": time_periods,
        "demand": demand,
        "reserves": reserves,
        "thermal": thermal,
        "renewable": renewable,
        "thermal_names": thermal_names,
        "renewable_names": renewable_names,
    }


def _as_binary_array(values, length: int, label: str) -> np.ndarray:
    arr = _numeric_array(values, length, label)
    rounded = np.rint(arr).astype(int)
    assert np.all(np.abs(arr - rounded) <= TOL_BINARY), f"{label} must be binary within tolerance"
    assert np.all((rounded == 0) | (rounded == 1)), f"{label} contains values other than 0/1"
    return rounded


def _extract_report_arrays(report: dict, parsed_case: dict) -> dict:
    T = parsed_case["T"]
    _require_keys(
        report,
        {"case_name", "summary", "thermal_generators", "renewable_generators", "hourly_summary", "constraint_check"},
        "report",
    )
    assert isinstance(report["summary"], dict), "summary must be an object"
    assert isinstance(report["thermal_generators"], list), "thermal_generators must be a list"
    assert isinstance(report["renewable_generators"], list), "renewable_generators must be a list"
    assert isinstance(report["hourly_summary"], list), "hourly_summary must be a list"
    assert isinstance(report["constraint_check"], dict), "constraint_check must be an object"

    thermal_entries = {}
    for entry in report["thermal_generators"]:
        assert isinstance(entry, dict), "each thermal_generators entry must be an object"
        name = entry.get("name")
        assert isinstance(name, str), "thermal generator entry missing string name"
        assert name not in thermal_entries, f"duplicate thermal generator {name}"
        thermal_entries[name] = entry
    assert set(thermal_entries) == set(parsed_case["thermal_names"]), (
        "thermal generator names do not match case data"
    )

    renewable_entries = {}
    for entry in report["renewable_generators"]:
        assert isinstance(entry, dict), "each renewable_generators entry must be an object"
        name = entry.get("name")
        assert isinstance(name, str), "renewable generator entry missing string name"
        assert name not in renewable_entries, f"duplicate renewable generator {name}"
        renewable_entries[name] = entry
    assert set(renewable_entries) == set(parsed_case["renewable_names"]), (
        "renewable generator names do not match case data"
    )

    G = len(parsed_case["thermal"])
    R = len(parsed_case["renewable"])
    commitment = np.zeros((G, T), dtype=int)
    startup = np.zeros((G, T), dtype=int)
    shutdown = np.zeros((G, T), dtype=int)
    production = np.zeros((G, T), dtype=float)
    reserve = np.zeros((G, T), dtype=float)

    for g, gen in enumerate(parsed_case["thermal"]):
        entry = thermal_entries[gen["name"]]
        _require_keys(entry, {"commitment", "production_MW", "reserve_MW", "startup", "shutdown"}, gen["name"])
        commitment[g] = _as_binary_array(entry["commitment"], T, f"{gen['name']} commitment")
        startup[g] = _as_binary_array(entry["startup"], T, f"{gen['name']} startup")
        shutdown[g] = _as_binary_array(entry["shutdown"], T, f"{gen['name']} shutdown")
        production[g] = _numeric_array(entry["production_MW"], T, f"{gen['name']} production_MW")
        reserve[g] = _numeric_array(entry["reserve_MW"], T, f"{gen['name']} reserve_MW")

    renewable_production = np.zeros((R, T), dtype=float)
    for r, gen in enumerate(parsed_case["renewable"]):
        entry = renewable_entries[gen["name"]]
        _require_keys(entry, {"production_MW"}, gen["name"])
        renewable_production[r] = _numeric_array(entry["production_MW"], T, f"{gen['name']} production_MW")

    assert len(report["hourly_summary"]) == T, f"hourly_summary must have {T} records"
    for t, row in enumerate(report["hourly_summary"]):
        assert isinstance(row, dict), f"hourly_summary[{t}] must be an object"
        _require_keys(
            row,
            {
                "hour",
                "demand_MW",
                "thermal_generation_MW",
                "renewable_generation_MW",
                "reserve_requirement_MW",
                "scheduled_spinning_reserve_MW",
            },
            f"hourly_summary[{t}]",
        )
        assert int(row["hour"]) == t + 1, f"hourly_summary[{t}] hour must be {t + 1}"

    return {
        "commitment": commitment,
        "startup": startup,
        "shutdown": shutdown,
        "thermal_production": production,
        "thermal_reserve": reserve,
        "renewable_production": renewable_production,
    }


def _recompute_transition_indicators(arrays: dict, parsed_case: dict) -> tuple[np.ndarray, np.ndarray]:
    u = arrays["commitment"]
    G, T = u.shape
    expected_startup = np.zeros_like(u)
    expected_shutdown = np.zeros_like(u)
    for g, gen in enumerate(parsed_case["thermal"]):
        prev = gen["u0"]
        for t in range(T):
            expected_startup[g, t] = max(u[g, t] - prev, 0)
            expected_shutdown[g, t] = max(prev - u[g, t], 0)
            prev = u[g, t]
    return expected_startup, expected_shutdown


def _recompute_hourly_summary(arrays: dict, parsed_case: dict) -> dict:
    thermal_generation = arrays["thermal_production"].sum(axis=0)
    renewable_generation = arrays["renewable_production"].sum(axis=0)
    scheduled_reserve = arrays["thermal_reserve"].sum(axis=0)
    demand_balance_violation = np.abs(thermal_generation + renewable_generation - parsed_case["demand"])
    reserve_shortfall = np.maximum(parsed_case["reserves"] - scheduled_reserve, 0.0)
    return {
        "thermal_generation_MW": thermal_generation,
        "renewable_generation_MW": renewable_generation,
        "scheduled_spinning_reserve_MW": scheduled_reserve,
        "max_demand_balance_violation_MW": float(np.max(demand_balance_violation)),
        "max_reserve_shortfall_MW": float(np.max(reserve_shortfall)),
    }


def _startup_cost_for_duration(generator: dict, offline_duration: int) -> float:
    chosen_cost = generator["startup"][0][1]
    for lag, cost in generator["startup"]:
        if lag <= offline_duration:
            chosen_cost = cost
        else:
            break
    return chosen_cost


def _piecewise_total_cost_at_output(generator: dict, production_mw: float) -> float:
    curve = generator["piecewise"]
    assert production_mw >= curve[0][0] - TOL_GENERATOR_MW, (
        f"{generator['name']} production below first cost point"
    )
    assert production_mw <= curve[-1][0] + TOL_GENERATOR_MW, (
        f"{generator['name']} production above last cost point"
    )
    if production_mw <= curve[0][0]:
        return curve[0][1]
    for (mw0, cost0), (mw1, cost1) in zip(curve, curve[1:]):
        if production_mw <= mw1 + TOL_GENERATOR_MW:
            if production_mw >= mw1:
                return cost1
            slope = (cost1 - cost0) / (mw1 - mw0)
            return cost0 + slope * (production_mw - mw0)
    return curve[-1][1]


def _recompute_total_cost(arrays: dict, parsed_case: dict) -> float:
    u = arrays["commitment"]
    v = arrays["startup"]
    production = arrays["thermal_production"]
    total_cost = 0.0
    for g, gen in enumerate(parsed_case["thermal"]):
        offline_duration = gen["time_down_t0"] if gen["u0"] == 0 else 0
        for t in range(parsed_case["T"]):
            if v[g, t] == 1:
                total_cost += _startup_cost_for_duration(gen, offline_duration)
            if u[g, t] == 1:
                total_cost += _piecewise_total_cost_at_output(gen, production[g, t])
                offline_duration = 0
            else:
                offline_duration += 1
    return float(total_cost)


def _solve_uc_benchmark_cost(case: dict) -> float:
    parsed = _parse_pglib_uc_case(case)
    T = parsed["T"]
    G = len(parsed["thermal"])
    R = len(parsed["renewable"])

    lb = []
    ub = []
    integrality = []
    objective = []

    def add_var(lower: float, upper: float, integer: bool, cost: float = 0.0) -> int:
        idx = len(lb)
        lb.append(float(lower))
        ub.append(float(upper))
        integrality.append(1 if integer else 0)
        objective.append(float(cost))
        return idx

    u = np.empty((G, T), dtype=int)
    v = np.empty((G, T), dtype=int)
    w = np.empty((G, T), dtype=int)
    p = np.empty((G, T), dtype=int)
    r = np.empty((G, T), dtype=int)
    y: list[list[list[int]]] = [[[] for _ in range(T)] for _ in range(G)]
    q = np.empty((R, T), dtype=int)

    for g, gen in enumerate(parsed["thermal"]):
        first_cost = gen["piecewise"][0][1]
        force_online_until = 0
        force_offline_until = 0
        if gen["u0"] == 1 and gen["time_up_t0"] < gen["min_up"]:
            force_online_until = gen["min_up"] - gen["time_up_t0"]
        if gen["u0"] == 0 and gen["time_down_t0"] < gen["min_down"]:
            force_offline_until = gen["min_down"] - gen["time_down_t0"]
        for t in range(T):
            lower, upper = 0.0, 1.0
            if gen["must_run"] == 1 or t < force_online_until:
                lower = upper = 1.0
            if t < force_offline_until:
                lower = upper = 0.0
            u[g, t] = add_var(lower, upper, True, first_cost)
            startup_cost = min(cost for _, cost in gen["startup"])
            v[g, t] = add_var(0.0, 1.0, True, startup_cost)
            w[g, t] = add_var(0.0, 1.0, True, 0.0)
            p[g, t] = add_var(0.0, gen["cap"], False, 0.0)
            r[g, t] = add_var(0.0, gen["cap"], False, 0.0)
            for (mw0, cost0), (mw1, cost1) in zip(gen["piecewise"], gen["piecewise"][1:]):
                width = mw1 - mw0
                slope = (cost1 - cost0) / width
                y[g][t].append(add_var(0.0, width, False, slope))

    for i, gen in enumerate(parsed["renewable"]):
        for t in range(T):
            q[i, t] = add_var(gen["pmin"][t], gen["pmax"][t], False, 0.0)

    row_idx = []
    col_idx = []
    data = []
    cons_lb = []
    cons_ub = []

    def add_constraint(entries: list[tuple[int, float]], lower: float, upper: float) -> None:
        row = len(cons_lb)
        for col, val in entries:
            if abs(val) > 0:
                row_idx.append(row)
                col_idx.append(col)
                data.append(float(val))
        cons_lb.append(float(lower))
        cons_ub.append(float(upper))

    for g, gen in enumerate(parsed["thermal"]):
        cap = gen["cap"]
        startup_reduction = max(gen["pmax"] - gen["su"], 0.0)
        shutdown_reduction = max(gen["pmax"] - gen["sd"], 0.0)
        p0_above_min = gen["u0"] * (gen["p0"] - gen["pmin"])

        for t in range(T):
            prev_u = gen["u0"] if t == 0 else u[g, t - 1]
            entries = [(u[g, t], 1.0), (v[g, t], -1.0), (w[g, t], 1.0)]
            rhs = float(prev_u) if t == 0 else 0.0
            if t > 0:
                entries.append((u[g, t - 1], -1.0))
            add_constraint(entries, rhs, rhs)

            add_constraint([(v[g, t], 1.0), (w[g, t], 1.0)], -math.inf, 1.0)
            add_constraint([(p[g, t], 1.0)] + [(seg, -1.0) for seg in y[g][t]], 0.0, 0.0)

            for seg_idx, seg in enumerate(y[g][t]):
                width = gen["piecewise"][seg_idx + 1][0] - gen["piecewise"][seg_idx][0]
                add_constraint([(seg, 1.0), (u[g, t], -width)], -math.inf, 0.0)

            add_constraint(
                [(p[g, t], 1.0), (r[g, t], 1.0), (u[g, t], -cap), (v[g, t], startup_reduction)],
                -math.inf,
                0.0,
            )
            if t < T - 1:
                add_constraint(
                    [(p[g, t], 1.0), (r[g, t], 1.0), (u[g, t], -cap), (w[g, t + 1], shutdown_reduction)],
                    -math.inf,
                    0.0,
                )

            if t == 0:
                add_constraint([(p[g, t], 1.0), (r[g, t], 1.0)], -math.inf, gen["ru"] + p0_above_min)
                add_constraint([(p[g, t], -1.0)], -math.inf, gen["rd"] - p0_above_min)
            else:
                add_constraint(
                    [(p[g, t], 1.0), (r[g, t], 1.0), (p[g, t - 1], -1.0)],
                    -math.inf,
                    gen["ru"],
                )
                add_constraint([(p[g, t - 1], 1.0), (p[g, t], -1.0)], -math.inf, gen["rd"])

            up_span = min(gen["min_up"], T - t)
            if up_span > 0:
                add_constraint([(u[g, k], -1.0) for k in range(t, t + up_span)] + [(v[g, t], up_span)], -math.inf, 0.0)
            down_span = min(gen["min_down"], T - t)
            if down_span > 0:
                add_constraint([(u[g, k], 1.0) for k in range(t, t + down_span)] + [(w[g, t], down_span)], -math.inf, down_span)

    for t in range(T):
        entries = []
        for g, gen in enumerate(parsed["thermal"]):
            entries.append((p[g, t], 1.0))
            entries.append((u[g, t], gen["pmin"]))
        for i in range(R):
            entries.append((q[i, t], 1.0))
        add_constraint(entries, parsed["demand"][t], parsed["demand"][t])
        add_constraint([(r[g, t], 1.0) for g in range(G)], parsed["reserves"][t], math.inf)

    matrix = coo_matrix((data, (row_idx, col_idx)), shape=(len(cons_lb), len(lb))).tocsr()
    result = milp(
        c=np.asarray(objective, dtype=float),
        integrality=np.asarray(integrality, dtype=int),
        bounds=Bounds(np.asarray(lb), np.asarray(ub)),
        constraints=LinearConstraint(matrix, np.asarray(cons_lb), np.asarray(cons_ub)),
        options={"time_limit": 240.0, "mip_rel_gap": 0.05, "disp": False},
    )
    assert result.x is not None, f"benchmark MILP did not return a feasible incumbent: {result.message}"

    x = result.x
    bench_arrays = {
        "commitment": np.rint(x[u]).astype(int),
        "startup": np.rint(x[v]).astype(int),
        "shutdown": np.rint(x[w]).astype(int),
        "thermal_production": x[p] + np.array([[gen["pmin"] for _ in range(T)] for gen in parsed["thermal"]]) * np.rint(x[u]),
        "thermal_reserve": np.maximum(x[r], 0.0),
        "renewable_production": x[q],
    }
    return _recompute_total_cost(bench_arrays, parsed)


@pytest.fixture(scope="module")
def report():
    assert os.path.exists(OUTPUT_FILE), f"Output file {OUTPUT_FILE} does not exist"
    return _load_json(OUTPUT_FILE)


@pytest.fixture(scope="module")
def case_data():
    return _load_json(CASE_FILE)


@pytest.fixture(scope="module")
def parsed_case(case_data):
    return _parse_pglib_uc_case(case_data)


@pytest.fixture(scope="module")
def arrays(report, parsed_case):
    return _extract_report_arrays(report, parsed_case)


@pytest.fixture(scope="module")
def recomputed_cost(arrays, parsed_case):
    return _recompute_total_cost(arrays, parsed_case)


class TestSchema:
    def test_required_schema(self, report, parsed_case):
        summary = report["summary"]
        _require_keys(
            summary,
            {
                "solver_status",
                "objective_cost",
                "reported_mip_gap",
                "time_periods",
                "num_thermal_generators",
                "num_renewable_generators",
                "total_startups",
                "total_shutdowns",
                "max_demand_balance_violation_MW",
                "max_reserve_shortfall_MW",
            },
            "summary",
        )
        assert summary["solver_status"] in ACCEPTED_STATUSES, (
            f"solver_status must be one of {sorted(ACCEPTED_STATUSES)}"
        )
        gap = summary["reported_mip_gap"]
        if gap is not None:
            gap = float(gap)
            assert math.isfinite(gap) and gap >= 0.0, "reported_mip_gap must be null or finite nonnegative"
        assert int(summary["time_periods"]) == parsed_case["T"], "summary time_periods does not match case"
        assert int(summary["num_thermal_generators"]) == len(parsed_case["thermal"]), (
            "summary num_thermal_generators does not match case"
        )
        assert int(summary["num_renewable_generators"]) == len(parsed_case["renewable"]), (
            "summary num_renewable_generators does not match case"
        )
        _require_keys(report["constraint_check"], REQUIRED_CONSTRAINT_CHECKS, "constraint_check")
        for key in REQUIRED_CONSTRAINT_CHECKS:
            assert report["constraint_check"][key] == "pass", f"constraint_check.{key} must be 'pass'"

    def test_arrays_align_with_case(self, arrays, parsed_case):
        T = parsed_case["T"]
        assert arrays["commitment"].shape == (len(parsed_case["thermal"]), T)
        assert arrays["startup"].shape == (len(parsed_case["thermal"]), T)
        assert arrays["shutdown"].shape == (len(parsed_case["thermal"]), T)
        assert arrays["thermal_production"].shape == (len(parsed_case["thermal"]), T)
        assert arrays["thermal_reserve"].shape == (len(parsed_case["thermal"]), T)
        assert arrays["renewable_production"].shape == (len(parsed_case["renewable"]), T)


class TestBinaryLogic:
    def test_startup_shutdown_match_commitment(self, arrays, parsed_case):
        expected_startup, expected_shutdown = _recompute_transition_indicators(arrays, parsed_case)
        np.testing.assert_array_equal(arrays["startup"], expected_startup)
        np.testing.assert_array_equal(arrays["shutdown"], expected_shutdown)

    def test_no_simultaneous_startup_shutdown(self, arrays):
        assert np.all(arrays["startup"] + arrays["shutdown"] <= 1), "unit starts and shuts down in same hour"

    def test_reported_transition_counts(self, report, arrays):
        summary = report["summary"]
        assert int(summary["total_startups"]) == int(arrays["startup"].sum()), "total_startups mismatch"
        assert int(summary["total_shutdowns"]) == int(arrays["shutdown"].sum()), "total_shutdowns mismatch"


class TestThermalFeasibility:
    def test_must_run_units_online(self, arrays, parsed_case):
        for g, gen in enumerate(parsed_case["thermal"]):
            if gen["must_run"] == 1:
                assert np.all(arrays["commitment"][g] == 1), f"{gen['name']} is must-run but not always online"

    def test_output_limits_and_offline_zeroes(self, arrays, parsed_case):
        u = arrays["commitment"]
        production = arrays["thermal_production"]
        reserve = arrays["thermal_reserve"]
        for g, gen in enumerate(parsed_case["thermal"]):
            assert np.all(reserve[g] >= -TOL_GENERATOR_MW), f"{gen['name']} has negative reserve"
            offline = u[g] == 0
            assert np.all(np.abs(production[g, offline]) <= TOL_GENERATOR_MW), (
                f"{gen['name']} has production while offline"
            )
            assert np.all(np.abs(reserve[g, offline]) <= TOL_GENERATOR_MW), (
                f"{gen['name']} has reserve while offline"
            )
            assert np.all(production[g] + TOL_GENERATOR_MW >= gen["pmin"] * u[g]), (
                f"{gen['name']} below minimum output"
            )
            assert np.all(production[g] <= gen["pmax"] * u[g] + TOL_GENERATOR_MW), (
                f"{gen['name']} above maximum output"
            )

    def test_deliverable_reserve_and_ramping(self, arrays, parsed_case):
        u = arrays["commitment"]
        v = arrays["startup"]
        w = arrays["shutdown"]
        production = arrays["thermal_production"]
        reserve = arrays["thermal_reserve"]
        T = parsed_case["T"]
        for g, gen in enumerate(parsed_case["thermal"]):
            p_above_min = production[g] - gen["pmin"] * u[g]
            p0 = gen["u0"] * (gen["p0"] - gen["pmin"])
            cap = gen["cap"]
            startup_reduction = max(gen["pmax"] - gen["su"], 0.0)
            shutdown_reduction = max(gen["pmax"] - gen["sd"], 0.0)
            assert np.all(p_above_min >= -TOL_GENERATOR_MW), f"{gen['name']} production above-min is negative"
            for t in range(T):
                lhs = p_above_min[t] + reserve[g, t]
                cap_rhs = cap * u[g, t] - startup_reduction * v[g, t]
                assert lhs <= cap_rhs + TOL_GENERATOR_MW, f"{gen['name']} violates startup capacity at hour {t + 1}"
                if t < T - 1:
                    shut_rhs = cap * u[g, t] - shutdown_reduction * w[g, t + 1]
                    assert lhs <= shut_rhs + TOL_GENERATOR_MW, (
                        f"{gen['name']} violates pre-shutdown capacity at hour {t + 1}"
                    )
                previous = p0 if t == 0 else p_above_min[t - 1]
                assert lhs - previous <= gen["ru"] + TOL_RAMP_MW, (
                    f"{gen['name']} violates ramp-up reserve deliverability at hour {t + 1}"
                )
                assert previous - p_above_min[t] <= gen["rd"] + TOL_RAMP_MW, (
                    f"{gen['name']} violates ramp-down limit at hour {t + 1}"
                )


class TestSystemFeasibility:
    def test_demand_and_reserve(self, arrays, parsed_case):
        thermal = arrays["thermal_production"].sum(axis=0)
        renewable = arrays["renewable_production"].sum(axis=0)
        reserve = arrays["thermal_reserve"].sum(axis=0)
        assert np.max(np.abs(thermal + renewable - parsed_case["demand"])) <= TOL_POWER_BALANCE_MW, (
            "thermal plus renewable generation does not match demand"
        )
        assert np.min(reserve - parsed_case["reserves"]) >= -TOL_RESERVE_MW, "spinning reserve shortfall"

    def test_renewable_limits(self, arrays, parsed_case):
        production = arrays["renewable_production"]
        for i, gen in enumerate(parsed_case["renewable"]):
            assert np.all(production[i] + TOL_GENERATOR_MW >= gen["pmin"]), (
                f"{gen['name']} renewable production below minimum"
            )
            assert np.all(production[i] <= gen["pmax"] + TOL_GENERATOR_MW), (
                f"{gen['name']} renewable production above maximum"
            )
            fixed = np.abs(gen["pmax"] - gen["pmin"]) <= TOL_GENERATOR_MW
            assert np.all(np.abs(production[i, fixed] - gen["pmin"][fixed]) <= TOL_GENERATOR_MW), (
                f"{gen['name']} fixed renewable output not respected"
            )

    def test_hourly_summary_matches_schedule(self, report, arrays, parsed_case):
        recomputed = _recompute_hourly_summary(arrays, parsed_case)
        for t, row in enumerate(report["hourly_summary"]):
            assert abs(float(row["demand_MW"]) - parsed_case["demand"][t]) <= TOL_POWER_BALANCE_MW
            assert abs(float(row["reserve_requirement_MW"]) - parsed_case["reserves"][t]) <= TOL_RESERVE_MW
            assert abs(float(row["thermal_generation_MW"]) - recomputed["thermal_generation_MW"][t]) <= TOL_POWER_BALANCE_MW
            assert abs(float(row["renewable_generation_MW"]) - recomputed["renewable_generation_MW"][t]) <= TOL_POWER_BALANCE_MW
            assert (
                abs(float(row["scheduled_spinning_reserve_MW"]) - recomputed["scheduled_spinning_reserve_MW"][t])
                <= TOL_RESERVE_MW
            )
        summary = report["summary"]
        assert (
            abs(float(summary["max_demand_balance_violation_MW"]) - recomputed["max_demand_balance_violation_MW"])
            <= TOL_POWER_BALANCE_MW
        )
        assert (
            abs(float(summary["max_reserve_shortfall_MW"]) - recomputed["max_reserve_shortfall_MW"])
            <= TOL_RESERVE_MW
        )


class TestMinimumUpDown:
    def test_initial_and_in_horizon_obligations(self, arrays, parsed_case):
        u = arrays["commitment"]
        v = arrays["startup"]
        w = arrays["shutdown"]
        T = parsed_case["T"]
        for g, gen in enumerate(parsed_case["thermal"]):
            if gen["u0"] == 1 and gen["time_up_t0"] < gen["min_up"]:
                remaining = min(T, gen["min_up"] - gen["time_up_t0"])
                assert np.all(u[g, :remaining] == 1), f"{gen['name']} violates initial min-up obligation"
            if gen["u0"] == 0 and gen["time_down_t0"] < gen["min_down"]:
                remaining = min(T, gen["min_down"] - gen["time_down_t0"])
                assert np.all(u[g, :remaining] == 0), f"{gen['name']} violates initial min-down obligation"

            for t in range(T):
                if v[g, t] == 1:
                    end = min(T, t + gen["min_up"])
                    assert np.all(u[g, t:end] == 1), f"{gen['name']} violates min-up after hour {t + 1}"
                if w[g, t] == 1:
                    end = min(T, t + gen["min_down"])
                    assert np.all(u[g, t:end] == 0), f"{gen['name']} violates min-down after hour {t + 1}"


class TestCostAndQuality:
    def test_reported_cost_matches_schedule(self, report, recomputed_cost):
        reported_cost = float(report["summary"]["objective_cost"])
        assert math.isfinite(reported_cost) and reported_cost > 0, "reported objective_cost must be positive finite"
        assert abs(reported_cost - recomputed_cost) <= max(
            TOL_COST_ABS,
            TOL_COST_REL * max(1.0, abs(recomputed_cost)),
        ), f"reported objective {reported_cost} does not match recomputed cost {recomputed_cost}"

    def test_cost_within_benchmark_gap(self, case_data, recomputed_cost):
        benchmark_cost = _solve_uc_benchmark_cost(case_data)
        assert recomputed_cost <= benchmark_cost * (1.0 + TOL_OPTIMALITY_GAP_REL) + TOL_COST_ABS, (
            f"recomputed cost {recomputed_cost} exceeds benchmark {benchmark_cost} by more than "
            f"{TOL_OPTIMALITY_GAP_REL:.0%}"
        )
