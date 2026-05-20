#!/bin/bash
# Babylon Training - Docker Build Script
#
# Simple CLI for building and pushing Docker images.
#
# Usage:
#   ./build.sh base                    # Build base image
#   ./build.sh training                # Build training image
#   ./build.sh benchmark               # Build benchmark image
#   ./build.sh push-base               # Push base image
#   ./build.sh push-training           # Push training image
#   ./build.sh push-benchmark          # Push benchmark image
#   ./build.sh all                     # Build and push everything
#
# Options:
#   -o, --org <org>         Docker registry org (default: revlentless)
#   -t, --tags <tags>       Comma-separated tags (default: latest)
#   -b, --base-tag <tag>    Base image tag to use (default: latest)
#
# Examples:
#   ./build.sh base -t 0.2.0,latest
#   ./build.sh training -o myorg -t 0.2.0
#   ./build.sh benchmark -o myorg -t 0.2.0
#   ./build.sh all -o myorg -t 0.2.0,latest

set -e

# ============================================================================
# Defaults
# ============================================================================

ORG="${DOCKER_REGISTRY:-revlentless}"
TAGS="latest"
BASE_TAG="latest"
BASE_NAME="babylon-base"
TRAINING_NAME="babylon-training"
BENCHMARK_NAME="babylon-benchmark"

# Directory setup
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRAINING_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

# ============================================================================
# Helpers
# ============================================================================

red() { echo -e "\033[0;31m$1\033[0m"; }
green() { echo -e "\033[0;32m$1\033[0m"; }
blue() { echo -e "\033[0;34m$1\033[0m"; }

usage() {
    echo "Babylon Docker Build Script"
    echo ""
    echo "Commands:"
    echo "  base             Build base image"
    echo "  training         Build training image"
    echo "  benchmark        Build benchmark image"
    echo "  push-base        Push base image"
    echo "  push-training    Push training image"
    echo "  push-benchmark   Push benchmark image"
    echo "  all              Build and push everything"
    echo ""
    echo "Options:"
    echo "  -o, --org <org>       Docker registry org (default: $ORG)"
    echo "  -t, --tags <tags>     Comma-separated tags (default: latest)"
    echo "  -b, --base-tag <tag>  Base image tag for training build (default: latest)"
    echo "  -h, --help            Show this help"
    echo ""
    echo "Examples:"
    echo "  ./build.sh base -t 0.2.0,latest"
    echo "  ./build.sh training -o myorg -t 0.2.0"
    echo "  ./build.sh benchmark -o myorg -t 0.2.0"
    echo "  ./build.sh all -o myorg -t 0.2.0,latest"
}

# ============================================================================
# Parse Arguments
# ============================================================================

COMMAND=""
while [[ $# -gt 0 ]]; do
    case $1 in
        base|training|benchmark|push-base|push-training|push-benchmark|all)
            COMMAND="$1"
            shift
            ;;
        -o|--org)
            ORG="$2"
            shift 2
            ;;
        -t|--tags)
            TAGS="$2"
            shift 2
            ;;
        -b|--base-tag)
            BASE_TAG="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            red "Unknown option: $1"
            usage
            exit 1
            ;;
    esac
done

if [[ -z "$COMMAND" ]]; then
    usage
    exit 1
fi

# Convert comma-separated tags to array
IFS=',' read -ra TAG_ARRAY <<< "$TAGS"

# ============================================================================
# Commands
# ============================================================================

build_base() {
    blue "Building base image..."
    echo "  Org: $ORG"
    echo "  Tags: ${TAG_ARRAY[*]}"
    echo ""
    
    cd "$TRAINING_DIR"
    
    # Build with first tag
    local first_tag="${TAG_ARRAY[0]}"
    docker build -f deploy/docker/Dockerfile.base \
        -t "$ORG/$BASE_NAME:$first_tag" .
    
    # Tag additional tags
    for tag in "${TAG_ARRAY[@]:1}"; do
        docker tag "$ORG/$BASE_NAME:$first_tag" "$ORG/$BASE_NAME:$tag"
    done
    
    green "✓ Base image built: $ORG/$BASE_NAME"
    for tag in "${TAG_ARRAY[@]}"; do
        echo "  - $ORG/$BASE_NAME:$tag"
    done
}

