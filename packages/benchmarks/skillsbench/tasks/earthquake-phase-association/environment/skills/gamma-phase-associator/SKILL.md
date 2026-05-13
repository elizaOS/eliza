---
name: gamma-phase-associator
description: An overview of the python package for running the GaMMA earthquake phase association algorithm. The algorithm expects phase picks data and station data as input and produces (through unsupervised clustering) earthquake events with source information like earthquake location, origin time and magnitude. The skill explains commonly used functions and the expected input/output format.
---

# GaMMA Associator Library

## What is GaMMA?
GaMMA is an earthquake phase association algorithm that treats association as an unsupervised clustering problem. It uses multivariate Gaussian distribution to model the collection of phase picks of an event, and uses Expectation-Maximization to carry out pick assignment and estimate source parameters i.e., earthquake location, origin time, and magnitude.

`GaMMA` is a python library implementing the algorithm. For the input earthquake traces, this library assumes P/S wave picks have already been extracted. We provide documentation of its core API.

`Zhu, W., McBrearty, I. W., Mousavi, S. M., Ellsworth, W. L., & Beroza, G. C. (2022). Earthquake phase association using a Bayesian Gaussian mixture model. Journal of Geophysical Research: Solid Earth, 127(5).`

The skill is a derivative of the repo https://github.com/AI4EPS/GaMMA

## Installing GaMMA
`pip install git+https://github.com/wayneweiqiang/GaMMA.git`

## GaMMA core API


### `association`

#### Function Signature

```python
def association(picks, stations, config, event_idx0=0, method="BGMM", **kwargs)
```

#### Purpose

Associates seismic phase picks (P and S waves) to earthquake events using Bayesian or standard Gaussian Mixture Models. It clusters picks based on arrival time and amplitude information, then fits GMMs to estimate earthquake locations, times, and magnitudes.

#### 1. Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `picks` | DataFrame | required | Seismic phase pick data |
| `stations` | DataFrame | required | Station metadata with locations |
| `config` | dict | required | Configuration parameters |
| `event_idx0` | int | `0` | Starting event index for numbering |
| `method` | str | `"BGMM"` | `"BGMM"` (Bayesian) or `"GMM"` (standard) |

#### 2. Required DataFrame Columns

##### `picks` DataFrame

| Column | Type | Description | Example |
|--------|------|-------------|---------|
| `id` | str | Station identifier (must match `stations`) | `network.station.` or `network.station.location.channel` |
| `timestamp` | datetime/str | Pick arrival time (ISO format or datetime) | `"2019-07-04T22:00:06.084"` |
| `type` | str | Phase type: `"p"` or `"s"` (lowercase) | `"p"` |
| `prob` | float | Pick probability/weight (0-1) | `0.94` |
| `amp` | float | Amplitude in m/s (required if `use_amplitude=True`) | `0.000017` |

**Notes:**
- Timestamps must be in UTC or converted to UTC
- Phase types are forced to lowercase internally
- Picks with `amp == 0` or `amp == -1` are filtered when `use_amplitude=True`
- The DataFrame index is used to track pick identities in the output

##### `stations` DataFrame

| Column | Type | Description | Example |
|--------|------|-------------|---------|
| `id` | str | Station identifier | `"CI.CCC..BH"`|
| `x(km)` | float | X coordinate in km (projected) | `-35.6` |
| `y(km)` | float | Y coordinate in km (projected) | `45.2` |
| `z(km)` | float | Z coordinate (elevation, typically negative) | `-0.67` |

**Notes:**
- Coordinates should be in a projected local coordinate system (e.g., you can use the `pyproj` package)
- The `id` column must match the `id` values in the picks DataFrame (e.g., `network.station.` or `network.station.location.channel`)
- Group stations by unique `id`, identical attribute are collapsed to a single value and conflicting metadata are preseved as a sorted list.  

#### 3. Config Dictionary Keys

##### Required Keys

| Key | Type | Description | Example |
|-----|------|-------------|---------|
| `dims` | list[str] | Location dimensions to solve for | `["x(km)", "y(km)", "z(km)"]` |
| `min_picks_per_eq` | int | Minimum picks required per earthquake | `5` |
| `max_sigma11` | float | Maximum allowed time residual in seconds | `2.0` |
| `use_amplitude` | bool | Whether to use amplitude in clustering | `True` |
| `bfgs_bounds` | tuple | Bounds for BFGS optimization | `((-35, 92), (-128, 78), (0, 21), (None, None))` |
| `oversample_factor` | float | Factor for oversampling initial GMM components | `5.0` for `BGMM`, `1.0` for `GMM`|

**Notes on `dims`:**
- Options: `["x(km)", "y(km)", "z(km)"]`, `["x(km)", "y(km)"]`, or `["x(km)"]`

**Notes on `bfgs_bounds`:**
- Format: `((x_min, x_max), (y_min, y_max), (z_min, z_max), (None, None))`
- The last tuple is for time (unbounded)

##### Velocity Model Keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `vel` | dict | `{"p": 6.0, "s": 3.47}` | Uniform velocity model (km/s) |
| `eikonal` | dict/None | `None` | 1D velocity model for travel times |

