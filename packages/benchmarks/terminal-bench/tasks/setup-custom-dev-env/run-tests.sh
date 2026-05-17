#!/bin/bash

# You can modify anything in this script. Just make sure it generates test output that
# is parsed by a parser (PytestParser by default).

# This boilerplate script installs uv (to manage Python) and runs pytest.

pip install pytest==8.4.1 --break-system-packages || pip install pytest==8.4.1

pytest $TEST_DIR/test_outputs.py -rA