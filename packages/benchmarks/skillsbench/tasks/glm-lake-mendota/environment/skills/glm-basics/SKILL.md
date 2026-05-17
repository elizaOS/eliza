---
name: glm-basics
description: Basic usage of the General Lake Model (GLM) for lake temperature simulation. Use when you need to run GLM, understand input files, or modify configuration parameters.
license: MIT
---

# GLM Basics Guide

## Overview

GLM (General Lake Model) is a 1D hydrodynamic model that simulates vertical temperature and mixing dynamics in lakes. It reads configuration from a namelist file and produces NetCDF output.

## Running GLM
```bash
cd /root
glm
```

GLM reads `glm3.nml` in the current directory and produces output in `output/output.nc`.

## Input File Structure

| File | Description |
|------|-------------|
| `glm3.nml` | Main configuration file (Fortran namelist format) |
| `bcs/*.csv` | Boundary condition files (meteorology, inflows, outflows) |

## Configuration File Format

`glm3.nml` uses Fortran namelist format with multiple sections:
```fortran
&glm_setup
   sim_name = 'LakeName'
   max_layers = 500
/
&light
   Kw = 0.3
/
&mixing
   coef_mix_hyp = 0.5
/
&meteorology
   meteo_fl = 'bcs/meteo.csv'
   wind_factor = 1
   lw_factor = 1
   ch = 0.0013
/
&inflow
   inflow_fl = 'bcs/inflow1.csv','bcs/inflow2.csv'
/
&outflow
   outflow_fl = 'bcs/outflow.csv'
/
```

## Modifying Parameters with Python
```python
import re

def modify_nml(nml_path, params):
    with open(nml_path, 'r') as f:
        content = f.read()
    for param, value in params.items():
        pattern = rf"({param}\s*=\s*)[\d\.\-e]+"
        replacement = rf"\g<1>{value}"
        content = re.sub(pattern, replacement, content)
    with open(nml_path, 'w') as f:
        f.write(content)

# Example usage
modify_nml('glm3.nml', {'Kw': 0.25, 'wind_factor': 0.9})
```

## Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| GLM fails to start | Missing input files | Check bcs/ directory |
| No output generated | Invalid nml syntax | Check namelist format |
| Simulation crashes | Unrealistic parameters | Use values within valid ranges |

## Best Practices

- Always backup `glm3.nml` before modifying
- Run GLM after each parameter change to verify it works
- Check `output/` directory for results after each run