##### DBSCAN Pre-clustering Keys (Optional)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `use_dbscan` | bool | `True` | Enable DBSCAN pre-clustering |
| `dbscan_eps` | float | `25` | Max time between picks (seconds) |
| `dbscan_min_samples` | int | `3` | Min samples in DBSCAN neighborhood |
| `dbscan_min_cluster_size` | int | `500` | Min cluster size for hierarchical splitting |
| `dbscan_max_time_space_ratio` | float | `10` | Max time/space ratio for splitting |

- `dbscan_eps` is obtained from `estimate_eps` Function

##### Filtering Keys (Optional)

| Key | Type | Default | Description |
|-----|------|-------------|
| `max_sigma22` | float | `1.0` | Max phase amplitude residual in log scale (required if `use_amplitude=True`) |
| `max_sigma12` | float | `1.0` | Max covariance |
| `max_sigma11` | float | `2.0` | Max phase time residual (s) |
| `min_p_picks_per_eq` | int | `0` | Min P-phase picks per event |
| `min_s_picks_per_eq` | int | `0` |Min S-phase picks per event |
| `min_stations` | int | `5` |Min unique stations per event |

##### Other Optional Keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `covariance_prior` | list[float] | auto | Prior for covariance `[time, amp]` |
| `ncpu` | int | auto | Number of CPUs for parallel processing |

#### 4. Return Values

Returns a tuple `(events, assignments)`:

##### `events` (list[dict])

List of dictionaries, each representing an associated earthquake:

| Key | Type | Description |
|-----|------|-------------|
| `time` | str | Origin time (ISO 8601 with milliseconds) |
| `magnitude` | float | Estimated magnitude (999 if `use_amplitude=False`) |
| `sigma_time` | float | Time uncertainty (seconds) |
| `sigma_amp` | float | Amplitude uncertainty (log10 scale) |
| `cov_time_amp` | float | Time-amplitude covariance |
| `gamma_score` | float | Association quality score |
| `num_picks` | int | Total picks assigned |
| `num_p_picks` | int | P-phase picks assigned |
| `num_s_picks` | int | S-phase picks assigned |
| `event_index` | int | Unique event index |
| `x(km)` | float | X coordinate of hypocenter |
| `y(km)` | float | Y coordinate of hypocenter |
| `z(km)` | float | Z coordinate (depth) |

##### `assignments` (list[tuple])

List of tuples `(pick_index, event_index, gamma_score)`:
- `pick_index`: Index in the original `picks` DataFrame
- `event_index`: Associated event index
- `gamma_score`: Probability/confidence of assignment


### `estimate_eps` Function Documentation

#### Function Signature

```python
def estimate_eps(stations, vp, sigma=2.0)
```

#### Purpose

Estimates an appropriate DBSCAN epsilon (eps) parameter for clustering seismic phase picks based on station spacing. The eps parameter controls the maximum time distance between picks that should be considered neighbors in the DBSCAN clustering algorithm.

#### 1. Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `stations` | DataFrame | required | Station metadata with 3D coordinates |
| `vp` | float | required | P-wave velocity in km/s |
| `sigma` | float | `2.0` | Number of standard deviations above the mean |

#### 2. Required DataFrame Columns

##### `stations` DataFrame

| Column | Type | Description | Example |
|--------|------|-------------|---------|
| `x(km)` | float | X coordinate in km | `-35.6` |
| `y(km)` | float | Y coordinate in km | `45.2` |
| `z(km)` | float | Z coordinate in km | `-0.67` |

#### 3. Return Value

| Type | Description |
|------|-------------|
| float | Epsilon value in **seconds** for use with DBSCAN clustering |

#### 4. Example Usage

```python
from gamma.utils import estimate_eps

# Assuming stations DataFrame is already prepared with x(km), y(km), z(km) columns
vp = 6.0  # P-wave velocity in km/s

# Estimate eps automatically based on station spacing
eps = estimate_eps(stations, vp, sigma=2.0)

# Use in config
config = {
    "use_dbscan": True,
    "dbscan_eps": eps,  # or use estimate_eps(stations, config["vel"]["p"])
    "dbscan_min_samples": 3,
    # ... other config options
}
```

##### Typical Usage Pattern

```python
from gamma.utils import association, estimate_eps

# Automatic eps estimation
config["dbscan_eps"] = estimate_eps(stations, config["vel"]["p"])

# Or manual override (common in practice)
config["dbscan_eps"] = 15  # seconds
```

#### 5. Practical Notes

- In example notebooks, the function is often **commented out** in favor of hardcoded values (10-15 seconds)
- Practitioners may prefer manual tuning for specific networks/regions
- Typical output values range from **10-20 seconds** depending on station density
- Useful when optimal eps is unknown or when working with new networks

#### 6. Related Configuration

The output is typically used with these config parameters:

```python
config["dbscan_eps"] = estimate_eps(stations, config["vel"]["p"])
config["dbscan_min_samples"] = 3
config["dbscan_min_cluster_size"] = 500
config["dbscan_max_time_space_ratio"] = 10
```
