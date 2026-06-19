#!/bin/bash
# Setup script for installing Python dependencies
# This script ensures dependencies are available whether using terminal or python_execute

echo "Setting up Python dependencies for Excel Market Research task..."

# Check if uv is available
if command -v uv &> /dev/null; then
    echo "✓ Found uv, installing dependencies via uv..."
    uv pip install openpyxl pandas numpy
    echo "✓ Dependencies installed via uv"
else
    # Fallback to pip
    echo "✓ uv not found, using pip..."
    pip install openpyxl pandas numpy
    echo "✓ Dependencies installed via pip"
fi

echo ""
echo "✅ Setup complete! You can now run Python scripts that use pandas, openpyxl, and numpy."

