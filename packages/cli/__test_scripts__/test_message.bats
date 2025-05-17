#!/usr/bin/env bats

setup_file() {
  export TEST_SERVER_PORT=3000 
  export TEST_SERVER_URL="http://localhost:$TEST_SERVER_PORT"
  export TEST_TMP_DIR="$(mktemp -d /var/tmp/eliza-test-message-XXXXXX)"
  export MODEL_DIR="$HOME/.eliza/models"

  # DEBUG: Ensure TEST_TMP_DIR is set and visible
  if [ -z "$TEST_TMP_DIR" ]; then
    echo "[ERROR] TEST_TMP_DIR is not set!"
    exit 1
  fi
  echo "[DEBUG] TEST_TMP_DIR is: $TEST_TMP_DIR"
  ls -ld "$TEST_TMP_DIR"

  mkdir -p "$MODEL_DIR"
  mkdir -p "$TEST_TMP_DIR/pglite"

  export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run $(cd ../dist && pwd)/index.js}"

  # Model information
  models=(
    "DeepHermes-3-Llama-3-3B-Preview-q4.gguf|https://huggingface.co/NousResearch/DeepHermes-3-Llama-3-3B-Preview-GGUF/resolve/main/DeepHermes-3-Llama-3-3B-Preview-q4.gguf|LOCAL_SMALL_MODEL"
    "DeepHermes-3-Llama-3-8B-q4.gguf|https://huggingface.co/NousResearch/DeepHermes-3-Llama-3-8B-Preview-GGUF/resolve/main/DeepHermes-3-Llama-3-8B-q4.gguf|LOCAL_LARGE_MODEL"
    "bge-small-en-v1.5.Q4_K_M.gguf|https://huggingface.co/ChristianAzinn/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5.Q4_K_M.gguf|LOCAL_EMBEDDING_MODEL"
  )

  echo "Setting up models in $MODEL_DIR..."
  for model_info in "${models[@]}"; do
    IFS='|' read -r name url env_var <<< "$model_info"
    export "$env_var"="$name" # Export env var with model name
    local model_path="$MODEL_DIR/$name"
    if [ ! -f "$model_path" ]; then
      echo "Downloading $name to $model_path..."
      if curl -L -f -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" -o "$model_path" "$url"; then
        echo "$name downloaded successfully."
      else
        echo "[ERROR] Failed to download $name from $url. Status: $?"
        # Optionally, remove partially downloaded file
        rm -f "$model_path"
        exit 1 # Exit if model download fails
      fi 
    else
      echo "$name already exists at $model_path."
    fi
  done

  echo "[DEBUG] Server log will be: $TEST_TMP_DIR/server.log"
  echo "Starting ElizaOS server on port $TEST_SERVER_PORT..."
  # Start server in background with PGLite forced and models configured via env vars
  LOG_LEVEL=debug PGLITE_DATA_DIR="$TEST_TMP_DIR/pglite" \
    LOCAL_SMALL_MODEL="${LOCAL_SMALL_MODEL}" \
    LOCAL_LARGE_MODEL="${LOCAL_LARGE_MODEL}" \
    LOCAL_EMBEDDING_MODEL="${LOCAL_EMBEDDING_MODEL}" \
    $ELIZAOS_CMD start --port $TEST_SERVER_PORT >"$TEST_TMP_DIR/server.log" 2>&1 &
  SERVER_PID=$!

  echo "Waiting for server to be up (PID: $SERVER_PID)..."
  SERVER_UP=0
  for i in {1..30}; do # Increased timeout for model loading
    if curl -sf "$TEST_SERVER_URL/api/agents" >/dev/null; then
      SERVER_UP=1
      echo "Server is up!"
      break
    fi
    echo "Still waiting for server... (attempt $i)"
    sleep 2 # Increased sleep interval
  done

  if [ "$SERVER_UP" -ne 1 ]; then
    echo "[ERROR] ElizaOS server did not start within timeout!"
    echo "--- SERVER LOG ($TEST_TMP_DIR/server.log) --- "
    cat "$TEST_TMP_DIR/server.log"
    echo "------------------"
    # Try to kill the server if it's lingering
    if ps -p $SERVER_PID > /dev/null; then
      kill -9 "$SERVER_PID" 2>/dev/null || true
    fi 
    exit 1
  fi

  echo "Waiting for agents to fully initialize..."
  # Poll for agents to be available before proceeding
  for i in {1..10}; do
    AGENTS_JSON=$(curl -s "$TEST_SERVER_URL/api/agents")
    if [ "$AGENTS_JSON" != "[]" ] && [ -n "$AGENTS_JSON" ]; then
      echo "Agents initialized!"
      break
    fi
    echo "Agents not yet initialized (attempt $i), waiting..."
    sleep 2
  done

  ELIZA_AGENT_ID=""

  # Attempt 1: Use 'elizaos agent list' CLI command
  echo "Attempting to get Eliza Agent ID using 'agent list' CLI..."
  run $ELIZAOS_CMD agent --remote-url "$TEST_SERVER_URL" list
  
  echo "--- 'agent list' command details ---"
  echo "Status: $status"
  echo "Output (stdout & stderr combined):
