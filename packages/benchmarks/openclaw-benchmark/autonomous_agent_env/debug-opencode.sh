#!/usr/bin/env bash
echo "DEBUG: opencode called with args: $@" >> /home/enving/Dev/Repositories/coding_template/autonomous_agent_env/opencode_debug.log
# Call the real opencode
# We need to find the absolute path to the real opencode to avoid recursion
REAL_OPENCODE=$(which -a opencode | grep -v "debug-opencode" | head -n 1)
if [ -z "$REAL_OPENCODE" ]; then
    echo "ERROR: Real opencode not found!" >> /home/enving/Dev/Repositories/coding_template/autonomous_agent_env/opencode_debug.log
    exit 1
fi
exec "$REAL_OPENCODE" "$@"
