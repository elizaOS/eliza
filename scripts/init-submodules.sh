#!/bin/bash

# Initialize git submodules
git submodule update --init --recursive

# Check if initialization was successful
if [ $? -eq 0 ]; then
    echo "Git submodules initialized successfully"
else
    echo "Error: Failed to initialize git submodules"
    exit 1
fi
