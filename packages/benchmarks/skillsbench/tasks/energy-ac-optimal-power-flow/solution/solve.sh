#!/bin/bash
set -e

# CasADi's IPOPT plugin needs the gfortran runtime on Ubuntu
apt-get update -qq
apt-get install -y -qq libgfortran5 > /dev/null 2>&1

# Install Python dependencies (CasADi bundles an IPOPT interface on Linux)
pip3 install --break-system-packages numpy==1.26.4 casadi==3.6.7 -q

python3 << 'EOF'
"""
AC Optimal Power Flow (ACOPF) oracle solution.

Strictly follows the formulation in /root/acopf-math-model.md:
- Variables: generator complex power (Pg,Qg), bus complex voltage (Vm,Va), branch flows S_ij
- Constraints:
  - Reference bus angle fixed at 0
  - Generator P/Q bounds
  - Bus voltage magnitude bounds
  - Full AC complex power balance at each bus, including bus shunts
  - Branch pi-model power flow with tap ratio and phase shift
  - Apparent power limits on branch flows (both directions) when rateA > 0
  - Voltage angle difference bounds (angmin/angmax)

Solver: IPOPT (via CasADi's ipopt interface). Uses automatic differentiation (sparse).
"""

from __future__ import annotations

import json
import math
import numpy as np
import casadi as ca


def deg2rad(x: float) -> float:
    return x * math.pi / 180.0


