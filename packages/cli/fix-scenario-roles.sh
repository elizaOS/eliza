#!/bin/bash

# Fix actor roles in scenario files to have only one subject
# Rule: First actor should be 'assistant' (the agent being tested)
# Rule: Second actor should be 'subject' (the user providing input)

echo "Fixing actor roles in scenario files..."

for file in scenarios/plugin-tests/*.ts; do
  if [ -f "$file" ]; then
    subjects=$(grep -c "role: 'subject'" "$file" 2>/dev/null || echo "0")
    if [ "$subjects" -gt "1" ]; then
      echo "Fixing $(basename "$file"): $subjects subject roles"
      
      # Replace the first occurrence of "role: 'subject'," with "role: 'assistant',"
      # This assumes the first actor is the agent and should be assistant
      sed -i '' '0,/role: '\''subject'\'',/{s/role: '\''subject'\'',/role: '\''assistant'\'',/;}' "$file"
      
      # Verify the fix
      new_subjects=$(grep -c "role: 'subject'" "$file" 2>/dev/null || echo "0")
      echo "  After fix: $new_subjects subject roles"
    fi
  fi
done

echo "Role fixes complete!"