build_training() {
    blue "Building training image..."
    echo "  Org: $ORG"
    echo "  Tags: ${TAG_ARRAY[*]}"
    echo "  Base: $ORG/$BASE_NAME:$BASE_TAG"
    echo ""
    
    cd "$TRAINING_DIR"
    
    # Build with first tag
    local first_tag="${TAG_ARRAY[0]}"
    docker build -f deploy/docker/Dockerfile \
        --build-arg BASE_IMAGE="$ORG/$BASE_NAME:$BASE_TAG" \
        -t "$ORG/$TRAINING_NAME:$first_tag" .
    
    # Tag additional tags
    for tag in "${TAG_ARRAY[@]:1}"; do
        docker tag "$ORG/$TRAINING_NAME:$first_tag" "$ORG/$TRAINING_NAME:$tag"
    done
    
    green "✓ Training image built: $ORG/$TRAINING_NAME"
    for tag in "${TAG_ARRAY[@]}"; do
        echo "  - $ORG/$TRAINING_NAME:$tag"
    done
}

push_base() {
    blue "Pushing base image..."
    
    for tag in "${TAG_ARRAY[@]}"; do
        echo "  Pushing $ORG/$BASE_NAME:$tag"
        docker push "$ORG/$BASE_NAME:$tag"
    done
    
    green "✓ Base image pushed"
}

push_training() {
    blue "Pushing training image..."
    
    for tag in "${TAG_ARRAY[@]}"; do
        echo "  Pushing $ORG/$TRAINING_NAME:$tag"
        docker push "$ORG/$TRAINING_NAME:$tag"
    done
    
    green "✓ Training image pushed"
}

build_benchmark() {
    blue "Building benchmark image..."
    echo "  Org: $ORG"
    echo "  Tags: ${TAG_ARRAY[*]}"
    echo ""
    
    # Benchmark needs monorepo context - go to repo root
    # TRAINING_DIR = packages/training, so go up 2 levels
    REPO_ROOT="$(dirname "$(dirname "$TRAINING_DIR")")"
    cd "$REPO_ROOT"
    
    # Build with first tag
    local first_tag="${TAG_ARRAY[0]}"
    docker build -f packages/training/deploy/docker/Dockerfile.bench \
        -t "$ORG/$BENCHMARK_NAME:$first_tag" .
    
    # Tag additional tags
    for tag in "${TAG_ARRAY[@]:1}"; do
        docker tag "$ORG/$BENCHMARK_NAME:$first_tag" "$ORG/$BENCHMARK_NAME:$tag"
    done
    
    green "✓ Benchmark image built: $ORG/$BENCHMARK_NAME"
    for tag in "${TAG_ARRAY[@]}"; do
        echo "  - $ORG/$BENCHMARK_NAME:$tag"
    done
}

push_benchmark() {
    blue "Pushing benchmark image..."
    
    for tag in "${TAG_ARRAY[@]}"; do
        echo "  Pushing $ORG/$BENCHMARK_NAME:$tag"
        docker push "$ORG/$BENCHMARK_NAME:$tag"
    done
    
    green "✓ Benchmark image pushed"
}

# ============================================================================
# Execute
# ============================================================================

case $COMMAND in
    base)
        build_base
        ;;
    training)
        build_training
        ;;
    benchmark)
        build_benchmark
        ;;
    push-base)
        push_base
        ;;
    push-training)
        push_training
        ;;
    push-benchmark)
        push_benchmark
        ;;
    all)
        build_base
        push_base
        build_training
        push_training
        build_benchmark
        push_benchmark
        green ""
        green "✓ All done!"
        ;;
esac

