#!/bin/bash
# Python build script with retry logic and error handling

set -e

# Function to run build with retry
run_build() {
    local max_attempts=3
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        echo "Attempt $attempt of $max_attempts..."
        
        if python3 -m build 2>&1; then
            echo "✅ Build successful"
            return 0
        else
            local exit_code=$?
            echo "⚠️  Build attempt $attempt failed with exit code $exit_code"
            
            if [ $attempt -lt $max_attempts ]; then
                echo "Retrying in 2 seconds..."
                sleep 2
            fi
            
            attempt=$((attempt + 1))
        fi
    done
    
    echo "❌ Build failed after $max_attempts attempts"
    return 1
}

# Run the build
run_build




