#!/usr/bin/env python3
"""
Python Runtime Loading Plugins from All Languages

This example demonstrates how the Python runtime can load:
- Rust plugins via FFI (ctypes)
- Rust plugins via WASM (wasmtime)
- TypeScript plugins via IPC subprocess
- Native Python plugins directly

Usage:
    python py_loads_all.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import TYPE_CHECKING

# Add interop package to path
sys.path.insert(0, str(Path(__file__).parent.parent / "python"))

if TYPE_CHECKING:
    from elizaos.types.memory import Memory
    from elizaos.types.state import State


# ============================================================================
# Example 1: Load Rust Plugin via FFI
# ============================================================================


async def load_rust_via_ffi() -> None:
    """Load a Rust plugin using ctypes FFI."""
    print("\n=== Loading Rust Plugin via FFI ===\n")

    try:
        from elizaos.interop import load_rust_plugin

        # Path to compiled shared library
        lib_path = Path(__file__).parent.parent.parent.parent / (
            "plugins/plugin-eliza-classic/rust/target/release/libelizaos_plugin_eliza_classic.so"
        )

        if not lib_path.exists():
            # Try debug build
            lib_path = Path(__file__).parent.parent.parent.parent / (
                "plugins/plugin-eliza-classic/rust/target/debug/libelizaos_plugin_eliza_classic.so"
            )

        plugin = load_rust_plugin(str(lib_path))

        print(f"Plugin: {plugin.name}")
        print(f"Description: {plugin.description}")
        print(f"Actions: {[a.name for a in plugin.actions]}")

        # Test the action
        if plugin.actions:
            action = plugin.actions[0]

            mock_memory = {
                "id": "123",
                "agentId": "456",
                "roomId": "789",
                "entityId": "abc",
                "content": {"text": "I am feeling anxious"},
                "createdAt": 0,
            }
            mock_state = {"values": {}, "data": {}}

            print('\nInvoking action with: "I am feeling anxious"')
            result = await action.handler(None, mock_memory, mock_state, {})
            print(f"Response: {result.get('text', 'No response')}")

    except FileNotFoundError:
        print("FFI loading skipped (build Rust library first with: cargo build --release --features ffi)")
    except ImportError as e:
        print(f"FFI loading skipped (missing dependencies): {e}")
    except Exception as e:
        print(f"FFI loading failed: {e}")


# ============================================================================
# Example 2: Load Rust Plugin via WASM
# ============================================================================


async def load_rust_via_wasm() -> None:
    """Load a Rust plugin using wasmtime."""
    print("\n=== Loading Rust Plugin via WASM ===\n")

    try:
        from elizaos.interop import load_wasm_plugin

        # Path to compiled WASM module
        wasm_path = Path(__file__).parent.parent.parent.parent / (
            "plugins/plugin-eliza-classic/rust/target/wasm32-unknown-unknown/release/"
            "elizaos_plugin_eliza_classic.wasm"
        )

        plugin = load_wasm_plugin(str(wasm_path))

        print(f"Plugin: {plugin.name}")
        print(f"Description: {plugin.description}")
        print(f"Actions: {[a.name for a in plugin.actions]}")

        # Test the action
        if plugin.actions:
            action = plugin.actions[0]

            mock_memory = {
                "id": "123",
                "content": {"text": "I dream about flying"},
            }
            mock_state = {"values": {}, "data": {}}

            print('\nInvoking action with: "I dream about flying"')
            result = await action.handler(None, mock_memory, mock_state, {})
            print(f"Response: {result.get('text', 'No response')}")

    except FileNotFoundError:
        print("WASM loading skipped (build WASM first with: cargo build --target wasm32-unknown-unknown)")
    except ImportError as e:
        print(f"WASM loading skipped (wasmtime not installed): {e}")
    except Exception as e:
        print(f"WASM loading failed: {e}")


# ============================================================================
# Example 3: Load TypeScript Plugin via IPC
# ============================================================================


async def load_typescript_via_ipc() -> None:
    """Load a TypeScript plugin using subprocess IPC."""
    print("\n=== Loading TypeScript Plugin via IPC ===\n")

    try:
        from elizaos.interop import load_ts_plugin

        # Path to TypeScript plugin
        ts_plugin_path = Path(__file__).parent.parent.parent.parent / (
            "plugins/plugin-eliza-classic/typescript"
        )

        plugin = load_ts_plugin(str(ts_plugin_path))

        print(f"Plugin: {plugin.name}")
        print(f"Description: {plugin.description}")
        print(f"Actions: {[a.name for a in plugin.actions]}")

        # Test the action
        if plugin.actions:
            action = plugin.actions[0]

            mock_memory = {
                "id": "123",
                "content": {"text": "My mother always told me"},
            }
            mock_state = {"values": {}, "data": {}}

            print('\nInvoking action with: "My mother always told me"')
            result = await action.handler(None, mock_memory, mock_state, {})
            print(f"Response: {result.get('text', 'No response')}")

    except FileNotFoundError:
        print("TypeScript IPC loading skipped (ensure Node.js is installed)")
    except ImportError as e:
        print(f"TypeScript IPC loading skipped (missing dependencies): {e}")
    except Exception as e:
        print(f"TypeScript IPC loading failed: {e}")


# ============================================================================
# Example 4: Load Native Python Plugin
# ============================================================================


async def load_native_python() -> None:
    """Load a native Python plugin directly."""
    print("\n=== Loading Native Python Plugin ===\n")

    try:
        # Add plugin to path
        plugin_path = Path(__file__).parent.parent.parent.parent / "plugins/plugin-eliza-classic/python"
        sys.path.insert(0, str(plugin_path))

        from elizaos_plugin_eliza_classic import ElizaClassicPlugin

        plugin_instance = ElizaClassicPlugin()

        print(f"Plugin: eliza-classic (native Python)")
        print(f"Greeting: {plugin_instance.get_greeting()}")

        # Test response generation
        test_inputs = [
            "I am feeling sad",
            "Why don't you help me?",
            "My computer is broken",
            "Hello",
        ]

        print("\nTest responses:")
        for user_input in test_inputs:
            response = plugin_instance.generate_response(user_input)
            print(f"  User: {user_input}")
            print(f"  ELIZA: {response}\n")

    except ImportError as e:
        print(f"Native Python loading skipped: {e}")
    except Exception as e:
        print(f"Native Python loading failed: {e}")


# ============================================================================
# Example 5: Demonstrate Interop Matrix
# ============================================================================


def print_interop_matrix() -> None:
    """Print the full interop capability matrix."""
    print("\n" + "=" * 60)
    print("elizaOS Cross-Language Interop Matrix")
    print("=" * 60)

    matrix = """
    ┌──────────────┬──────────────┬──────────┬─────────────────┐
    │ Host Runtime │ Plugin Lang  │ Method   │ Status          │
    ├──────────────┼──────────────┼──────────┼─────────────────┤
    │ Python       │ Rust         │ FFI      │ ✓ Native speed  │
    │ Python       │ Rust         │ WASM     │ ✓ Sandboxed     │
    │ Python       │ TypeScript   │ IPC      │ ✓ Subprocess    │
    │ Python       │ Python       │ Direct   │ ✓ Native        │
    ├──────────────┼──────────────┼──────────┼─────────────────┤
    │ TypeScript   │ Rust         │ WASM     │ ✓ Sandboxed     │
    │ TypeScript   │ Python       │ IPC      │ ✓ Subprocess    │
    │ TypeScript   │ TypeScript   │ Direct   │ ✓ Native        │
    ├──────────────┼──────────────┼──────────┼─────────────────┤
    │ Rust         │ TypeScript   │ IPC      │ ✓ Subprocess    │
    │ Rust         │ Python       │ IPC      │ ✓ Subprocess    │
    │ Rust         │ Rust         │ Direct   │ ✓ Native        │
    └──────────────┴──────────────┴──────────┴─────────────────┘
    """
    print(matrix)


# ============================================================================
# Main
# ============================================================================


async def main() -> None:
    """Run all interop examples."""
    print("=" * 60)
    print("Python Runtime - Cross-Language Plugin Loading Demo")
    print("=" * 60)

    print_interop_matrix()

    await load_native_python()
    await load_rust_via_ffi()
    await load_rust_via_wasm()
    await load_typescript_via_ipc()

    print("\n" + "=" * 60)
    print("Demo complete!")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())






