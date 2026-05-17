# Generator Cost Functions Reference

## Polynomial Cost (Type 2)

Most common format. Cost as polynomial function of power output.

### MATPOWER Format

```
gencost = [MODEL, STARTUP, SHUTDOWN, NCOST, c(n-1), ..., c1, c0]
```

For quadratic (NCOST=3):
```
gencost = [2, 0, 0, 3, c2, c1, c0]
```

**Cost equation:** C(P) = c₂·P² + c₁·P + c₀

Where:
- P = real power output in MW
- c₂ = quadratic coefficient ($/MW²·hr)
- c₁ = linear coefficient ($/MW·hr)  
- c₀ = no-load cost ($/hr)

### Example

```python
# Generator with:
# - No-load cost: $100/hr
# - Incremental: $20/MWh at 0 MW, increasing $0.02/MWh per MW
gencost = [2, 0, 0, 3, 0.01, 20, 100]

# At P = 50 MW:
# Cost = 0.01*(50)² + 20*(50) + 100 = 25 + 1000 + 100 = $1125/hr
```

## Piecewise Linear Cost (Type 1)

Cost defined by breakpoints. Less common but used for non-convex costs.

### MATPOWER Format

```
gencost = [1, STARTUP, SHUTDOWN, N, P1, C1, P2, C2, ..., Pn, Cn]
```

Where (Pi, Ci) are power-cost breakpoints.

### Example

```python
# 3 breakpoints: (0, 0), (50, 1000), (100, 2500)
gencost = [1, 0, 0, 3, 0, 0, 50, 1000, 100, 2500]
```

## Marginal Cost

The marginal cost (cost of next MW) for polynomial:

```python
# Marginal cost at power P
marginal_cost = 2 * c2 * P + c1  # $/MWh
```

## Typical Values

| Generator Type | c₂ ($/MW²·hr) | c₁ ($/MWh) | c₀ ($/hr) |
|---------------|---------------|------------|-----------|
| Nuclear | 0.001 | 5-10 | 500-1000 |
| Coal | 0.005-0.01 | 15-25 | 200-400 |
| Gas CCGT | 0.01-0.02 | 25-40 | 100-200 |
| Gas Peaker | 0.02-0.05 | 50-80 | 50-100 |