$output"
  echo "----------------------------------"

  if [ "$status" -eq 0 ]; then
    local agent_list_cli_output="$output"
    # Try to parse: Assumes format like 'Name <ID> Status ...'
    # Example: Eliza b850bc30-45f8-0041-a00a-83df46d8555d RUNNING
    local raw_id_from_cli
    # First, clean ANSI codes from the whole output
    local cleaned_agent_list_output=$(echo "$agent_list_cli_output" | sed 's/\x1b\[[0-9;]*m//g')
    # Then, extract the potential ID using awk
    raw_id_from_cli=$(echo "$cleaned_agent_list_output" | awk -F '│' '
      BEGIN { IGNORECASE=1 }
      $3 ~ /eliza/ { # Match "eliza" in the 3rd field (name column)
        id_field = $4 # ID is expected in the 4th field
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", id_field) # Trim whitespace
        print id_field
        exit # Process only the first match
      }')

    # Validate if it's a UUID
    if [[ "$raw_id_from_cli" =~ ^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$ ]]; then
      ELIZA_AGENT_ID="$raw_id_from_cli"
      echo "Successfully fetched Eliza Agent ID using CLI: $ELIZA_AGENT_ID"
    else
      echo "[WARNING] 'agent list' CLI output processed, but couldn't parse a valid UUID for Eliza. Raw extracted value: '$raw_id_from_cli'. Original output (pre-ANSI strip):"
      echo -e "$agent_list_cli_output"
      ELIZA_AGENT_ID="" # Reset if parsing or validation failed
    fi
  else
    echo "[WARNING] '$ELIZAOS_CMD agent list' failed with status $status. Will try parsing server log."
  fi

  # Attempt 2: Parse from server log if CLI method failed or didn't find the ID
  if [ -z "$ELIZA_AGENT_ID" ]; then
    echo "Attempting to get Eliza Agent ID from server log..."
    local server_log_path="$TEST_TMP_DIR/server.log"
    local raw_id_from_log
    # The regex matches 'Started Eliza as ' followed by a UUID.
    # sed extracts only the UUID part.
    raw_id_from_log=$(tail -n 100 "$server_log_path" | \
                      grep -E 'Started Eliza as [0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}' | \
                      sed -E 's/.*Started Eliza as ([0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}).*/\1/' | \
                      head -n 1)

    # Validate if it's a UUID
    if [[ "$raw_id_from_log" =~ ^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$ ]]; then
      ELIZA_AGENT_ID="$raw_id_from_log"
      echo "Successfully fetched Eliza Agent ID from server log: $ELIZA_AGENT_ID"
    else
      echo "[WARNING] Server log processed, but couldn't parse a valid UUID for Eliza. Raw extracted value: '$raw_id_from_log'"
      ELIZA_AGENT_ID="" # Reset if parsing or validation failed
    fi
    
    if [ -z "$ELIZA_AGENT_ID" ]; then # This check remains, if ELIZA_AGENT_ID is empty after trying to parse from log
      echo "[ERROR] Could not find Agent ID for Eliza using CLI or by parsing server log."
      echo "--- Last 100 lines of SERVER LOG ($server_log_path) --- "
      tail -n 100 "$server_log_path"
      echo "----------------------------------------------------"
      exit 1
    fi
  fi
  echo "Found Eliza Agent ID: $ELIZA_AGENT_ID"
  export ELIZA_AGENT_ID # Export it so it's available in the test function's subshell
}

teardown_file() {
  echo "Tearing down test environment..."
  if [ -n "$SERVER_PID" ]; then
    echo "Stopping server (PID: $SERVER_PID)..."
    # Try graceful kill first, then force if necessary
    kill "$SERVER_PID" 2>/dev/null
    sleep 1
    if ps -p $SERVER_PID > /dev/null; then
        echo "Server $SERVER_PID did not stop gracefully, forcing kill..."
        kill -9 "$SERVER_PID" 2>/dev/null || true
    else
        echo "Server $SERVER_PID stopped."
    fi
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$TEST_TMP_DIR" ] && [ -d "$TEST_TMP_DIR" ]; then
    echo "Cleaning up temporary directory $TEST_TMP_DIR..."
    rm -rf "$TEST_TMP_DIR"
  fi
}

@test "Send message to Eliza agent and get a response" {
    local payload='{"entityId":"31c75add-3a49-4bb1-ad40-92c6b4c39558","roomId":"'$ELIZA_AGENT_ID'","source":"client_chat","text":"Can you help with creating a new channel for agent-dev-school?","channelType":"API"}'
    run curl -s -X POST -H "Content-Type: application/json" -d "$payload" "$TEST_SERVER_URL/api/agents/$ELIZA_AGENT_ID/message"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.thought and .actions' >/dev/null
}