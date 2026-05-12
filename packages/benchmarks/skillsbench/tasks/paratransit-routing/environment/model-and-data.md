# Paratransit Routing Model And Data

This document defines the data conventions, feasibility rules, objective, and route-output schema for the full-day dial-a-ride instance.

## Data Conventions

- `requests.json`: passengers in file order. Each passenger has a `passenger_id` and one or more trip requests.
- `t_matrix.csv`: square integer travel-time matrix in minutes. Negative entries are invalid arcs.
- `instance_config.json`: `nb_passengers`, `nb_trips`, `nb_vehicles`, `vehicle_capacity`, and `time_window_width`.
- Times are integer minutes after midnight; for example, `300` means 5:00 AM.
- `requests.json` and `t_matrix.csv` are intended to be parsed from disk with code. Avoid opening, printing, or copying the full request list or matrix into the model context; compact summaries are enough for debugging.

Let `n` be the number of trips after flattening `requests.json` by passenger order, then trip-list order.

- Node `0`: start depot.
- Nodes `1..n`: pickups.
- Nodes `n+1..2n`: dropoffs.
- Node `2n+1`: end depot.

For flattened trip index `i` starting at `0`, pickup node is `1 + i` and dropoff node is `1 + n + i`. Matrix rows and columns follow this node order.

## Feasibility Rules

- A served trip has exactly one pickup and one dropoff.
- Pickup and dropoff for a served trip are on the same vehicle, with pickup before dropoff.
- Trips for the same passenger form one request set. A request set counts as served only when every trip in that passenger's set is served; otherwise all trips in that set are unserved.
- Pickup service time is `pickup_service_time`; dropoff service time is `dropoff_service_time`.
- `arrival_time` is the service start time after waiting. `departure_time` must be at least `arrival_time + service_time`.
- Vehicle load increases by `passenger_count` at pickup and decreases by `passenger_count` at dropoff.
- Vehicle load must stay between `0` and `vehicle_capacity`.
- Dropoff time window: `expected_arrival_time - time_window_width <= arrival_time <= expected_arrival_time`.
- Pickup time window: `expected_arrival_time - time_window_width - direct_travel_time <= arrival_time <= expected_arrival_time - direct_travel_time`, where `direct_travel_time` is the matrix value from the pickup node to the dropoff node.
- Each used route starts at node `0` at an hourly shift start from `300` through `840` inclusive.
- Each used route ends at node `2n+1` no later than `1320`.
- Each vehicle shift is 8 hours, so a route must end within 480 minutes of its start time.
- Routes must not use negative travel-time arcs.

## Objective

Maximize the number of served trips; higher is better. The verifier recomputes arrivals, departures, loads, served trips, route metrics, and feasibility from the submitted node sequences.

## Output Schema

Write `/root/report.json` as a JSON object with this structure. Placeholder values below show the required shape only.

```json
{
  "routes": [
    {
      "vehicle_id": "V0",
      "start_time": 300,
      "node_sequence": [0, 1, 516, 1031]
    }
  ]
}
```

Each route has a `vehicle_id` string, a `start_time` integer in minutes after midnight, and a `node_sequence` list of integer node IDs in visit order. The first node must be `0`; the last node must be `2n+1`. Omit unused vehicles.

Exact route sequences are not unique. Solutions are judged by feasibility and served trip count.
