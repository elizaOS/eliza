"""Unit tests for the BFCL REST_API HTTP runner.

Covers:
  * Without ``enable_network`` the runner refuses to execute and raises
    a ``RESTExecutionError`` (caller maps to SKIPPED_NO_CREDENTIALS).
  * With ``enable_network`` the runner executes via an injected
    ``httpx.MockTransport`` and parses the response.
  * 429 responses raise ``RESTRateLimited`` so the caller can map to
    ``SKIPPED_RATE_LIMITED``.
  * ``RESTResponse.matches`` does the loose subset / substring match
    expected by the upstream eval.
  * ``ExecutionEvaluator.evaluate_rest`` enforces the same gating.
"""
from __future__ import annotations

import json

import pytest

httpx = pytest.importorskip("httpx")

from benchmarks.bfcl.evaluators import ExecutionEvaluator
from benchmarks.bfcl.executable_runtime import (
    RESTCallSpec,
    RESTExecutionError,
    RESTRateLimited,
    RESTResponse,
    RESTRunner,
    RuntimeNetworkRequired,
)


def _mock_client(handler) -> httpx.Client:
    """Build an httpx.Client backed by a MockTransport for tests."""
    transport = httpx.MockTransport(handler)
    return httpx.Client(transport=transport)


class TestRESTRunnerGating:
    def test_refuses_without_enable_network(self) -> None:
        runner = RESTRunner(enable_network=False)
        spec = RESTCallSpec(method="GET", url="https://example.com/")
        with pytest.raises(RESTExecutionError, match="Network is disabled"):
            runner.execute(spec)

    def test_evaluator_refuses_without_enable_network(self) -> None:
        evaluator = ExecutionEvaluator(enable_network=False)
        spec = RESTCallSpec(method="GET", url="https://example.com/")
        with pytest.raises(RuntimeNetworkRequired):
            evaluator.evaluate_rest(spec=spec, expected={"ok": True})


class TestRESTRunnerExecution:
    def test_get_success_returns_parsed_json(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.method == "GET"
            assert request.url == "https://example.com/foo"
            return httpx.Response(200, json={"name": "Alex", "city": "NYC"})

        runner = RESTRunner(enable_network=True, client=_mock_client(handler))
        spec = RESTCallSpec(method="GET", url="https://example.com/foo")
        response = runner.execute(spec)

        assert response.status_code == 200
        assert response.json_body == {"name": "Alex", "city": "NYC"}
        assert response.matches({"name": "Alex"}) is True
        assert response.matches({"name": "Patti"}) is False

    def test_rate_limited_raises(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(429, json={"error": "Too Many Requests"})

        runner = RESTRunner(enable_network=True, client=_mock_client(handler))
        spec = RESTCallSpec(method="GET", url="https://example.com/rate")
        with pytest.raises(RESTRateLimited):
            runner.execute(spec)

    def test_post_with_json_body(self) -> None:
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["method"] = request.method
            captured["body"] = json.loads(request.content.decode())
            return httpx.Response(201, json={"created": True})

        runner = RESTRunner(enable_network=True, client=_mock_client(handler))
        spec = RESTCallSpec(
            method="POST",
            url="https://example.com/items",
            json_body={"name": "test"},
        )
        response = runner.execute(spec)
        assert captured["method"] == "POST"
        assert captured["body"] == {"name": "test"}
        assert response.status_code == 201

    def test_query_params_included(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.params.get("q") == "hello"
            assert request.url.params.get("limit") == "10"
            return httpx.Response(200, json={"results": []})

        runner = RESTRunner(enable_network=True, client=_mock_client(handler))
        spec = RESTCallSpec(
            method="GET",
            url="https://example.com/search",
            params={"q": "hello", "limit": 10},
        )
        response = runner.execute(spec)
        assert response.status_code == 200


class TestRESTResponseMatching:
    def test_subset_dict_match(self) -> None:
        r = RESTResponse(
            status_code=200,
            json_body={"a": 1, "b": 2, "c": 3},
            text='{"a":1,"b":2,"c":3}',
            elapsed_seconds=0.1,
        )
        assert r.matches({"a": 1}) is True
        assert r.matches({"a": 1, "z": 99}) is False

    def test_substring_text_match(self) -> None:
        r = RESTResponse(
            status_code=200,
            json_body=None,
            text="The capital of France is Paris.",
            elapsed_seconds=0.1,
        )
        assert r.matches("Paris") is True
        assert r.matches("Berlin") is False

    def test_none_expected_matches_anything(self) -> None:
        r = RESTResponse(
            status_code=200,
            json_body={"any": "thing"},
            text="anything",
            elapsed_seconds=0.1,
        )
        assert r.matches(None) is True


class TestEvaluatorRESTPath:
    def test_passes_when_response_matches_expected(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"temperature": 72})

        evaluator = ExecutionEvaluator(enable_network=True)
        runner = RESTRunner(enable_network=True, client=_mock_client(handler))
        spec = RESTCallSpec(method="GET", url="https://example.com/weather")
        passed, details = evaluator.evaluate_rest(
            spec=spec,
            expected={"temperature": 72},
            runner=runner,
        )
        assert passed is True
        assert details["status_code"] == 200

    def test_fails_when_response_mismatches(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"temperature": 50})

        evaluator = ExecutionEvaluator(enable_network=True)
        runner = RESTRunner(enable_network=True, client=_mock_client(handler))
        spec = RESTCallSpec(method="GET", url="https://example.com/weather")
        passed, _ = evaluator.evaluate_rest(
            spec=spec,
            expected={"temperature": 72},
            runner=runner,
        )
        assert passed is False

    def test_rate_limited_propagates(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(429)

        evaluator = ExecutionEvaluator(enable_network=True)
        runner = RESTRunner(enable_network=True, client=_mock_client(handler))
        spec = RESTCallSpec(method="GET", url="https://example.com/rate")
        with pytest.raises(RESTRateLimited):
            evaluator.evaluate_rest(spec=spec, expected={}, runner=runner)
