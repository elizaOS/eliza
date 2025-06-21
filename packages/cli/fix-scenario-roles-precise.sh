#!/bin/bash

# Script to fix actor role validation issues in scenario files
# Change the first occurrence of "role: 'subject'" to "role: 'assistant'"

cd /Users/shawwalters/eliza-self/packages/cli

echo "Fixing scenario actor roles..."

# Process each scenario file
for file in scenarios/plugin-tests/*.ts; do
    # Skip index files and non-scenario files
    if [[ "$file" == *"index.ts"* ]] || [[ "$file" == *"run-integration-tests.ts"* ]]; then
        continue
    fi
    
    # Count subject roles before fix
    before_count=$(grep -c "role: 'subject'" "$file")
    
    if [ "$before_count" -gt 1 ]; then
        echo "Fixing $file (has $before_count subject roles)"
        
        # Use sed to replace only the first occurrence
        sed -i.bak "0,/role: 'subject'/s//role: 'assistant'/" "$file"
        
        # Count after fix
        after_count=$(grep -c "role: 'subject'" "$file")
        echo "  Fixed: $before_count -> $after_count subject roles"
        
        # Remove backup file
        rm "$file.bak"
    else
        echo "Skipping $file (already has $before_count subject role)"
    fi
done

echo "Role fixing complete!"

# Summary
echo
echo "=== Summary ==="
total_subject_files=$(find scenarios/plugin-tests -name "*.ts" -exec grep -l "role: 'subject'" {} \; | wc -l)
echo "Files with subject roles: $total_subject_files"

# Show files that still have multiple subject roles
echo
echo "Files still needing attention:"
for file in scenarios/plugin-tests/*.ts; do
    if [[ "$file" == *"index.ts"* ]] || [[ "$file" == *"run-integration-tests.ts"* ]]; then
        continue
    fi
    
    subject_count=$(grep -c "role: 'subject'" "$file")
    if [ "$subject_count" -gt 1 ]; then
        echo "  $file: $subject_count subject roles"
    fi
done