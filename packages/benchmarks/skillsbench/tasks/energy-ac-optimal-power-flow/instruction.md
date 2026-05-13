As an operator-planner in an Independent System Operator, you create a base case for tomorrow's peak hour each morning in order to establish the voltage profile and verify that the day-ahead market schedule is AC-feasible. In order to do this, you should use the model described in `math-model.md` to find a least-cost, AC feasible operating point and then produce a report in `report.json`. The report should follow the structure below with all power values in MW or MVAr, angles in degrees, voltages in per-unit.

```json
{
  "summary": {
    "total_cost_per_hour": 1234567.89,
    "total_load_MW": 144839.06,
    "total_load_MVAr": 29007.78,
    "total_generation_MW": 145200.00,
    "total_generation_MVAr": 32000.00,
    "total_losses_MW": 360.94,
    "solver_status": "optimal"
  },
  "generators": [
    {
      "id": 1,
      "bus": 316,
      "pg_MW": 245.5,
      "qg_MVAr": 50.0,
      "pmin_MW": 0.0,
      "pmax_MW": 491.0,
      "qmin_MVAr": -246.0,
      "qmax_MVAr": 246.0
    }
  ],
  "buses": [
    {
      "id": 1,
      "vm_pu": 1.02,
      "va_deg": -5.3,
      "vmin_pu": 0.9,
      "vmax_pu": 1.1
    }
  ],
  "most_loaded_branches": [
    {
      "from_bus": 123,
      "to_bus": 456,
      "loading_pct": 95.2,
      "flow_from_MVA": 571.2,
      "flow_to_MVA": 568.1,
      "limit_MVA": 600.0
    }
  ],
  "feasibility_check": {
    "max_p_mismatch_MW": 0.001,
    "max_q_mismatch_MVAr": 0.002,
    "max_voltage_violation_pu": 0.0,
    "max_branch_overload_MVA": 0.0
  }
}
```
