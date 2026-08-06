#!/bin/bash

# Shell script for cross-compiling Rust projects for Windows from Ubuntu

set -e

# Constants
TARGET_X86_64="x86_64-pc-windows-gnu"
TARGET_I686="i686-pc-windows-gnu"

# Function to print messages
function echo_info() {
    echo "[INFO] $1"
}

# Update and install required packages
echo_info "Updating package list..."
sudo apt update

echo_info "Installing mingw-w64..."
sudo apt install -y mingw-w64

echo_info "Adding Rust targets..."
rustup target add $TARGET_X86_64
rustup target add $TARGET_I686

# Build the project for x86_64 Windows
echo_info "Building for 64-bit Windows..."
cargo build --target=$TARGET_X86_64

# Build the project for i686 Windows
echo_info "Building for 32-bit Windows..."
cargo build --target=$TARGET_I686

echo_info "Build completed!"
