#!/bin/bash

# elizaOS ICP Canister Setup Script
# This script helps set up and deploy the canister

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "=== elizaOS ICP Canister Setup ==="
echo ""

# Check prerequisites
check_command() {
    if ! command -v "$1" &> /dev/null; then
        echo "Error: $1 is not installed."
        echo "Please install it first. See README.md for instructions."
        exit 1
    fi
}

echo "Checking prerequisites..."
check_command dfx
check_command rustc
check_command cargo

# Check wasm target
if ! rustup target list --installed | grep -q "wasm32-unknown-unknown"; then
    echo "Installing wasm32-unknown-unknown target..."
    rustup target add wasm32-unknown-unknown
fi

echo "Prerequisites OK!"
echo ""

# Parse arguments
NETWORK="local"
ACTION="deploy"

while [[ $# -gt 0 ]]; do
    case $1 in
        --network)
            NETWORK="$2"
            shift 2
            ;;
        --action)
            ACTION="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

case $ACTION in
    start)
        echo "Starting local replica..."
        dfx start --background --clean
        echo "Local replica started!"
        ;;
    
    stop)
        echo "Stopping local replica..."
        dfx stop
        echo "Local replica stopped!"
        ;;
    
    deploy)
        if [ "$NETWORK" = "local" ]; then
            # Check if replica is running
            if ! dfx ping &> /dev/null; then
                echo "Local replica not running. Starting..."
                dfx start --background --clean
                sleep 2
            fi
        fi
        
        echo "Building and deploying canister to $NETWORK network..."
        
        if [ "$NETWORK" = "ic" ]; then
            dfx deploy --network ic
        else
            dfx deploy
        fi
        
        echo ""
        echo "Deployment complete!"
        echo ""
        echo "To initialize the agent, run:"
        echo "  dfx canister call eliza_icp_backend init_agent '(null)'"
        echo ""
        echo "To chat with the agent, run:"
        echo "  dfx canister call eliza_icp_backend chat '(record { message = \"Hello!\"; user_id = null; room_id = null; metadata = null })'"
        ;;
    
    init)
        echo "Initializing agent..."
        dfx canister call eliza_icp_backend init_agent '(null)'
        ;;
    
    chat)
        if [ -z "$2" ]; then
            echo "Usage: $0 --action chat \"Your message here\""
            exit 1
        fi
        dfx canister call eliza_icp_backend chat "(record { message = \"$2\"; user_id = null; room_id = null; metadata = null })"
        ;;
    
    health)
        dfx canister call eliza_icp_backend health
        ;;
    
    clean)
        echo "Cleaning build artifacts..."
        cargo clean
        rm -rf .dfx
        echo "Clean complete!"
        ;;
    
    *)
        echo "Unknown action: $ACTION"
        echo ""
        echo "Available actions:"
        echo "  start   - Start local replica"
        echo "  stop    - Stop local replica"
        echo "  deploy  - Build and deploy canister"
        echo "  init    - Initialize the agent"
        echo "  health  - Check canister health"
        echo "  clean   - Clean build artifacts"
        echo ""
        echo "Options:"
        echo "  --network [local|ic]  - Target network (default: local)"
        exit 1
        ;;
esac
