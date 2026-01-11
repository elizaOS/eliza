"""
elizaOS Cross-Language Interop - Python

This module provides utilities for loading plugins written in other languages
(Rust, TypeScript) into the Python runtime.

This is a standalone package that can be installed separately or used from
within the main elizaos package.
"""

# Rust FFI loader
from .rust_ffi import (
    RustPluginFFI,
    find_rust_plugin,
    get_lib_extension,
    get_lib_prefix,
    load_rust_plugin,
)

# WASM loader (for Rust/TypeScript WASM plugins)
from .wasm_loader import (
    WasmPluginLoader,
    load_wasm_plugin,
    validate_wasm_plugin,
)

# TypeScript bridge (for TypeScript plugins via IPC)
from .ts_bridge import (
    TypeScriptPluginBridge,
    load_typescript_plugin,
    stop_typescript_plugin,
)

__all__ = [
    # Rust FFI
    "RustPluginFFI",
    "load_rust_plugin",
    "find_rust_plugin",
    "get_lib_extension",
    "get_lib_prefix",
    # WASM Loader
    "WasmPluginLoader",
    "load_wasm_plugin",
    "validate_wasm_plugin",
    # TypeScript Bridge
    "TypeScriptPluginBridge",
    "load_typescript_plugin",
    "stop_typescript_plugin",
]

