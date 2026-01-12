"""Pytest configuration for context-bench tests."""

import pytest


@pytest.fixture
def sample_context() -> str:
    """Provide a sample context for testing."""
    return """The development of artificial intelligence has been one of the most 
    significant technological advances of the 21st century. Machine learning 
    algorithms can now process vast amounts of data and make predictions with 
    remarkable accuracy. Deep neural networks have revolutionized computer vision, 
    natural language processing, and many other fields. Climate change represents 
    one of the greatest challenges facing humanity today. Rising global temperatures 
    are causing more frequent extreme weather events, melting ice caps, and rising 
    sea levels. Scientists worldwide are working on solutions to reduce carbon 
    emissions and mitigate the effects of climate change."""


@pytest.fixture
def sample_needle() -> str:
    """Provide a sample needle for testing."""
    return "The secret access code is XY7Z9K42."


@pytest.fixture
def sample_question() -> str:
    """Provide a sample question for testing."""
    return "What is the secret access code?"


@pytest.fixture
def sample_answer() -> str:
    """Provide a sample answer for testing."""
    return "XY7Z9K42"
