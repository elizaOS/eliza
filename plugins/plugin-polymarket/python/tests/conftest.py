"""Conftest for plugin-polymarket tests."""

# Check if py_clob_client is available
try:
    import py_clob_client  # noqa: F401

    HAS_PY_CLOB_CLIENT = True
except ImportError:
    HAS_PY_CLOB_CLIENT = False

# Skip test files that import from the plugin package
# The package __init__.py imports modules that depend on py_clob_client
# This prevents ImportError during collection
if not HAS_PY_CLOB_CLIENT:
    collect_ignore = ["test_actions.py", "test_types.py"]
