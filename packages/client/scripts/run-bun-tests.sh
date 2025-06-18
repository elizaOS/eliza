#!/bin/bash

# Simple solution: Create a symlink for @ to point to src
# This allows @/* imports to resolve to src/*

# Create the symlink if it doesn't exist
if [ ! -L "@" ]; then
    ln -sf src @
fi

# Run the tests
bun test "$@"

# Cleanup: Remove the symlink
rm -f @