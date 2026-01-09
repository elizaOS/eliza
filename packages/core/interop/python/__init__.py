"""
elizaOS Cross-Language Interop - Python

This module provides utilities for loading plugins written in other languages
(Rust, TypeScript) into the Python runtime.
"""

from elizaos.interop.rust_ffi import (
    RustPluginFFI,
    load_rust_plugin,
    find_rust_plugin,
    get_lib_extension,
    get_lib_prefix,
)

__all__ = [
    # Rust FFI
    "RustPluginFFI",
    "load_rust_plugin",
    "find_rust_plugin",
    "get_lib_extension",
    "get_lib_prefix",
]

