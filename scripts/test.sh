#!/bin/bash

# Check Node.js version
REQUIRED_NODE_VERSION=22
CURRENT_NODE_VERSION=$(node -v | cut -d'.' -f1 | sed 's/v//')

if ((CURRENT_NODE_VERSION < REQUIRED_NODE_VERSION)); then
    echo "Error: Node.js version must be $REQUIRED_NODE_VERSION or higher. Current version is $CURRENT_NODE_VERSION."
    exit 1
fi

# Navigate to the script's directory
cd "$(dirname "$0")"/..

# If specific test file provided, run just that
if [[ "$1" == *".ts" ]]; then
    echo -e "\033[1mRunning specific test: $1\033[0m"
    bun test "$1"
    exit $?
fi

# If package name provided, run just that package
if [ ! -z "$1" ]; then
    package="$1"
    package_path="packages/$package"

    if [ ! -d "$package_path" ]; then
        echo -e "\033[1mPackage directory '$package' not found\033[0m"
        exit 1
    fi

    echo -e "\033[1mTesting package: $package\033[0m"
    # Use find to get all test files and pass them explicitly to bun test
    test_files=$(find "packages/$package/src" -name "*.test.ts" -type f)
    if [ -z "$test_files" ]; then
        echo "No test files found"
        exit 1
    fi
    echo "Found test files:"
    echo "$test_files"
    bun test $test_files
    exit $?
fi

# Check if the packages directory exists
if [ ! -d "packages" ]; then
    echo "Error: 'packages' directory not found."
    exit 1
fi

# Find all packages under the packages directory
PACKAGES=($(find packages -mindepth 1 -maxdepth 1 -type d -exec basename {} \;))

# Test packages in specified order
for package in "${PACKAGES[@]}"; do
    package_path="packages/$package"

    if [ ! -d "$package_path" ]; then
        echo -e "\033[1mPackage directory '$package' not found, skipping...\033[0m"
        continue
    fi

    echo -e "\033[1mTesting package: $package\033[0m"
    cd "$package_path" || continue

    if [ -f "package.json" ]; then
        # Run tests with coverage if TEST_COVERAGE is set and test:coverage script exists
        if [[ -n "$TEST_COVERAGE" ]] && bun run | grep -q " test:coverage"; then
            echo -e "\033[1mRunning coverage tests for package: $package\033[0m"
            if bun run test:coverage; then
                echo -e "\033[1;32mSuccessfully tested $package with coverage\033[0m\n"
            else
                echo -e "\033[1;31mCoverage tests failed for $package\033[0m"
            fi
        # Otherwise, run regular tests if available
        elif bun run | grep -q " test"; then
            echo -e "\033[1mRunning tests for package: $package\033[0m"
            if bun run test; then
                echo -e "\033[1;32mSuccessfully tested $package\033[0m\n"
            else
                echo -e "\033[1;31mTests failed for $package\033[0m"
            fi
        else
            echo "No test script found in $package, skipping tests..."
        fi
    else
        echo "No package.json found in $package, skipping..."
    fi

    cd - >/dev/null || exit
done

echo -e "\033[1mTest process completed.😎\033[0m"
