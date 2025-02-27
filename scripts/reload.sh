#!/bin/bash

# Default to sbf if no character is provided
characters=("${@:-sbf}")

# Prepare characters array for --character argument
character_args=()
for char in "${characters[@]}"; do
    character_args+=("characters/$char.character.json")
done

# Convert array to comma-separated string
character_list=$(IFS=,; echo "${character_args[*]}")

# Run the build and start with the characters
pnpm build && pnpm start --characters="$character_list"

# Usage: pnpm reload snoop elton my_agent_name etc...