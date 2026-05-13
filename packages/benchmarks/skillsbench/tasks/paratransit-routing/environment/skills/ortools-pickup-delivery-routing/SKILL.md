---
name: ortools-pickup-delivery-routing
description: Model OR-Tools paired pickup-and-delivery routing problems, including PDPTW, dial-a-ride, paratransit, patient transport, and courier jobs with same-vehicle pairing, precedence, capacity, optional connected service, rider time windows, and vehicle shifts.
---

# Pickup And Delivery Routing

Use this skill when each job has related pickup and dropoff or delivery events that must be served together. Apply it after the base routing model has a time dimension and before solving.

## Implementation Flow

1. Create one pickup node and one dropoff node per job.
2. Add same-vehicle and precedence constraints for every pair.
3. Apply the customer-facing time windows and service-time convention from the problem statement.
4. Choose optional-service handling: independent pairs, or connected request sets.
5. After solving, postprocess connected sets, rebuild route sequences if needed, and re-audit feasibility before counting served jobs or writing output.

## Pair Structure

- Represent pickup and dropoff as separate service nodes connected by a shared job ID.
- Pickup demand is positive; dropoff demand is negative. Depot nodes have zero demand and zero service time.
- Add `routing.AddPickupAndDelivery(pickup_index, dropoff_index)` for each pair.
- Add explicit constraints for the actual business rules:
  - same vehicle: `routing.VehicleVar(pickup_index) == routing.VehicleVar(dropoff_index)`
  - pickup before dropoff: `time_dimension.CumulVar(pickup_index) <= time_dimension.CumulVar(dropoff_index)`

## Time Windows And Service Times

- Apply customer time windows to the service event promised to the customer. Appointment and dial-a-ride problems often constrain dropoff arrival; pickup windows can be derived by subtracting direct pickup-to-dropoff travel time from the dropoff window.
- If a problem statement gives explicit pickup and dropoff time-window formulas, implement those formulas directly. Service time belongs in the time transit from a node to the next node; do not change the stated window formula to compensate for service time unless the problem explicitly says to.

## Pair Constraint Skeleton

Use this pattern after adding the time dimension. It enforces the paired-service relationship for each job. Add optional-service logic separately after deciding whether jobs are independent pairs or members of connected request sets.

```python
solver = routing.solver()

for job in jobs:
    pickup_index = manager.NodeToIndex(job.pickup_node)
    dropoff_index = manager.NodeToIndex(job.dropoff_node)

    routing.AddPickupAndDelivery(pickup_index, dropoff_index)
    solver.Add(routing.VehicleVar(pickup_index) == routing.VehicleVar(dropoff_index))
    solver.Add(time_dimension.CumulVar(pickup_index) <= time_dimension.CumulVar(dropoff_index))

    if job.dropoff_window is not None:
        low, high = job.dropoff_window
        time_dimension.CumulVar(dropoff_index).SetRange(low, high)
    if job.pickup_window is not None:
        low, high = job.pickup_window
        time_dimension.CumulVar(pickup_index).SetRange(low, high)
```

## Optional And Connected Service

- First decide whether each optional job is independent or belongs to a connected request set. Independent jobs may be skipped on their own; connected request sets should be optimized as a group.
- For connected request sets, prefer the CP-style grouped disjunction pattern below when search quality matters. Treat it as a search-friendly relaxation: local search may keep partial groups, and postprocessing enforces the final all-or-none business rule.
- Some domains connect multiple pickup-delivery pairs for one passenger, order, shipment, or care plan. This is a special case: apply all-or-none handling only when the problem says a connected set must be fully served or fully rejected.
- For CP-style optional connected sets, put the set's pickup nodes in one disjunction with `max_cardinality=len(request_set)` and a very large group penalty, such as `len(request_set) * request_penalty`. This makes pickup service drive the served-job objective for the connected set.
- Add each corresponding dropoff node as optional with zero penalty. The pickup-delivery constraints still tie feasible served pairs together, while zero-penalty dropoff optionality avoids forcing orphan dropoffs when a pickup or connected set is skipped.
- Use this grouped-disjunction-plus-postprocessing pattern instead of hard equality constraints across the connected set when local search quality matters. Hard all-or-none constraints can make insertion and local search much harder on large optional pickup-delivery instances.
- This grouped-disjunction pattern may allow partial connected sets during search. If the domain treats partial connected sets as unserved, do not count partial sets as served; remove their service nodes and rebuild the route order, or reject the candidate if rebuilding breaks feasibility.

The complete modeling shape for connected optional pickup-delivery service is:

```python
solver = routing.solver()

for job in jobs:
    pickup_index = manager.NodeToIndex(job.pickup_node)
    dropoff_index = manager.NodeToIndex(job.dropoff_node)
    routing.AddPickupAndDelivery(pickup_index, dropoff_index)
    solver.Add(routing.VehicleVar(pickup_index) == routing.VehicleVar(dropoff_index))
    solver.Add(time_dimension.CumulVar(pickup_index) <= time_dimension.CumulVar(dropoff_index))

for request_set in connected_request_sets:
    pickup_indices = [manager.NodeToIndex(job.pickup_node) for job in request_set]
    routing.AddDisjunction(
        pickup_indices,
        len(request_set) * request_penalty,
        len(request_set),
    )

for job in jobs:
    routing.AddDisjunction([manager.NodeToIndex(job.dropoff_node)], 0)
```

## Postprocessing Connected Sets

For all-or-none grouped service, perform the following post-processing steps after extracting raw route order:

1. Identify connected groups whose pickup and dropoff nodes all appear in the extracted routes.
2. Keep only service stops belonging to complete groups.
3. Rebuild each remaining route by reconnecting kept stops in their original order between the route's original start and end depot.
4. Recompute arrival times, service starts, departures, and load along the rebuilt route.
5. Reject the rebuilt route if a shortcut arc is invalid, a service window is missed, the vehicle cannot return to the depot in time, or final load is nonzero.

```python
def complete_group_job_ids(groups, visited_nodes):
    complete = set()
    for group in groups:
        # group jobs expose job_id, pickup_node, and dropoff_node.
        if all(job.pickup_node in visited_nodes and job.dropoff_node in visited_nodes for job in group):
            complete.update(str(job.job_id) for job in group)
    return complete


def kept_service_nodes(route, complete_job_ids):
    return [
        stop.node
        for stop in route.stops
        if stop.kind in {"pickup", "dropoff"} and str(stop.job_id) in complete_job_ids
    ]
```

After filtering, audit the rebuilt sequence from scratch; do not reuse arrival times, loads, shortcut feasibility, depot-return feasibility, or served counts from the unfiltered route.

## Final Checks

- Extract the route order and verify every counted job has both pickup and dropoff on the same route, with pickup before dropoff.
- Verify no dropoff appears without its pickup, and no pickup is counted without its dropoff.
- For connected request sets, count the set only when all jobs in the set pass the paired-service check.
- When the requested output is route-only, write only the requested route fields; leave derived timing, load, violation counts, and objective summaries out if the verifier will recompute them.

## Ride Rules

- If ride time, maximum wait, or shift duration matters, add explicit constraints on the relevant time cumul variables.
