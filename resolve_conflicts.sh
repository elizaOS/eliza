#!/bin/bash

# Script to resolve merge conflicts systematically
# Keep AGI branch changes (vitest, new features) while preserving stability improvements

echo "Resolving merge conflicts..."

# Function to resolve conflicts by accepting AGI branch version
resolve_conflict() {
    local file="$1"
    echo "Resolving $file..."
    
    # Remove conflict markers and keep the AGI branch version (after =======)
    sed -i '' '/<<<<<<< HEAD/,/=======/d' "$file"
    sed -i '' '/>>>>>>> [a-f0-9]*/d' "$file"
}

# Files that should use AGI branch version completely
AGI_FILES=(
    "packages/core/src/types/database.ts"
    "packages/core/tsconfig.json"
    "packages/plugin-message-handling/package.json"
    "packages/plugin-message-handling/vitest.config.ts"
    "packages/plugin-starter/package.json"
    "packages/project-starter/package.json"
    "packages/server/package.json"
    "packages/project-tee-starter/bunfig.toml"
    "packages/server/bunfig.toml"
)

# Resolve AGI files
for file in "${AGI_FILES[@]}"; do
    if [ -f "$file" ]; then
        resolve_conflict "$file"
    fi
done

echo "Conflicts resolved!"