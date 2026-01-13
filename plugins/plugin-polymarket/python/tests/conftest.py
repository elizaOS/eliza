"""Conftest for plugin-polymarket tests.

These tests are expected to be hermetic (no network, no secrets) by default.
If any future tests require external dependencies, mark them with explicit
pytest markers and skip conditionally in that test module/function.
"""
