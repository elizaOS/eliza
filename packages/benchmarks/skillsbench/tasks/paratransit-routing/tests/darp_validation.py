from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
from typing import Any, Optional, Union

import numpy as np
from ortools.constraint_solver import pywrapcp, routing_enums_pb2


PathLike = Union[str, Path]

REQUEST_PENALTY = 10_000
ARC_COST_SCALING_FACTOR = 1
OPERATING_WINDOW = (5 * 60, 22 * 60)
SHIFT_DURATION = 8 * 60
SHIFT_START_STEP = 60


def load_json(path: PathLike) -> Any:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def as_int(value: Any, field: str = "value") -> int:
    if isinstance(value, bool):
        raise AssertionError(f"{field} must be an integer, not a boolean")
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        assert abs(value - round(value)) < 1e-9, f"{field} must be integer-like, got {value}"
        return int(round(value))
    if isinstance(value, str):
        stripped = value.strip()
        if "." in stripped:
            parsed = float(stripped)
            assert abs(parsed - round(parsed)) < 1e-9, f"{field} must be integer-like, got {value}"
            return int(round(parsed))
        return int(stripped)
    return int(value)


def flatten_requests(requests: list[dict[str, Any]]) -> list[dict[str, Any]]:
    trips: list[dict[str, Any]] = []
    for passenger in requests:
        passenger_id = str(passenger["passenger_id"])
        for trip in passenger["trips"]:
            flat_index = len(trips)
            trips.append(
                {
                    "passenger_id": passenger_id,
                    "trip_id": str(trip["trip_id"]),
                    "flat_index": flat_index,
                    "pickup_node": 1 + flat_index,
                    "dropoff_node": None,
                    "solver_pickup_node": flat_index,
                    "solver_dropoff_node": None,
                    "passenger_count": as_int(trip["passenger_count"], "passenger_count"),
                    "pickup_service_time": as_int(trip["pickup_service_time"], "pickup_service_time"),
                    "dropoff_service_time": as_int(trip["dropoff_service_time"], "dropoff_service_time"),
                    "expected_arrival_time": as_int(trip["expected_arrival_time"], "expected_arrival_time"),
                }
            )
    n = len(trips)
    for trip in trips:
        trip["dropoff_node"] = 1 + n + trip["flat_index"]
        trip["solver_dropoff_node"] = n + trip["flat_index"]
    return trips


def passenger_request_sets(requests: list[dict[str, Any]]) -> list[list[int]]:
    request_sets: list[list[int]] = []
    flat_index = 0
    for passenger in requests:
        nodes: list[int] = []
        for _trip in passenger["trips"]:
            nodes.append(flat_index)
            flat_index += 1
        if nodes:
            request_sets.append(nodes)
    return request_sets


def load_matrix(path: PathLike) -> np.ndarray:
    matrix = np.loadtxt(path, delimiter=",", dtype=np.int64)
    assert matrix.ndim == 2 and matrix.shape[0] == matrix.shape[1], f"travel-time matrix must be square, got {matrix.shape}"
    return matrix


def allowed_shift_starts() -> list[int]:
    return [
        time
        for time in range(0, 24 * 60 + 1, SHIFT_START_STEP)
        if time >= OPERATING_WINDOW[0]
        if time <= OPERATING_WINDOW[1] - SHIFT_DURATION
    ]


def source_travel_matrix(external_matrix: np.ndarray, n: int, m: int) -> np.ndarray:
    dtype = np.int32
    missing_arc_cost = np.iinfo(dtype).max // 2
    travel_times = np.array(external_matrix, dtype=dtype)
    positive = travel_times[travel_times > 0]
    max_positive = int(positive.max()) if positive.size else 0
    very_long_travel_time = (2 * n + 2) * (max_positive + 1)
    assert very_long_travel_time <= missing_arc_cost, "missing-arc sentinel may be too small for this instance"
    travel_times = np.where(travel_times < 0, missing_arc_cost, travel_times)
    assert travel_times.shape == (2 * n + 2, 2 * n + 2), "external matrix has unexpected size"

    nb_nodes = 2 * n + 2 * m
    result = np.full((nb_nodes, nb_nodes), missing_arc_cost, dtype=dtype)
    result[: 2 * n, : 2 * n] = travel_times[1:-1, 1:-1]
    result[: 2 * n, 2 * n + m : 2 * n + 2 * m] = np.tile(travel_times[1:-1, [-1]], (1, m))
    result[2 * n : 2 * n + m, : 2 * n] = np.tile(travel_times[[0], 1:-1], (m, 1))
    result[list(range(2 * n, 2 * n + m)), list(range(2 * n + m, 2 * n + 2 * m))] = 0
    return result


