"""
BFCL Test Configuration

Pytest configuration and fixtures for BFCL benchmark tests.
"""

import pytest


@pytest.fixture
def sample_function_definitions():
    """Sample function definitions for testing."""
    from benchmarks.bfcl.types import FunctionDefinition, FunctionParameter

    return [
        FunctionDefinition(
            name="get_weather",
            description="Get weather information for a location",
            parameters={
                "location": FunctionParameter(
                    name="location",
                    param_type="string",
                    description="City name",
                    required=True,
                ),
                "unit": FunctionParameter(
                    name="unit",
                    param_type="string",
                    description="Temperature unit",
                    required=False,
                    enum=["celsius", "fahrenheit"],
                    default="celsius",
                ),
            },
            required_params=["location"],
        ),
        FunctionDefinition(
            name="search",
            description="Search for information",
            parameters={
                "query": FunctionParameter(
                    name="query",
                    param_type="string",
                    description="Search query",
                    required=True,
                ),
                "num_results": FunctionParameter(
                    name="num_results",
                    param_type="integer",
                    description="Number of results",
                    required=False,
                    default=10,
                ),
            },
            required_params=["query"],
        ),
    ]


@pytest.fixture
def sample_test_case(sample_function_definitions):
    """Sample BFCL test case for testing."""
    from benchmarks.bfcl.types import BFCLCategory, BFCLTestCase, FunctionCall

    return BFCLTestCase(
        id="sample_001",
        category=BFCLCategory.SIMPLE,
        question="What's the weather in San Francisco?",
        functions=sample_function_definitions,
        expected_calls=[
            FunctionCall(
                name="get_weather",
                arguments={"location": "San Francisco"},
            ),
        ],
        is_relevant=True,
    )


@pytest.fixture
def sample_parallel_test_case(sample_function_definitions):
    """Sample parallel function call test case."""
    from benchmarks.bfcl.types import BFCLCategory, BFCLTestCase, FunctionCall

    return BFCLTestCase(
        id="parallel_001",
        category=BFCLCategory.PARALLEL,
        question="Get weather in NYC and SF, and search for restaurants",
        functions=sample_function_definitions,
        expected_calls=[
            FunctionCall(
                name="get_weather",
                arguments={"location": "New York"},
            ),
            FunctionCall(
                name="get_weather",
                arguments={"location": "San Francisco"},
            ),
            FunctionCall(
                name="search",
                arguments={"query": "restaurants"},
            ),
        ],
        is_relevant=True,
    )


@pytest.fixture
def sample_irrelevant_test_case(sample_function_definitions):
    """Sample test case where no function is relevant."""
    from benchmarks.bfcl.types import BFCLCategory, BFCLTestCase

    return BFCLTestCase(
        id="relevance_001",
        category=BFCLCategory.RELEVANCE,
        question="What is the meaning of life?",
        functions=sample_function_definitions,
        expected_calls=[],
        is_relevant=False,
    )
