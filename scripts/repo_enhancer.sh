#!/bin/bash

# Repository Enhancer Script
# Focuses on growing, expanding, and enhancing the repository by leveraging existing project tools and Gemini API.

set -e  # Exit on error

# Terminal colors
BLUE=$(tput setaf 4)
GREEN=$(tput setaf 2)
YELLOW=$(tput setaf 3)
RED=$(tput setaf 1)
NC=$(tput sgr0) # No Color

# Function to print header
print_header() {
  echo -e "\n${BLUE}==== $1 ====${NC}\n"
}

# Function to print success
print_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

# Function to print error
print_error() {
  echo -e "${RED}✗ $1${NC}"
}

# Function to run project's linting and formatting
run_code_quality_checks() {
  print_header "RUNNING PROJECT CODE QUALITY CHECKS (LINTING & FORMATTING)"

  local original_dir=$(pwd)
  cd /home/ubuntu/xmrt-eliza

  echo "Installing dependencies to ensure prettier is available..."
  bun install || {
    print_error "'bun install' failed. Please check the output above for details."
    cd "$original_dir"
    exit 1
  }

  echo "Running 'bun lint' for linting and formatting..."
  bun lint || {
    print_error "'bun lint' failed. Please check the output above for details."
    cd "$original_dir"
    exit 1
  }
  print_success "Code linting and formatting complete."

  cd "$original_dir"
}

# Function to leverage Gemini for agentic development
run_gemini_agent() {
    print_header "LEVERAGING GEMINI FOR AGENTIC DEVELOPMENT"

    # Find all Python files in the repository and run Gemini enhancement on them
    find /home/ubuntu/xmrt-eliza -name "*.py" -print0 | while IFS= read -r -d $'\0' file; do
        echo "Running Gemini enhancement on: $file"
        python3 /home/ubuntu/gemini_enhancer.py "$file" || print_warning "Gemini enhancement failed for $file"
    done

    print_success "Gemini agentic development tasks complete."
}

# Main enhancement function
enhance_repository() {
  print_header "ENHANCING REPOSITORY: CODE QUALITY, FIXING, AND AGENTIC DEVELOPMENT"

  run_code_quality_checks
  run_gemini_agent

  print_success "Repository enhancement complete!"
}

# Execute the enhancement
enhance_repository