def build_source_node_arrays(
    trips: list[dict[str, Any]],
    solver_matrix: np.ndarray,
    num_vehicles: int,
    time_window_width: int,
) -> tuple[list[int], list[int], list[tuple[int, int]], int]:
    n = len(trips)
    nb_nodes = 2 * n + 2 * num_vehicles
    service_times = [0] * nb_nodes
    demands = [0] * nb_nodes
    time_windows = [(0, 0) for _node in range(nb_nodes)]

    for trip in trips:
        pickup = int(trip["solver_pickup_node"])
        dropoff = int(trip["solver_dropoff_node"])
        service_times[pickup] = int(trip["pickup_service_time"])
        service_times[dropoff] = int(trip["dropoff_service_time"])
        demands[pickup] = int(trip["passenger_count"])
        demands[dropoff] = -int(trip["passenger_count"])
        eta = int(trip["expected_arrival_time"])
        direct_driving_time = int(solver_matrix[pickup, dropoff])
        time_windows[pickup] = (
            int(eta - time_window_width - direct_driving_time),
            int(eta - direct_driving_time),
        )
        time_windows[dropoff] = (
            int(eta - time_window_width),
            int(eta),
        )

    end_depots = list(range(2 * n + num_vehicles, 2 * n + 2 * num_vehicles))
    time_horizon = int(
        max(
            time_windows[int(trip["solver_dropoff_node"])][1]
            + service_times[int(trip["solver_dropoff_node"])]
            + int(solver_matrix[int(trip["solver_dropoff_node"]), depot])
            for trip in trips
            for depot in end_depots
        )
    )
    time_horizon = max(time_horizon, OPERATING_WINDOW[1])
    for node in list(range(2 * n, 2 * n + 2 * num_vehicles)):
        time_windows[node] = OPERATING_WINDOW
    return service_times, demands, time_windows, time_horizon


def source_pickup_window(trip: dict[str, Any], matrix: np.ndarray, time_window_width: int) -> tuple[int, int]:
    direct = int(matrix[int(trip["pickup_node"]), int(trip["dropoff_node"])])
    if direct < 0:
        direct = np.iinfo(np.int32).max // 2
    eta = int(trip["expected_arrival_time"])
    return eta - time_window_width - direct, eta - direct


def source_dropoff_window(trip: dict[str, Any], time_window_width: int) -> tuple[int, int]:
    eta = int(trip["expected_arrival_time"])
    return eta - time_window_width, eta


def service_time_for_stop(stop: dict[str, Any], trip_by_id: dict[str, dict[str, Any]]) -> int:
    stop_type = stop.get("stop_type")
    if stop_type == "pickup":
        trip = trip_by_id.get(str(stop.get("trip_id")))
        return int(trip["pickup_service_time"]) if trip else 0
    if stop_type == "dropoff":
        trip = trip_by_id.get(str(stop.get("trip_id")))
        return int(trip["dropoff_service_time"]) if trip else 0
    return 0


