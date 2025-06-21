#!/bin/bash

# Script to resolve the remaining merge conflicts efficiently
# This keeps the AGI branch changes which have the newer testing infrastructure

echo "Resolving remaining merge conflicts..."

# Get all files with conflicts
CONFLICT_FILES=$(git diff --name-only --diff-filter=U)

for file in $CONFLICT_FILES; do
    echo "Resolving $file..."
    
    # Check if file exists
    if [ ! -f "$file" ]; then
        echo "File $file does not exist, skipping..."
        continue
    fi
    
    # For most files, we want to keep the AGI branch changes (after =======)
    # Remove conflict markers and keep AGI version
    if grep -q "<<<<<<< HEAD" "$file"; then
        # Create temporary file
        temp_file=$(mktemp)
        
        # Process the file to keep AGI branch changes
        awk '
        /^<<<<<<< HEAD/ { in_conflict = 1; skip = 1; next }
        /^=======/ { if (in_conflict) { skip = 0; next } }
        /^>>>>>>> [a-f0-9]+/ { in_conflict = 0; skip = 0; next }
        !skip { print }
        ' "$file" > "$temp_file"
        
        # Replace original with processed version
        mv "$temp_file" "$file"
        
        echo "Resolved $file"
    fi
done

echo "Adding resolved files to git..."
git add -A

echo "All conflicts resolved!"