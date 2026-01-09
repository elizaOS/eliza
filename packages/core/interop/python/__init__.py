"""
elizaOS Cross-Language Interop - Python

This module provides utilities for loading plugins written in other languages
(Rust, TypeScript) into the Python runtime.

This is a standalone package that can be installed separately or used from
within the main elizaos package.
"""

# Import from local module (not from elizaos.interop as this IS the interop module)
from .rust_ffi import (
    RustPluginFFI,
    find_rust_plugin,
    get_lib_extension,
    get_lib_prefix,
    load_rust_plugin,
)

__all__ = [
    # Rust FFI
    "RustPluginFFI",
    "load_rust_plugin",
    "find_rust_plugin",
    "get_lib_extension",
    "get_lib_prefix",
]