def collect_trip_events(routes: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    events: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for route_index, route in enumerate(routes):
        vehicle_id = str(route.get("vehicle_id", f"route-{route_index}"))
        for order_index, stop in enumerate(route.get("stops", [])):
            stop_type = stop.get("stop_type")
            if stop_type in {"pickup", "dropoff"}:
                trip_id = str(stop.get("trip_id", ""))
                events[trip_id].append(
                    {
                        "kind": stop_type,
                        "vehicle_id": vehicle_id,
                        "route_index": route_index,
                        "order_index": order_index,
                        "arrival_time": as_int(stop.get("arrival_time"), "arrival_time"),
                        "departure_time": as_int(stop.get("departure_time"), "departure_time"),
                        "node_index": as_int(stop.get("node_index"), "node_index"),
                        "passenger_id": str(stop.get("passenger_id", "")),
                    }
                )
    return dict(events)


def _expected_stop_type(node: int, n: int) -> Optional[str]:
    if node == 0:
        return "start_depot"
    if 1 <= node <= n:
        return "pickup"
    if n + 1 <= node <= 2 * n:
        return "dropoff"
    if node == 2 * n + 1:
        return "end_depot"
    return None


def _demand_for_stop(stop: dict[str, Any], trip_by_id: dict[str, dict[str, Any]]) -> int:
    stop_type = stop.get("stop_type")
    if stop_type == "pickup":
        trip = trip_by_id.get(str(stop.get("trip_id")))
        return int(trip["passenger_count"]) if trip else 0
    if stop_type == "dropoff":
        trip = trip_by_id.get(str(stop.get("trip_id")))
        return -int(trip["passenger_count"]) if trip else 0
    return 0


def _trip_for_node(node: int, trips: list[dict[str, Any]], n: int) -> dict[str, Any] | None:
    if 1 <= node <= n:
        return trips[node - 1]
    if n + 1 <= node <= 2 * n:
        return trips[node - n - 1]
    return None


def _service_time_for_node(node: int, trips: list[dict[str, Any]], n: int) -> int:
    trip = _trip_for_node(node, trips, n)
    if trip is None:
        return 0
    if 1 <= node <= n:
        return int(trip["pickup_service_time"])
    return int(trip["dropoff_service_time"])


def _demand_for_node(node: int, trips: list[dict[str, Any]], n: int) -> int:
    trip = _trip_for_node(node, trips, n)
    if trip is None:
        return 0
    demand = int(trip["passenger_count"])
    return demand if 1 <= node <= n else -demand


def route_solution_to_schedule(
    report: dict[str, Any],
    trips: list[dict[str, Any]],
    matrix: np.ndarray,
    config: dict[str, Any],
) -> dict[str, Any]:
    """Convert the compact route-only public output into a fully audited schedule."""
    routes_in = report.get("routes")
    assert isinstance(routes_in, list), "report.routes must be a list"

    n = len(trips)
    end_depot = 2 * n + 1
    allowed_starts = set(allowed_shift_starts())
    routes: list[dict[str, Any]] = []
    seen_vehicle_ids: set[str] = set()

    for route_index, route in enumerate(routes_in):
        assert isinstance(route, dict), f"route {route_index} must be an object"
        vehicle_id = str(route.get("vehicle_id", f"V{route_index}"))
        assert vehicle_id not in seen_vehicle_ids, f"vehicle_id {vehicle_id} appears in multiple routes"
        seen_vehicle_ids.add(vehicle_id)

        start_time = as_int(route.get("start_time"), f"route {route_index} start_time")
        assert start_time in allowed_starts, f"route {route_index} start_time {start_time} is not an allowed shift start"

        raw_sequence = route.get("node_sequence")
        assert isinstance(raw_sequence, list), f"route {route_index} node_sequence must be a list"
        node_sequence = [as_int(node, f"route {route_index} node_sequence[{i}]") for i, node in enumerate(raw_sequence)]
        assert len(node_sequence) >= 3, f"route {route_index} must include depots and at least one service stop"
        assert node_sequence[0] == 0, f"route {route_index} must start at node 0"
        assert node_sequence[-1] == end_depot, f"route {route_index} must end at node {end_depot}"
        assert 0 not in node_sequence[1:], f"route {route_index} may only use start depot node 0 as the first node"
        assert end_depot not in node_sequence[:-1], f"route {route_index} may only use end depot node {end_depot} as the last node"
        assert any(1 <= node <= 2 * n for node in node_sequence), f"route {route_index} contains no pickup/dropoff nodes"

        stops: list[dict[str, Any]] = [
            {
                "node_index": 0,
                "stop_type": "start_depot",
                "arrival_time": start_time,
                "departure_time": start_time,
                "load_after_departure": 0,
            }
        ]
        departure_time = start_time
        load = 0

        for order_index, node in enumerate(node_sequence[1:], start=1):
            assert 0 <= node < matrix.shape[0], f"route {route_index} node {node} is outside the matrix"
            expected_type = _expected_stop_type(node, n)
            assert expected_type is not None, f"route {route_index} node {node} is outside the node mapping"

            prev_node = int(stops[-1]["node_index"])
            travel = int(matrix[prev_node, node])
            arrival_time = departure_time if travel < 0 else departure_time + travel

            trip = _trip_for_node(node, trips, n)
            if expected_type == "pickup" and trip is not None:
                low, _high = source_pickup_window(trip, matrix, int(config["time_window_width"]))
                arrival_time = max(arrival_time, low)
            elif expected_type == "dropoff" and trip is not None:
                low, _high = source_dropoff_window(trip, int(config["time_window_width"]))
                arrival_time = max(arrival_time, low)

            service_time = _service_time_for_node(node, trips, n)
            load += _demand_for_node(node, trips, n)
            stop: dict[str, Any] = {
                "node_index": node,
                "stop_type": expected_type,
                "arrival_time": int(arrival_time),
                "departure_time": int(arrival_time + service_time),
                "load_after_departure": int(load),
            }
            if trip is not None:
                stop["trip_id"] = trip["trip_id"]
                stop["passenger_id"] = trip["passenger_id"]
            stops.append(stop)
            departure_time = int(stop["departure_time"])

        routes.append(
            {
                "vehicle_id": vehicle_id,
                "route_travel_time_minutes": 0.0,
                "route_service_time_minutes": 0.0,
                "route_duration_minutes": 0.0,
                "stops": stops,
            }
        )

    schedule: dict[str, Any] = {
        "objective_value": 0,
        "served_trip_count": 0,
        "unserved_trip_count": 0,
        "vehicles_used": 0,
        "total_travel_time_minutes": 0.0,
        "total_service_time_minutes": 0.0,
        "total_route_duration_minutes": 0.0,
        "unserved_trip_ids": [],
        "routes": routes,
    }
    metrics = recompute_schedule_metrics(schedule, trips, matrix, config)
    for key in [
        "objective_value",
        "served_trip_count",
        "unserved_trip_count",
        "vehicles_used",
        "total_travel_time_minutes",
        "total_service_time_minutes",
        "total_route_duration_minutes",
        "unserved_trip_ids",
    ]:
        schedule[key] = metrics[key]
    for route, route_metrics in zip(schedule["routes"], metrics["route_metrics"]):
        route["route_travel_time_minutes"] = route_metrics["route_travel_time_minutes"]
        route["route_service_time_minutes"] = route_metrics["route_service_time_minutes"]
        route["route_duration_minutes"] = route_metrics["route_duration_minutes"]
    return schedule


def validate_routes_for_schedule(
    schedule: dict[str, Any],
    trips: list[dict[str, Any]],
    matrix: np.ndarray,
    config: dict[str, Any],
) -> list[str]:
    errors: list[str] = []
    n = len(trips)
    end_depot = 2 * n + 1
    capacity = int(config["vehicle_capacity"])
    width = int(config["time_window_width"])
    trip_by_id = {t["trip_id"]: t for t in trips}
    allowed_starts = set(allowed_shift_starts())

    routes = schedule.get("routes", [])
    if not isinstance(routes, list):
        return ["schedule.routes must be a list"]

    for route_index, route in enumerate(routes):
        stops = route.get("stops")
        if not isinstance(stops, list) or not stops:
            errors.append(f"route {route_index} must contain a non-empty stops list")
            continue
        first_node = as_int(stops[0].get("node_index"), f"route {route_index} first node")
        last_node = as_int(stops[-1].get("node_index"), f"route {route_index} last node")
        if first_node != 0:
            errors.append(f"route {route_index} must start at node 0, got {first_node}")
        if last_node != end_depot:
            errors.append(f"route {route_index} must end at node {end_depot}, got {last_node}")

        start_time = as_int(stops[0].get("arrival_time"), f"route {route_index} start arrival_time")
        end_time = as_int(stops[-1].get("arrival_time"), f"route {route_index} end arrival_time")
        if start_time not in allowed_starts:
            errors.append(f"route {route_index} starts at {start_time}, expected one of {sorted(allowed_starts)}")
        if end_time < OPERATING_WINDOW[0] or end_time > OPERATING_WINDOW[1]:
            errors.append(f"route {route_index} ends at {end_time}, outside operating window {OPERATING_WINDOW}")
        if end_time - start_time > SHIFT_DURATION:
            errors.append(f"route {route_index} duration {end_time - start_time} exceeds shift duration {SHIFT_DURATION}")

        expected_load = 0
        for order_index, stop in enumerate(stops):
            node = as_int(stop.get("node_index"), f"route {route_index} stop {order_index} node_index")
            if node < 0 or node >= matrix.shape[0]:
                errors.append(f"route {route_index} stop {order_index} has out-of-range node {node}")
                continue
            stop_type = str(stop.get("stop_type", ""))
            expected_type = _expected_stop_type(node, n)
            if stop_type != expected_type:
                errors.append(f"route {route_index} stop {order_index} node {node} has stop_type {stop_type}, expected {expected_type}")

            if stop_type in {"pickup", "dropoff"}:
                trip_id = str(stop.get("trip_id", ""))
                passenger_id = str(stop.get("passenger_id", ""))
                trip = trip_by_id.get(trip_id)
                if trip is None:
                    errors.append(f"route {route_index} stop {order_index} references unknown trip_id {trip_id}")
                else:
                    expected_node = int(trip["pickup_node"] if stop_type == "pickup" else trip["dropoff_node"])
                    if node != expected_node:
                        errors.append(f"route {route_index} stop {order_index} trip {trip_id} uses node {node}, expected {expected_node}")
                    if passenger_id != trip["passenger_id"]:
                        errors.append(f"route {route_index} stop {order_index} trip {trip_id} has passenger_id {passenger_id}, expected {trip['passenger_id']}")

            arrival = as_int(stop.get("arrival_time"), f"route {route_index} stop {order_index} arrival_time")
            departure = as_int(stop.get("departure_time"), f"route {route_index} stop {order_index} departure_time")
            service_time = service_time_for_stop(stop, trip_by_id)
            if departure < arrival + service_time:
                errors.append(
                    f"route {route_index} stop {order_index} departs at {departure}, before arrival {arrival} + service {service_time}"
                )

            expected_load += _demand_for_stop(stop, trip_by_id)
            reported_load = as_int(stop.get("load_after_departure"), f"route {route_index} stop {order_index} load_after_departure")
            if reported_load != expected_load:
                errors.append(
                    f"route {route_index} stop {order_index} load_after_departure {reported_load} does not match propagated load {expected_load}"
                )
            if reported_load < 0:
                errors.append(f"route {route_index} stop {order_index} has negative load {reported_load}")
            if reported_load > capacity:
                errors.append(f"route {route_index} stop {order_index} exceeds capacity {capacity} with load {reported_load}")

            if order_index > 0:
                prev = stops[order_index - 1]
                prev_node = as_int(prev.get("node_index"), f"route {route_index} previous node")
                prev_departure = as_int(prev.get("departure_time"), f"route {route_index} previous departure")
                travel = int(matrix[prev_node, node])
                if travel < 0:
                    errors.append(f"route {route_index} uses invalid arc {prev_node}->{node}")
                elif arrival < prev_departure + travel:
                    errors.append(
                        f"route {route_index} stop {order_index} arrives at {arrival}, before previous departure {prev_departure} + travel {travel}"
                    )

        if expected_load != 0:
            errors.append(f"route {route_index} ends with propagated load {expected_load}, expected 0")

    events = collect_trip_events(routes)
    paired_trip_ids: set[str] = set()
    for trip in trips:
        trip_id = trip["trip_id"]
        pickup_events = [e for e in events.get(trip_id, []) if e["kind"] == "pickup"]
        dropoff_events = [e for e in events.get(trip_id, []) if e["kind"] == "dropoff"]
        if not pickup_events and not dropoff_events:
            continue
        if len(pickup_events) != 1:
            errors.append(f"trip {trip_id} has {len(pickup_events)} pickup events")
        if len(dropoff_events) != 1:
            errors.append(f"trip {trip_id} has {len(dropoff_events)} dropoff events")
        if len(pickup_events) == 1 and len(dropoff_events) == 1:
            pickup = pickup_events[0]
            dropoff = dropoff_events[0]
            if pickup["vehicle_id"] != dropoff["vehicle_id"]:
                errors.append(f"trip {trip_id} pickup/dropoff are on different vehicles")
            if pickup["order_index"] >= dropoff["order_index"]:
                errors.append(f"trip {trip_id} pickup is not before dropoff")
            if pickup["vehicle_id"] == dropoff["vehicle_id"] and pickup["order_index"] < dropoff["order_index"]:
                paired_trip_ids.add(trip_id)
            pickup_low, pickup_high = source_pickup_window(trip, matrix, width)
            dropoff_low, dropoff_high = source_dropoff_window(trip, width)
            if pickup["arrival_time"] < pickup_low or pickup["arrival_time"] > pickup_high:
                errors.append(f"trip {trip_id} pickup arrival {pickup['arrival_time']} is outside [{pickup_low}, {pickup_high}]")
            if dropoff["arrival_time"] < dropoff_low or dropoff["arrival_time"] > dropoff_high:
                errors.append(f"trip {trip_id} dropoff arrival {dropoff['arrival_time']} is outside [{dropoff_low}, {dropoff_high}]")

    trip_ids_by_passenger: dict[str, list[str]] = defaultdict(list)
    for trip in trips:
        trip_ids_by_passenger[trip["passenger_id"]].append(trip["trip_id"])
    for passenger_id, trip_ids in trip_ids_by_passenger.items():
        served_in_group = [trip_id for trip_id in trip_ids if trip_id in paired_trip_ids]
        if served_in_group and len(served_in_group) != len(trip_ids):
            errors.append(
                f"passenger {passenger_id} has a partially served request set: "
                f"{len(served_in_group)}/{len(trip_ids)} trips are paired"
            )

    metrics = recompute_schedule_metrics(schedule, trips, matrix, config)
    listed_unserved = set(str(x) for x in schedule.get("unserved_trip_ids", []))
    served = set(metrics["served_trip_ids"])
    if listed_unserved & served:
        errors.append(f"trips are both served and listed unserved: {sorted(listed_unserved & served)[:10]}")
    return errors


def recompute_schedule_metrics(
    schedule: dict[str, Any],
    trips: list[dict[str, Any]],
    matrix: np.ndarray,
    config: dict[str, Any],
) -> dict[str, Any]:
    capacity = int(config["vehicle_capacity"])
    width = int(config["time_window_width"])
    trip_by_id = {t["trip_id"]: t for t in trips}
    routes = schedule.get("routes", [])

    route_metrics: list[dict[str, Any]] = []
    total_travel = 0.0
    total_service = 0.0
    total_duration = 0.0
    vehicles_used = 0
    max_vehicle_load = 0
    capacity_violations = 0
    invalid_arc_violations = 0

    for route in routes:
        stops = route.get("stops", [])
        route_travel = 0.0
        route_service = 0.0
        route_duration = 0.0
        has_trip_stop = False
        expected_load = 0

        for order_index, stop in enumerate(stops):
            stop_type = stop.get("stop_type")
            if stop_type in {"pickup", "dropoff"}:
                has_trip_stop = True
            route_service += service_time_for_stop(stop, trip_by_id)
            expected_load += _demand_for_stop(stop, trip_by_id)
            reported_load = as_int(stop.get("load_after_departure"), "load_after_departure")
            max_vehicle_load = max(max_vehicle_load, reported_load)
            if reported_load != expected_load or reported_load < 0 or reported_load > capacity:
                capacity_violations += 1
            if order_index > 0:
                prev_node = as_int(stops[order_index - 1].get("node_index"), "previous node_index")
                node = as_int(stop.get("node_index"), "node_index")
                travel = int(matrix[prev_node, node])
                if travel < 0:
                    invalid_arc_violations += 1
                else:
                    route_travel += travel

        if len(stops) >= 2:
            route_duration = max(
                0.0,
                float(as_int(stops[-1].get("arrival_time"), "last arrival_time") - as_int(stops[0].get("arrival_time"), "first arrival_time")),
            )
        if has_trip_stop:
            vehicles_used += 1

        route_metrics.append(
            {
                "vehicle_id": route.get("vehicle_id"),
                "route_travel_time_minutes": float(route_travel),
                "route_service_time_minutes": float(route_service),
                "route_duration_minutes": float(route_duration),
            }
        )
        total_travel += route_travel
        total_service += route_service
        total_duration += route_duration

    events = collect_trip_events(routes)
    paired_trip_ids: set[str] = set()
    pairing_violations = 0
    time_window_violations = 0
    for trip in trips:
        pickup_events = [e for e in events.get(trip["trip_id"], []) if e["kind"] == "pickup"]
        dropoff_events = [e for e in events.get(trip["trip_id"], []) if e["kind"] == "dropoff"]
        if len(pickup_events) == 1 and len(dropoff_events) == 1:
            pickup = pickup_events[0]
            dropoff = dropoff_events[0]
            paired = (
                pickup["vehicle_id"] == dropoff["vehicle_id"]
                and pickup["order_index"] < dropoff["order_index"]
                and pickup["node_index"] == int(trip["pickup_node"])
                and dropoff["node_index"] == int(trip["dropoff_node"])
                and pickup["passenger_id"] == trip["passenger_id"]
                and dropoff["passenger_id"] == trip["passenger_id"]
            )
            if paired:
                paired_trip_ids.add(trip["trip_id"])
                pickup_low, pickup_high = source_pickup_window(trip, matrix, width)
                dropoff_low, dropoff_high = source_dropoff_window(trip, width)
                if pickup["arrival_time"] < pickup_low or pickup["arrival_time"] > pickup_high:
                    time_window_violations += 1
                if dropoff["arrival_time"] < dropoff_low or dropoff["arrival_time"] > dropoff_high:
                    time_window_violations += 1
            else:
                pairing_violations += 1
        elif pickup_events or dropoff_events:
            pairing_violations += 1

    trip_ids_by_passenger: dict[str, list[str]] = defaultdict(list)
    for trip in trips:
        trip_ids_by_passenger[trip["passenger_id"]].append(trip["trip_id"])

    served_trip_ids: list[str] = []
    for trip_ids in trip_ids_by_passenger.values():
        served_in_group = [trip_id for trip_id in trip_ids if trip_id in paired_trip_ids]
        if len(served_in_group) == len(trip_ids):
            served_trip_ids.extend(trip_ids)
        elif served_in_group:
            pairing_violations += 1

    served_set = set(served_trip_ids)
    unserved_trip_ids = [trip["trip_id"] for trip in trips if trip["trip_id"] not in served_set]

    return {
        "objective_value": len(served_trip_ids),
        "served_trip_count": len(served_trip_ids),
        "unserved_trip_count": len(unserved_trip_ids),
        "unserved_trip_ids": unserved_trip_ids,
        "vehicles_used": vehicles_used,
        "total_travel_time_minutes": float(total_travel),
        "total_service_time_minutes": float(total_service),
        "total_route_duration_minutes": float(total_duration),
        "route_metrics": route_metrics,
        "served_trip_ids": served_trip_ids,
        "max_vehicle_load": int(max_vehicle_load),
        "time_window_violations": int(time_window_violations),
        "capacity_violations": int(capacity_violations),
        "pairing_violations": int(pairing_violations),
        "invalid_arc_violations": int(invalid_arc_violations),
    }


def validate_with_source_locked_model(
    schedule: dict[str, Any],
    requests: list[dict[str, Any]],
    trips: list[dict[str, Any]],
    matrix: np.ndarray,
    config: dict[str, Any],
) -> list[str]:
    """Replay the reported routes as locked routes in the source-style OR-Tools model."""
    errors: list[str] = []
    n = len(trips)
    num_vehicles = int(config["nb_vehicles"])
    capacity = int(config["vehicle_capacity"])
    width = int(config["time_window_width"])
    try:
        solver_matrix = source_travel_matrix(matrix, n, num_vehicles)
        service_times, demands, time_windows, horizon = build_source_node_arrays(trips, solver_matrix, num_vehicles, width)
        start_depots = list(range(2 * n, 2 * n + num_vehicles))
        end_depots = list(range(2 * n + num_vehicles, 2 * n + 2 * num_vehicles))
        manager = pywrapcp.RoutingIndexManager(solver_matrix.shape[0], num_vehicles, start_depots, end_depots)
        routing = pywrapcp.RoutingModel(manager)

        nodes_from_indices = [manager.IndexToNode(index) for index in range(manager.GetNumberOfIndices())]
        travel_plus_service = solver_matrix + np.array(service_times, dtype=solver_matrix.dtype)[:, np.newaxis]
        time_callback_index = routing.RegisterTransitMatrix(travel_plus_service[np.ix_(nodes_from_indices, nodes_from_indices)].tolist())
        demand_callback_index = routing.RegisterUnaryTransitVector([demands[node] for node in nodes_from_indices])
        cost_callback_index = routing.RegisterTransitMatrix((travel_plus_service // ARC_COST_SCALING_FACTOR)[np.ix_(nodes_from_indices, nodes_from_indices)].tolist())
        routing.SetArcCostEvaluatorOfAllVehicles(cost_callback_index)

        routing.AddDimension(time_callback_index, horizon, horizon, False, "Time")
        time_dimension = routing.GetDimensionOrDie("Time")
        routing.AddDimension(demand_callback_index, 0, capacity, True, "Load")

        for vehicle in range(num_vehicles):
            time_dimension.SetSpanUpperBoundForVehicle(SHIFT_DURATION, vehicle)
        for trip in trips:
            pickup_index = manager.NodeToIndex(int(trip["solver_pickup_node"]))
            dropoff_index = manager.NodeToIndex(int(trip["solver_dropoff_node"]))
            routing.AddPickupAndDelivery(pickup_index, dropoff_index)
            routing.solver().Add(routing.VehicleVar(pickup_index) == routing.VehicleVar(dropoff_index))
            routing.solver().Add(time_dimension.CumulVar(pickup_index) <= time_dimension.CumulVar(dropoff_index))
        for request_set in passenger_request_sets(requests):
            routing.AddDisjunction(
                [manager.NodeToIndex(node) for node in request_set],
                len(request_set) * REQUEST_PENALTY,
                len(request_set),
            )
        for trip in trips:
            routing.AddDisjunction([manager.NodeToIndex(int(trip["solver_dropoff_node"]))], 0)
        for node in range(0, 2 * n):
            time_dimension.CumulVar(manager.NodeToIndex(node)).SetRange(*time_windows[node])
        for vehicle in range(num_vehicles):
            time_dimension.CumulVar(routing.Start(vehicle)).SetRange(*time_windows[start_depots[vehicle]])
            time_dimension.CumulVar(routing.End(vehicle)).SetRange(*time_windows[end_depots[vehicle]])
            time_dimension.CumulVar(routing.Start(vehicle)).SetValues(allowed_shift_starts())

        locked_routes: list[list[int]] = [[] for _vehicle in range(num_vehicles)]
        seen_vehicles: set[int] = set()
        for route_index, route in enumerate(schedule.get("routes", [])):
            digits = "".join(ch for ch in str(route.get("vehicle_id", "")) if ch.isdigit())
            vehicle = int(digits) if digits else route_index
            if vehicle < 0 or vehicle >= num_vehicles:
                errors.append(f"route {route_index} vehicle {vehicle} is outside 0..{num_vehicles - 1}")
                continue
            if vehicle in seen_vehicles:
                errors.append(f"vehicle {vehicle} appears in multiple routes")
                continue
            seen_vehicles.add(vehicle)
            stops = route.get("stops", [])
            if not stops:
                continue
            start_time = as_int(stops[0].get("arrival_time"), f"route {route_index} start arrival_time")
            end_time = as_int(stops[-1].get("arrival_time"), f"route {route_index} end arrival_time")
            time_dimension.CumulVar(routing.Start(vehicle)).SetValues([start_time])
            time_dimension.CumulVar(routing.End(vehicle)).SetRange(start_time, end_time)
            for stop_index, stop in enumerate(stops):
                stop_type = stop.get("stop_type")
                if stop_type not in {"pickup", "dropoff"}:
                    continue
                external_node = as_int(stop.get("node_index"), f"route {route_index} stop {stop_index} node_index")
                solver_node = external_node - 1
                locked_routes[vehicle].append(solver_node)
                time_dimension.CumulVar(manager.NodeToIndex(solver_node)).SetValues(
                    [as_int(stop.get("arrival_time"), f"route {route_index} stop {stop_index} arrival_time")]
                )

        if errors:
            return errors
        routing.CloseModel()
        if not routing.ApplyLocksToAllVehicles(locked_routes, True):
            return ["source-style locked-route validation could not apply the reported route locks"]
        search_parameters = pywrapcp.DefaultRoutingSearchParameters()
        search_parameters.time_limit.seconds = 1
        search_parameters.log_search = False
        search_parameters.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.AUTOMATIC
        search_parameters.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.AUTOMATIC
        solution = routing.SolveWithParameters(search_parameters)
        if solution is None:
            errors.append(f"source-style locked-route validation found no feasible assignment; status={routing.status()}")
    except Exception as exc:
        errors.append(f"source-style locked-route validation raised {type(exc).__name__}: {exc}")
    return errors
