from __future__ import annotations

import json
import math
import os
from typing import Any

import pytest

from darp_validation import (
    flatten_requests,
    load_json,
    load_matrix,
    recompute_schedule_metrics,
    route_solution_to_schedule,
    validate_routes_for_schedule,
    validate_with_source_locked_model,
)
from reference_oracle import solve_reference_report

OUTPUT_FILE = "/root/report.json"
REQUESTS_FILE = "/root/requests.json"
MATRIX_FILE = "/root/t_matrix.csv"
CONFIG_FILE = "/root/instance_config.json"

REFERENCE_SERVED_TRIP_RATIO = 0.95


@pytest.fixture(scope="module")
def report() -> dict[str, Any]:
    assert os.path.exists(OUTPUT_FILE), f"Missing required output: {OUTPUT_FILE}"
    with open(OUTPUT_FILE, encoding="utf-8") as f:
        loaded = json.load(f)
    assert isinstance(loaded, dict), "report.json must contain a JSON object"
    return loaded


@pytest.fixture(scope="module")
def requests_data() -> list[dict[str, Any]]:
    requests = load_json(REQUESTS_FILE)
    assert isinstance(requests, list), "requests.json must contain a list"
    return requests


@pytest.fixture(scope="module")
def instance_data(requests_data: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], Any, dict[str, Any]]:
    config = load_json(CONFIG_FILE)
    trips = flatten_requests(requests_data)
    matrix = load_matrix(MATRIX_FILE)
    return trips, matrix, config


@pytest.fixture(scope="module")
def schedule(report: dict[str, Any], instance_data: tuple[list[dict[str, Any]], Any, dict[str, Any]]) -> dict[str, Any]:
    trips, matrix, config = instance_data
    return route_solution_to_schedule(report, trips, matrix, config)


@pytest.fixture(scope="module")
def reference_report() -> dict[str, Any]:
    return solve_reference_report(REQUESTS_FILE, MATRIX_FILE, CONFIG_FILE, time_limit_sec=300)


def test_report_exists_and_is_json(report: dict[str, Any]) -> None:
    assert isinstance(report, dict)


def test_route_solution_schema(report: dict[str, Any]) -> None:
    assert "routes" in report, "report missing routes"
    assert isinstance(report["routes"], list), "routes must be a list"
    for route_index, route in enumerate(report["routes"]):
        assert isinstance(route, dict), f"route {route_index} must be an object"
        assert "vehicle_id" in route, f"route {route_index} missing vehicle_id"
        assert "start_time" in route, f"route {route_index} missing start_time"
        assert "node_sequence" in route, f"route {route_index} missing node_sequence"
        assert isinstance(route["vehicle_id"], str), f"route {route_index} vehicle_id must be a string"
        assert not isinstance(route["start_time"], bool), f"route {route_index} start_time must be an integer"
        assert isinstance(route["start_time"], int), f"route {route_index} start_time must be an integer"
        assert isinstance(route["node_sequence"], list), f"route {route_index} node_sequence must be a list"
        assert all(isinstance(node, int) and not isinstance(node, bool) for node in route["node_sequence"]), (
            f"route {route_index} node_sequence must contain integers"
        )


def test_instance_accounting(instance_data: tuple[list[dict[str, Any]], Any, dict[str, Any]]) -> None:
    trips, matrix, config = instance_data
    assert len(trips) == int(config["nb_trips"]), "flattened trip count must equal config nb_trips"
    assert matrix.shape == (2 * len(trips) + 2, 2 * len(trips) + 2), "matrix shape does not match node mapping"


def test_route_feasibility(schedule: dict[str, Any], instance_data: tuple[list[dict[str, Any]], Any, dict[str, Any]]) -> None:
    trips, matrix, config = instance_data
    errors = validate_routes_for_schedule(schedule, trips, matrix, config)
    assert not errors, "Route feasibility errors:\n" + "\n".join(errors[:25])


def test_source_style_locked_route_validation(
    schedule: dict[str, Any],
    requests_data: list[dict[str, Any]],
    instance_data: tuple[list[dict[str, Any]], Any, dict[str, Any]],
) -> None:
    trips, matrix, config = instance_data
    errors = validate_with_source_locked_model(schedule, requests_data, trips, matrix, config)
    assert not errors, "Source-style locked-route validation errors:\n" + "\n".join(errors[:10])


def test_recomputed_metrics_are_consistent(schedule: dict[str, Any], instance_data: tuple[list[dict[str, Any]], Any, dict[str, Any]]) -> None:
    trips, matrix, config = instance_data
    metrics = recompute_schedule_metrics(schedule, trips, matrix, config)
    assert int(metrics["served_trip_count"]) + int(metrics["unserved_trip_count"]) == len(trips)
    assert int(metrics["capacity_violations"]) == 0
    assert int(metrics["pairing_violations"]) == 0
    assert int(metrics["time_window_violations"]) == 0
    assert int(metrics["invalid_arc_violations"]) == 0


def test_reference_quality(schedule: dict[str, Any], reference_report: dict[str, Any], instance_data: tuple[list[dict[str, Any]], Any, dict[str, Any]]) -> None:
    trips, matrix, config = instance_data
    submitted_served = int(recompute_schedule_metrics(schedule, trips, matrix, config)["served_trip_count"])
    reference_served = int(reference_report["schedule"]["served_trip_count"])
    minimum_acceptable = max(0, math.ceil(reference_served * REFERENCE_SERVED_TRIP_RATIO))
    assert submitted_served >= minimum_acceptable, (
        f"submitted routes serve {submitted_served} trips, below tolerated reference threshold "
        f"{minimum_acceptable} (reference solve served {reference_served}, required ratio {REFERENCE_SERVED_TRIP_RATIO:.0%})"
    )
