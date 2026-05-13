---
name: ac-branch-pi-model
description: "AC branch pi-model power flow equations (P/Q and |S|) with transformer tap ratio and phase shift, matching `acopf-math-model.md` and MATPOWER branch fields. Use when computing branch flows in either direction, aggregating bus injections for nodal balance, checking MVA (rateA) limits, computing branch loading %, or debugging sign/units issues in AC power flow."
---

# AC Branch Pi-Model + Transformer Handling

Implement the exact branch power flow equations in `acopf-math-model.md` using MATPOWER branch data:

```
[F_BUS, T_BUS, BR_R, BR_X, BR_B, RATE_A, RATE_B, RATE_C, TAP, SHIFT, BR_STATUS, ANGMIN, ANGMAX]
```

## Quick start

- Use `scripts/branch_flows.py` to compute per-unit branch flows.
- Treat the results as **power leaving** the “from” bus and **power leaving** the “to” bus (i.e., compute both directions explicitly).

Example:

```python
import json
import numpy as np

from scripts.branch_flows import compute_branch_flows_pu, build_bus_id_to_idx

data = json.load(open("/root/network.json"))
baseMVA = float(data["baseMVA"])
buses = np.array(data["bus"], dtype=float)
branches = np.array(data["branch"], dtype=float)

bus_id_to_idx = build_bus_id_to_idx(buses)

Vm = buses[:, 7]  # initial guess VM
Va = np.deg2rad(buses[:, 8])  # initial guess VA

br = branches[0]
P_ij, Q_ij, P_ji, Q_ji = compute_branch_flows_pu(Vm, Va, br, bus_id_to_idx)

S_ij_MVA = (P_ij**2 + Q_ij**2) ** 0.5 * baseMVA
S_ji_MVA = (P_ji**2 + Q_ji**2) ** 0.5 * baseMVA
print(S_ij_MVA, S_ji_MVA)
```

## Model details (match the task formulation)

### Per-unit conventions

- Work in per-unit internally.
- Convert with `baseMVA`:
  - \(P_{pu} = P_{MW} / baseMVA\)
  - \(Q_{pu} = Q_{MVAr} / baseMVA\)
  - \(|S|_{MVA} = |S|_{pu} \cdot baseMVA\)

### Transformer handling (MATPOWER TAP + SHIFT)

- Use \(T_{ij} = tap \cdot e^{j \cdot shift}\).
- **Implementation shortcut (real tap + phase shift):**
  - If `abs(TAP) < 1e-12`, treat `tap = 1.0` (no transformer).
  - Convert `SHIFT` from degrees to radians.
  - Use the angle shift by modifying the angle difference:
    - \(\delta_{ij} = \theta_i - \theta_j - shift\)
    - \(\delta_{ji} = \theta_j - \theta_i + shift\)

### Series admittance

Given `BR_R = r`, `BR_X = x`:

- If `r == 0 and x == 0`, set `g = 0`, `b = 0` (avoid divide-by-zero).
- Else:
  - \(y = 1/(r + jx) = g + jb\)
  - \(g = r/(r^2 + x^2)\)
  - \(b = -x/(r^2 + x^2)\)

### Line charging susceptance

- `BR_B` is the **total** line charging susceptance \(b_c\) (per unit).
- Each end gets \(b_c/2\) in the standard pi model.

## Power flow equations (use these exactly)

Let:
- \(V_i = |V_i| e^{j\theta_i}\), \(V_j = |V_j| e^{j\theta_j}\)
- `tap` is real, `shift` is radians
- `inv_t = 1/tap`, `inv_t2 = inv_t^2`

Then the real/reactive power flow from i→j is:

- \(P_{ij} = g |V_i|^2 inv\_t2 - |V_i||V_j| inv\_t (g\cos\delta_{ij} + b\sin\delta_{ij})\)
- \(Q_{ij} = -(b + b_c/2)|V_i|^2 inv\_t2 - |V_i||V_j| inv\_t (g\sin\delta_{ij} - b\cos\delta_{ij})\)

And from j→i is:

- \(P_{ji} = g |V_j|^2 - |V_i||V_j| inv\_t (g\cos\delta_{ji} + b\sin\delta_{ji})\)
- \(Q_{ji} = -(b + b_c/2)|V_j|^2 - |V_i||V_j| inv\_t (g\sin\delta_{ji} - b\cos\delta_{ji})\)

Compute apparent power:

- \(|S_{ij}| = \sqrt{P_{ij}^2 + Q_{ij}^2}\)
- \(|S_{ji}| = \sqrt{P_{ji}^2 + Q_{ji}^2}\)

## Common uses

### Enforce MVA limits (rateA)

- `RATE_A` is an MVA limit (may be 0 meaning “no limit”).
- Enforce in both directions:
  - \(|S_{ij}| \le RATE_A\)
  - \(|S_{ji}| \le RATE_A\)

### Compute branch loading %

For reporting “most loaded branches”:

- `loading_pct = 100 * max(|S_ij|, |S_ji|) / RATE_A` if `RATE_A > 0`, else 0.

### Aggregate bus injections for nodal balance

To build the branch flow sum for each bus \(i\):

- Add \(P_{ij}, Q_{ij}\) to bus i
- Add \(P_{ji}, Q_{ji}\) to bus j

This yields arrays `P_out[i]`, `Q_out[i]` such that the nodal balance can be written as:

- \(P^g - P^d - G^s|V|^2 = P_{out}\)
- \(Q^g - Q^d + B^s|V|^2 = Q_{out}\)

## Sanity checks (fast debug)

- With `SHIFT=0` and `TAP=1`, if \(V_i = V_j\) and \(\theta_i=\theta_j\), then \(P_{ij}\approx 0\) and \(P_{ji}\approx 0\) (lossless only if r=0).
- For a pure transformer (`r=x=0`) you should not get meaningful flows; treat as `g=b=0` (no series element).
