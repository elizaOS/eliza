---
name: casadi-ipopt-nlp
description: "Nonlinear optimization with CasADi and IPOPT solver. Use when building and solving NLP problems: defining symbolic variables, adding nonlinear constraints, setting solver options, handling multiple initializations, and extracting solutions. Covers power systems optimization patterns including per-unit scaling and complex number formulations."
---

# CasADi + IPOPT for Nonlinear Programming

CasADi is a symbolic framework for nonlinear optimization. IPOPT is an interior-point solver for large-scale NLP.

## Quick start (Linux)

```bash
apt-get update -qq && apt-get install -y -qq libgfortran5
pip install numpy==1.26.4 casadi==3.6.7
```

## Building an NLP

### 1. Decision variables

```python
import casadi as ca

n_bus, n_gen = 100, 20
Vm = ca.MX.sym("Vm", n_bus)   # Voltage magnitudes
Va = ca.MX.sym("Va", n_bus)   # Voltage angles (radians)
Pg = ca.MX.sym("Pg", n_gen)   # Real power
Qg = ca.MX.sym("Qg", n_gen)   # Reactive power

# Stack into single vector for solver
x = ca.vertcat(Vm, Va, Pg, Qg)
```

### 2. Objective function

Build symbolic expression:

```python
# Quadratic cost: sum of c2*P^2 + c1*P + c0
obj = ca.MX(0)
for k in range(n_gen):
    obj += c2[k] * Pg[k]**2 + c1[k] * Pg[k] + c0[k]
```

### 3. Constraints

Collect constraints in lists with bounds:

```python
g_expr = []  # Constraint expressions
lbg = []     # Lower bounds
ubg = []     # Upper bounds

# Equality constraint: g(x) = 0
g_expr.append(some_expression)
lbg.append(0.0)
ubg.append(0.0)

# Inequality constraint: g(x) <= limit
g_expr.append(another_expression)
lbg.append(-ca.inf)
ubg.append(limit)

# Two-sided: lo <= g(x) <= hi
g_expr.append(bounded_expression)
lbg.append(lo)
ubg.append(hi)

g = ca.vertcat(*g_expr)
```

### 4. Variable bounds

```python
# Stack bounds matching variable order
lbx = np.concatenate([Vm_min, Va_min, Pg_min, Qg_min]).tolist()
ubx = np.concatenate([Vm_max, Va_max, Pg_max, Qg_max]).tolist()
```

### 5. Create and call solver

```python
nlp = {"x": x, "f": obj, "g": g}
opts = {
    "ipopt.print_level": 0,
    "ipopt.max_iter": 2000,
    "ipopt.tol": 1e-7,
    "ipopt.acceptable_tol": 1e-5,
    "ipopt.mu_strategy": "adaptive",
    "print_time": False,
}
solver = ca.nlpsol("solver", "ipopt", nlp, opts)

sol = solver(x0=x0, lbx=lbx, ubx=ubx, lbg=lbg, ubg=ubg)
x_opt = np.array(sol["x"]).flatten()
obj_val = float(sol["f"])
```

## IPOPT options (tuning guide)

| Option | Default | Recommendation | Notes |
|--------|---------|----------------|-------|
| `tol` | 1e-8 | 1e-7 | Convergence tolerance |
| `acceptable_tol` | 1e-6 | 1e-5 | Fallback if tol not reached |
| `max_iter` | 3000 | 2000 | Increase for hard problems |
| `mu_strategy` | monotone | adaptive | Better for nonconvex |
| `print_level` | 5 | 0 | Quiet output |

## Initialization matters

Nonlinear solvers are sensitive to starting points. Use multiple initializations:

```python
initializations = [x0_from_data, x0_flat_start]
best_sol = None

for x0 in initializations:
    try:
        sol = solver(x0=x0, lbx=lbx, ubx=ubx, lbg=lbg, ubg=ubg)
        if best_sol is None or float(sol["f"]) < float(best_sol["f"]):
            best_sol = sol
    except Exception:
        continue

if best_sol is None:
    raise RuntimeError("Solver failed from all initializations")
```

**Good initialization strategies:**
- Data-derived: Use values from input data, clipped to bounds
- Flat start: Nominal values (e.g., Vm=1.0, Va=0.0)
- Always enforce known constraints in initial point (e.g., reference angle = 0)

## Extracting solutions

```python
x_opt = np.array(sol["x"]).flatten()

# Unpack by slicing (must match variable order)
Vm_sol = x_opt[:n_bus]
Va_sol = x_opt[n_bus:2*n_bus]
Pg_sol = x_opt[2*n_bus:2*n_bus+n_gen]
Qg_sol = x_opt[2*n_bus+n_gen:]
```

## Power systems patterns

### Per-unit scaling

Work in per-unit internally, convert for output:

```python
baseMVA = 100.0
Pg_pu = Pg_MW / baseMVA      # Input conversion
Pg_MW = Pg_pu * baseMVA      # Output conversion
```

Cost functions often expect MW, not per-unit - check the formulation.

### Bus ID mapping

Power system bus numbers may not be contiguous:

```python
bus_id_to_idx = {int(bus[i, 0]): i for i in range(n_bus)}
gen_bus_idx = bus_id_to_idx[int(gen_row[0])]
```

### Aggregating per-bus quantities

```python
Pg_bus = [ca.MX(0) for _ in range(n_bus)]
for k in range(n_gen):
    bus_idx = gen_bus_idx[k]
    Pg_bus[bus_idx] += Pg[k]
```

## Common failure modes

- **Infeasible**: Check bound consistency, constraint signs, unit conversions
- **Slow convergence**: Try different initialization, relax tolerances temporarily
- **Wrong tap handling**: MATPOWER uses `tap=0` to mean 1.0, not zero
- **Angle units**: Data often in degrees, solver needs radians
- **Shunt signs**: Check convention for Gs (conductance) vs Bs (susceptance)
- **Over-rounding outputs**: Keep high precision (≥6 decimals) in results
