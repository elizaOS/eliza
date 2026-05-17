#!/bin/bash

# Check if we're in a valid working directory
if [ "$PWD" = "/" ]; then
    echo "Error: No working directory set. Please set a WORKDIR in your Dockerfile before running this script."
    exit 1
fi

pip install pytest==8.4.1
python -m pytest $TEST_DIR/test_outputs.py -rA