def main() -> None:
    with open("/root/network.json", encoding="utf-8") as f:
        data = json.load(f)

    baseMVA = float(data["baseMVA"])
    bus = np.array(data["bus"], dtype=float)
    gen = np.array(data["gen"], dtype=float)
    branch = np.array(data["branch"], dtype=float)
    gencost = np.array(data["gencost"], dtype=float)

    n_bus = bus.shape[0]
    n_gen = gen.shape[0]
    n_branch = branch.shape[0]

    bus_ids = bus[:, 0].astype(int)
    bus_type = bus[:, 1].astype(int)
    bus_id_to_idx = {int(bus_ids[i]): i for i in range(n_bus)}

    ref_idx = int(np.where(bus_type == 3)[0][0])
    print(f"n_bus={n_bus}, n_gen={n_gen}, n_branch={n_branch}, ref_bus={bus_ids[ref_idx]}")

    Pd = bus[:, 2] / baseMVA
    Qd = bus[:, 3] / baseMVA
    Gs = bus[:, 4] / baseMVA
    Bs = bus[:, 5] / baseMVA
    Vmax = bus[:, 11]
    Vmin = bus[:, 12]

    gen_bus = np.array([bus_id_to_idx[int(b)] for b in gen[:, 0]], dtype=int)
    Pg0 = gen[:, 1] / baseMVA
    Qg0 = gen[:, 2] / baseMVA
    Qmax = gen[:, 3] / baseMVA
    Qmin = gen[:, 4] / baseMVA
    Pmax = gen[:, 8] / baseMVA
    Pmin = gen[:, 9] / baseMVA

    # gencost poly: [model, startup, shutdown, n, c2, c1, c0]
    c2 = gencost[:, 4]
    c1 = gencost[:, 5]
    c0 = gencost[:, 6]

    # Branch parameters
    f = np.array([bus_id_to_idx[int(x)] for x in branch[:, 0]], dtype=int)
    t = np.array([bus_id_to_idx[int(x)] for x in branch[:, 1]], dtype=int)
    r = branch[:, 2]
    x = branch[:, 3]
    b = branch[:, 4]
    rate_pu = branch[:, 5] / baseMVA
    tap = np.where(np.abs(branch[:, 8]) < 1e-12, 1.0, branch[:, 8])
    shift = np.array([deg2rad(a) for a in branch[:, 9]])
    angmin = np.array([deg2rad(a) for a in branch[:, 11]])
    angmax = np.array([deg2rad(a) for a in branch[:, 12]])

    # Series admittance y = 1/(r+jx) = g + jb
    g = np.zeros(n_branch)
    bser = np.zeros(n_branch)
    for l in range(n_branch):
        if abs(r[l]) < 1e-12 and abs(x[l]) < 1e-12:
            g[l] = 0.0
            bser[l] = 0.0
        else:
            denom = r[l] * r[l] + x[l] * x[l]
            g[l] = r[l] / denom
            bser[l] = -x[l] / denom

    gens_at_bus = [[] for _ in range(n_bus)]
    for k in range(n_gen):
        gens_at_bus[int(gen_bus[k])].append(k)

    branches_from = [[] for _ in range(n_bus)]
    branches_to = [[] for _ in range(n_bus)]
    for l in range(n_branch):
        branches_from[int(f[l])].append(l)
        branches_to[int(t[l])].append(l)

    # Decision variables
    Vm = ca.MX.sym("Vm", n_bus)
    Va = ca.MX.sym("Va", n_bus)
    Pg = ca.MX.sym("Pg", n_gen)
    Qg = ca.MX.sym("Qg", n_gen)

    # Objective
    Pg_MW = Pg * baseMVA
    obj = ca.sum1(ca.DM(c2) * (Pg_MW**2) + ca.DM(c1) * Pg_MW + ca.DM(c0))

    # Power balance (build branch flow sums)
    P_out = [ca.MX(0) for _ in range(n_bus)]
    Q_out = [ca.MX(0) for _ in range(n_bus)]

    # store per-branch flows (for constraints)
    Pij = [None] * n_branch
    Qij = [None] * n_branch
    Pji = [None] * n_branch
    Qji = [None] * n_branch

    for l in range(n_branch):
        i = int(f[l])
        j = int(t[l])

        delta_ij = Va[i] - Va[j] - shift[l]
        cth = ca.cos(delta_ij)
        sth = ca.sin(delta_ij)
        inv_t = 1.0 / tap[l]
        inv_t2 = inv_t * inv_t

        P_ij = g[l] * Vm[i] ** 2 * inv_t2 - Vm[i] * Vm[j] * inv_t * (g[l] * cth + bser[l] * sth)
        Q_ij = -(bser[l] + b[l] / 2.0) * Vm[i] ** 2 * inv_t2 - Vm[i] * Vm[j] * inv_t * (g[l] * sth - bser[l] * cth)

        delta_ji = Va[j] - Va[i] + shift[l]
        c2th = ca.cos(delta_ji)
        s2th = ca.sin(delta_ji)

        P_ji = g[l] * Vm[j] ** 2 - Vm[i] * Vm[j] * inv_t * (g[l] * c2th + bser[l] * s2th)
        Q_ji = -(bser[l] + b[l] / 2.0) * Vm[j] ** 2 - Vm[i] * Vm[j] * inv_t * (g[l] * s2th - bser[l] * c2th)

        Pij[l], Qij[l], Pji[l], Qji[l] = P_ij, Q_ij, P_ji, Q_ji

        P_out[i] += P_ij
        Q_out[i] += Q_ij
        P_out[j] += P_ji
        Q_out[j] += Q_ji

    Pg_bus = [ca.MX(0) for _ in range(n_bus)]
    Qg_bus = [ca.MX(0) for _ in range(n_bus)]
    for i in range(n_bus):
        if gens_at_bus[i]:
            Pg_bus[i] = ca.sum1(ca.vcat([Pg[k] for k in gens_at_bus[i]]))
            Qg_bus[i] = ca.sum1(ca.vcat([Qg[k] for k in gens_at_bus[i]]))

    g_expr = []
    lbg = []
    ubg = []

    # Equality constraints
    for i in range(n_bus):
        # Pg - Pd - Gs*Vm^2 = P_out
        g_expr.append(Pg_bus[i] - Pd[i] - Gs[i] * (Vm[i] ** 2) - P_out[i])
        lbg.append(0.0)
        ubg.append(0.0)
    for i in range(n_bus):
        # Qg - Qd + Bs*Vm^2 = Q_out
        g_expr.append(Qg_bus[i] - Qd[i] + Bs[i] * (Vm[i] ** 2) - Q_out[i])
        lbg.append(0.0)
        ubg.append(0.0)

    # Reference bus angle
    g_expr.append(Va[ref_idx])
    lbg.append(0.0)
    ubg.append(0.0)

    # Branch apparent power constraints (both directions), only if rateA>0
    for l in range(n_branch):
        if rate_pu[l] > 0:
            g_expr.append(Pij[l] ** 2 + Qij[l] ** 2)
            lbg.append(0.0)
            ubg.append(float(rate_pu[l] ** 2))
            g_expr.append(Pji[l] ** 2 + Qji[l] ** 2)
            lbg.append(0.0)
            ubg.append(float(rate_pu[l] ** 2))

    # Angle difference bounds: angmin <= Va_i - Va_j <= angmax
    for l in range(n_branch):
        g_expr.append(Va[int(f[l])] - Va[int(t[l])])
        lbg.append(float(angmin[l]))
        ubg.append(float(angmax[l]))

    x = ca.vertcat(Vm, Va, Pg, Qg)
    gvec = ca.vertcat(*g_expr)

    # Variable bounds
    lbx = np.concatenate([Vmin, -math.pi * np.ones(n_bus), Pmin, Qmin]).tolist()
    ubx = np.concatenate([Vmax, math.pi * np.ones(n_bus), Pmax, Qmax]).tolist()

    x0 = np.concatenate(
        [
            np.ones(n_bus),
            np.zeros(n_bus),
            np.clip(Pg0, Pmin, Pmax),
            np.clip(Qg0, Qmin, Qmax),
        ]
    ).tolist()
    x0[n_bus + ref_idx] = 0.0

    nlp = {"x": x, "f": obj, "g": gvec}
    opts = {
        "ipopt.print_level": 5,
        "ipopt.max_iter": 2000,
        "ipopt.tol": 1e-7,
        "ipopt.acceptable_tol": 1e-5,
        "ipopt.mu_strategy": "adaptive",
        "print_time": False,
    }
    solver = ca.nlpsol("solver", "ipopt", nlp, opts)

    print(f"Solving with IPOPT (n_var={int(x.size1())}, n_con={int(gvec.size1())}) ...")
    sol = solver(x0=x0, lbx=lbx, ubx=ubx, lbg=lbg, ubg=ubg)

    x_opt = np.array(sol["x"]).reshape((-1,))
    Vm_sol = x_opt[:n_bus]
    Va_sol = x_opt[n_bus : 2 * n_bus]
    Pg_sol = x_opt[2 * n_bus : 2 * n_bus + n_gen]
    Qg_sol = x_opt[2 * n_bus + n_gen :]

    Pg_MW = Pg_sol * baseMVA
    Qg_MVAr = Qg_sol * baseMVA
    Va_deg = Va_sol * 180.0 / math.pi

    # Totals and cost
    total_load_P = float(np.sum(Pd) * baseMVA)
    total_load_Q = float(np.sum(Qd) * baseMVA)
    total_gen_P = float(np.sum(Pg_MW))
    total_gen_Q = float(np.sum(Qg_MVAr))
    total_losses = total_gen_P - total_load_P
    total_cost = float(sol["f"])

    # Compute branch flows numerically for report
    branch_records = []
    max_over = 0.0
    for l in range(n_branch):
        i = int(f[l])
        j = int(t[l])
        inv_t = 1.0 / tap[l]
        inv_t2 = inv_t * inv_t

        d = Va_sol[i] - Va_sol[j] - shift[l]
        cth = math.cos(d)
        sth = math.sin(d)
        P_ij = g[l] * Vm_sol[i] ** 2 * inv_t2 - Vm_sol[i] * Vm_sol[j] * inv_t * (g[l] * cth + bser[l] * sth)
        Q_ij = -(bser[l] + b[l] / 2.0) * Vm_sol[i] ** 2 * inv_t2 - Vm_sol[i] * Vm_sol[j] * inv_t * (g[l] * sth - bser[l] * cth)

        d2 = Va_sol[j] - Va_sol[i] + shift[l]
        c2th = math.cos(d2)
        s2th = math.sin(d2)
        P_ji = g[l] * Vm_sol[j] ** 2 - Vm_sol[i] * Vm_sol[j] * inv_t * (g[l] * c2th + bser[l] * s2th)
        Q_ji = -(bser[l] + b[l] / 2.0) * Vm_sol[j] ** 2 - Vm_sol[i] * Vm_sol[j] * inv_t * (g[l] * s2th - bser[l] * c2th)

        S_ij = math.sqrt(P_ij * P_ij + Q_ij * Q_ij) * baseMVA
        S_ji = math.sqrt(P_ji * P_ji + Q_ji * Q_ji) * baseMVA
        limit = float(rate_pu[l] * baseMVA)
        loading = (max(S_ij, S_ji) / limit * 100.0) if limit > 0 else 0.0
        if limit > 0:
            max_over = max(max_over, max(0.0, max(S_ij, S_ji) - limit))

        branch_records.append(
            {
                "from_bus": int(bus_ids[i]),
                "to_bus": int(bus_ids[j]),
                "loading_pct": loading,
                "flow_from_MVA": S_ij,
                "flow_to_MVA": S_ji,
                "limit_MVA": limit,
            }
        )

    # Feasibility metrics (evaluate mismatches)
    # Rebuild bus sums (pu)
    Pg_bus_val = np.zeros(n_bus)
    Qg_bus_val = np.zeros(n_bus)
    for k in range(n_gen):
        Pg_bus_val[gen_bus[k]] += Pg_sol[k]
        Qg_bus_val[gen_bus[k]] += Qg_sol[k]

    P_out_val = np.zeros(n_bus)
    Q_out_val = np.zeros(n_bus)
    for l in range(n_branch):
        i = int(f[l])
        j = int(t[l])
        inv_t = 1.0 / tap[l]
        inv_t2 = inv_t * inv_t
        d = Va_sol[i] - Va_sol[j] - shift[l]
        cth = math.cos(d)
        sth = math.sin(d)
        P_ij = g[l] * Vm_sol[i] ** 2 * inv_t2 - Vm_sol[i] * Vm_sol[j] * inv_t * (g[l] * cth + bser[l] * sth)
        Q_ij = -(bser[l] + b[l] / 2.0) * Vm_sol[i] ** 2 * inv_t2 - Vm_sol[i] * Vm_sol[j] * inv_t * (g[l] * sth - bser[l] * cth)
        d2 = Va_sol[j] - Va_sol[i] + shift[l]
        c2th = math.cos(d2)
        s2th = math.sin(d2)
        P_ji = g[l] * Vm_sol[j] ** 2 - Vm_sol[i] * Vm_sol[j] * inv_t * (g[l] * c2th + bser[l] * s2th)
        Q_ji = -(bser[l] + b[l] / 2.0) * Vm_sol[j] ** 2 - Vm_sol[i] * Vm_sol[j] * inv_t * (g[l] * s2th - bser[l] * c2th)
        P_out_val[i] += P_ij
        Q_out_val[i] += Q_ij
        P_out_val[j] += P_ji
        Q_out_val[j] += Q_ji

    P_mis = Pg_bus_val - Pd - Gs * (Vm_sol**2) - P_out_val
    Q_mis = Qg_bus_val - Qd + Bs * (Vm_sol**2) - Q_out_val
    max_p_mis = float(np.max(np.abs(P_mis)) * baseMVA)
    max_q_mis = float(np.max(np.abs(Q_mis)) * baseMVA)
    max_v_vio = float(np.max(np.maximum(0.0, np.maximum(Vmin - Vm_sol, Vm_sol - Vmax))))

    report = {
        "summary": {
            "total_cost_per_hour": round(total_cost, 2),
            "total_load_MW": round(total_load_P, 2),
            "total_load_MVAr": round(total_load_Q, 2),
            "total_generation_MW": round(total_gen_P, 2),
            "total_generation_MVAr": round(total_gen_Q, 2),
            "total_losses_MW": round(total_losses, 2),
            "solver_status": "optimal",
        },
        "generators": [
            {
                "id": k + 1,
                "bus": int(bus_ids[int(gen_bus[k])]),
                "pg_MW": round(float(Pg_MW[k]), 6),
                "qg_MVAr": round(float(Qg_MVAr[k]), 6),
                "pmin_MW": float(Pmin[k] * baseMVA),
                "pmax_MW": float(Pmax[k] * baseMVA),
                "qmin_MVAr": float(Qmin[k] * baseMVA),
                "qmax_MVAr": float(Qmax[k] * baseMVA),
            }
            for k in range(n_gen)
        ],
        "buses": [
            {
                "id": int(bus_ids[i]),
                "vm_pu": round(float(Vm_sol[i]), 6),
                "va_deg": round(float(Va_deg[i]), 6),
                "vmin_pu": float(Vmin[i]),
                "vmax_pu": float(Vmax[i]),
            }
            for i in range(n_bus)
        ],
        "most_loaded_branches": [
            {
                "from_bus": r["from_bus"],
                "to_bus": r["to_bus"],
                "loading_pct": round(float(r["loading_pct"]), 2),
                "flow_from_MVA": round(float(r["flow_from_MVA"]), 3),
                "flow_to_MVA": round(float(r["flow_to_MVA"]), 3),
                "limit_MVA": round(float(r["limit_MVA"]), 3),
            }
            for r in sorted(branch_records, key=lambda x: x["loading_pct"], reverse=True)[:10]
        ],
        "feasibility_check": {
            "max_p_mismatch_MW": round(max_p_mis, 6),
            "max_q_mismatch_MVAr": round(max_q_mis, 6),
            "max_voltage_violation_pu": round(max_v_vio, 6),
            "max_branch_overload_MVA": round(max_over, 6),
        },
    }

    with open("/root/report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    print("Wrote /root/report.json")
    print(
        f"Feasibility: max|P_mis|={max_p_mis:.6f} MW, max|Q_mis|={max_q_mis:.6f} MVAr, "
        f"maxVvio={max_v_vio:.6g} pu, maxOver={max_over:.6f} MVA"
    )


if __name__ == "__main__":
    main()
EOF
