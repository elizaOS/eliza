"""
Rust Plugin FFI Loader for elizaOS

This module provides utilities for loading Rust plugins into the Python runtime
via ctypes/cffi FFI bindings.
"""

from __future__ import annotations

import ctypes
import json
import platform
from pathlib import Path
from typing import Any, Callable, Awaitable

from elizaos.types.plugin import Plugin
from elizaos.types.memory import Memory
from elizaos.types.state import State
from elizaos.types.components import (
    Action,
    ActionResult,
    Provider,
    ProviderResult,
    Evaluator,
    HandlerOptions,
)


def get_lib_extension() -> str:
    """Get the shared library extension for the current platform."""
    system = platform.system()
    if system == "Darwin":
        return ".dylib"
    elif system == "Windows":
        return ".dll"
    else:
        return ".so"


def get_lib_prefix() -> str:
    """Get the shared library prefix for the current platform."""
    system = platform.system()
    if system == "Windows":
        return ""
    else:
        return "lib"


class RustPluginFFI:
    """
    FFI wrapper for Rust plugins.
    
    The Rust plugin must export these functions:
    - elizaos_get_manifest() -> *const c_char
    - elizaos_init(config_json: *const c_char) -> c_int
    - elizaos_validate_action(name: *const c_char, memory: *const c_char, state: *const c_char) -> c_int
    - elizaos_invoke_action(name: *const c_char, memory: *const c_char, state: *const c_char, options: *const c_char) -> *const c_char
    - elizaos_get_provider(name: *const c_char, memory: *const c_char, state: *const c_char) -> *const c_char
    - elizaos_validate_evaluator(name: *const c_char, memory: *const c_char, state: *const c_char) -> c_int
    - elizaos_invoke_evaluator(name: *const c_char, memory: *const c_char, state: *const c_char) -> *const c_char
    - elizaos_free_string(ptr: *const c_char) -> void
    """

    def __init__(self, lib_path: str | Path) -> None:
        """
        Initialize the FFI wrapper.
        
        Args:
            lib_path: Path to the shared library (.so/.dylib/.dll)
        """
        self.lib_path = Path(lib_path)
        if not self.lib_path.exists():
            raise FileNotFoundError(f"Shared library not found: {lib_path}")

        # Load the library
        self.lib = ctypes.CDLL(str(self.lib_path))
        self._setup_bindings()
        self.manifest: dict[str, Any] | None = None

    def _setup_bindings(self) -> None:
        """Set up ctypes function bindings."""
        # elizaos_get_manifest() -> *const c_char
        self.lib.elizaos_get_manifest.argtypes = []
        self.lib.elizaos_get_manifest.restype = ctypes.c_char_p

        # elizaos_init(config_json: *const c_char) -> c_int
        self.lib.elizaos_init.argtypes = [ctypes.c_char_p]
        self.lib.elizaos_init.restype = ctypes.c_int

        # elizaos_validate_action(...)
        self.lib.elizaos_validate_action.argtypes = [
            ctypes.c_char_p,  # action name
            ctypes.c_char_p,  # memory json
            ctypes.c_char_p,  # state json
        ]
        self.lib.elizaos_validate_action.restype = ctypes.c_int

        # elizaos_invoke_action(...)
        self.lib.elizaos_invoke_action.argtypes = [
            ctypes.c_char_p,  # action name
            ctypes.c_char_p,  # memory json
            ctypes.c_char_p,  # state json
            ctypes.c_char_p,  # options json
        ]
        self.lib.elizaos_invoke_action.restype = ctypes.c_char_p

        # elizaos_get_provider(...)
        self.lib.elizaos_get_provider.argtypes = [
            ctypes.c_char_p,  # provider name
            ctypes.c_char_p,  # memory json
            ctypes.c_char_p,  # state json
        ]
        self.lib.elizaos_get_provider.restype = ctypes.c_char_p

        # elizaos_validate_evaluator(...)
        self.lib.elizaos_validate_evaluator.argtypes = [
            ctypes.c_char_p,  # evaluator name
            ctypes.c_char_p,  # memory json
            ctypes.c_char_p,  # state json
        ]
        self.lib.elizaos_validate_evaluator.restype = ctypes.c_int

        # elizaos_invoke_evaluator(...)
        self.lib.elizaos_invoke_evaluator.argtypes = [
            ctypes.c_char_p,  # evaluator name
            ctypes.c_char_p,  # memory json
            ctypes.c_char_p,  # state json
        ]
        self.lib.elizaos_invoke_evaluator.restype = ctypes.c_char_p

        # elizaos_free_string(ptr: *const c_char)
        self.lib.elizaos_free_string.argtypes = [ctypes.c_char_p]
        self.lib.elizaos_free_string.restype = None

    def _to_c_string(self, s: str | None) -> ctypes.c_char_p:
        """Convert Python string to C string."""
        if s is None:
            return ctypes.c_char_p(None)
        return ctypes.c_char_p(s.encode("utf-8"))

    def _from_c_string(self, ptr: ctypes.c_char_p) -> str | None:
        """Convert C string to Python string and free the C memory."""
        if not ptr:
            return None
        result = ptr.decode("utf-8")
        self.lib.elizaos_free_string(ptr)
        return result

    def get_manifest(self) -> dict[str, Any]:
        """Get the plugin manifest."""
        if self.manifest:
            return self.manifest

        ptr = self.lib.elizaos_get_manifest()
        json_str = self._from_c_string(ptr)
        if not json_str:
            raise RuntimeError("Failed to get manifest from Rust plugin")

        self.manifest = json.loads(json_str)
        return self.manifest

    def init(self, config: dict[str, str]) -> None:
        """Initialize the plugin with configuration."""
        config_json = json.dumps(config)
        result = self.lib.elizaos_init(self._to_c_string(config_json))
        if result != 0:
            raise RuntimeError(f"Plugin initialization failed with code {result}")

    def validate_action(self, name: str, memory: Memory, state: State | None) -> bool:
        """Validate an action."""
        memory_json = json.dumps(memory.model_dump() if hasattr(memory, "model_dump") else memory)
        state_json = json.dumps(
            state.model_dump() if state and hasattr(state, "model_dump") else state
        )

        result = self.lib.elizaos_validate_action(
            self._to_c_string(name),
            self._to_c_string(memory_json),
            self._to_c_string(state_json),
        )
        return result != 0

    def invoke_action(
        self, name: str, memory: Memory, state: State | None, options: dict[str, Any] | None
    ) -> ActionResult:
        """Invoke an action."""
        memory_json = json.dumps(memory.model_dump() if hasattr(memory, "model_dump") else memory)
        state_json = json.dumps(
            state.model_dump() if state and hasattr(state, "model_dump") else state
        )
        options_json = json.dumps(options or {})

        result_ptr = self.lib.elizaos_invoke_action(
            self._to_c_string(name),
            self._to_c_string(memory_json),
            self._to_c_string(state_json),
            self._to_c_string(options_json),
        )
        result_json = self._from_c_string(result_ptr)
        if not result_json:
            return ActionResult(success=False, error="No result from Rust plugin")

        result_data = json.loads(result_json)
        return ActionResult(**result_data)

    def get_provider(self, name: str, memory: Memory, state: State) -> ProviderResult:
        """Get provider data."""
        memory_json = json.dumps(memory.model_dump() if hasattr(memory, "model_dump") else memory)
        state_json = json.dumps(state.model_dump() if hasattr(state, "model_dump") else state)

        result_ptr = self.lib.elizaos_get_provider(
            self._to_c_string(name),
            self._to_c_string(memory_json),
            self._to_c_string(state_json),
        )
        result_json = self._from_c_string(result_ptr)
        if not result_json:
            return ProviderResult()

        result_data = json.loads(result_json)
        return ProviderResult(**result_data)

    def validate_evaluator(self, name: str, memory: Memory, state: State | None) -> bool:
        """Validate an evaluator."""
        memory_json = json.dumps(memory.model_dump() if hasattr(memory, "model_dump") else memory)
        state_json = json.dumps(
            state.model_dump() if state and hasattr(state, "model_dump") else state
        )

        result = self.lib.elizaos_validate_evaluator(
            self._to_c_string(name),
            self._to_c_string(memory_json),
            self._to_c_string(state_json),
        )
        return result != 0

    def invoke_evaluator(self, name: str, memory: Memory, state: State | None) -> ActionResult | None:
        """Invoke an evaluator."""
        memory_json = json.dumps(memory.model_dump() if hasattr(memory, "model_dump") else memory)
        state_json = json.dumps(
            state.model_dump() if state and hasattr(state, "model_dump") else state
        )

        result_ptr = self.lib.elizaos_invoke_evaluator(
            self._to_c_string(name),
            self._to_c_string(memory_json),
            self._to_c_string(state_json),
        )
        result_json = self._from_c_string(result_ptr)
        if not result_json or result_json == "null":
            return None

        result_data = json.loads(result_json)
        return ActionResult(**result_data)


def load_rust_plugin(lib_path: str | Path) -> Plugin:
    """
    Load a Rust plugin from a shared library.
    
    Args:
        lib_path: Path to the shared library
        
    Returns:
        elizaOS Plugin instance
    """
    ffi = RustPluginFFI(lib_path)
    manifest = ffi.get_manifest()

    # Create action wrappers
    actions: list[Action] = []
    for action_def in manifest.get("actions", []):
        action_name = action_def["name"]

        def make_validate(name: str) -> Callable[..., Awaitable[bool]]:
            async def validate(runtime: Any, message: Memory, state: State | None) -> bool:
                return ffi.validate_action(name, message, state)

            return validate

        def make_handler(name: str) -> Callable[..., Awaitable[ActionResult | None]]:
            async def handler(
                runtime: Any,
                message: Memory,
                state: State | None,
                options: HandlerOptions | None,
                callback: Any,
                responses: Any,
            ) -> ActionResult | None:
                return ffi.invoke_action(
                    name, message, state, options.model_dump() if options else None
                )

            return handler

        validate_fn = make_validate(action_name)
        handler_fn = make_handler(action_name)

        actions.append(
            Action(
                name=action_name,
                description=action_def.get("description", ""),
                similes=action_def.get("similes"),
                examples=action_def.get("examples"),
                validate=validate_fn,  # type: ignore
                handler=handler_fn,  # type: ignore
            )
        )

    # Create provider wrappers
    providers: list[Provider] = []
    for provider_def in manifest.get("providers", []):
        provider_name = provider_def["name"]

        def make_get(name: str) -> Callable[..., Awaitable[ProviderResult]]:
            async def get(runtime: Any, message: Memory, state: State) -> ProviderResult:
                return ffi.get_provider(name, message, state)

            return get

        get_fn = make_get(provider_name)

        providers.append(
            Provider(
                name=provider_name,
                description=provider_def.get("description"),
                dynamic=provider_def.get("dynamic"),
                position=provider_def.get("position"),
                private=provider_def.get("private"),
                get=get_fn,  # type: ignore
            )
        )

    # Create evaluator wrappers
    evaluators: list[Evaluator] = []
    for eval_def in manifest.get("evaluators", []):
        eval_name = eval_def["name"]

        def make_eval_validate(name: str) -> Callable[..., Awaitable[bool]]:
            async def validate(runtime: Any, message: Memory, state: State | None) -> bool:
                return ffi.validate_evaluator(name, message, state)

            return validate

        def make_eval_handler(name: str) -> Callable[..., Awaitable[ActionResult | None]]:
            async def handler(
                runtime: Any,
                message: Memory,
                state: State | None,
                options: HandlerOptions | None,
                callback: Any,
                responses: Any,
            ) -> ActionResult | None:
                return ffi.invoke_evaluator(name, message, state)

            return handler

        validate_fn = make_eval_validate(eval_name)
        handler_fn = make_eval_handler(eval_name)

        evaluators.append(
            Evaluator(
                name=eval_name,
                description=eval_def.get("description", ""),
                always_run=eval_def.get("alwaysRun"),
                similes=eval_def.get("similes"),
                examples=[],
                validate=validate_fn,  # type: ignore
                handler=handler_fn,  # type: ignore
            )
        )

    # Create init function
    async def init(config: dict[str, str], runtime: Any) -> None:
        ffi.init(config)

    return Plugin(
        name=manifest["name"],
        description=manifest["description"],
        init=init,
        config=manifest.get("config"),
        dependencies=manifest.get("dependencies"),
        actions=actions if actions else None,
        providers=providers if providers else None,
        evaluators=evaluators if evaluators else None,
    )


def find_rust_plugin(name: str, search_paths: list[str | Path] | None = None) -> Path | None:
    """
    Find a Rust plugin by name in common locations.
    
    Args:
        name: Plugin name (without lib prefix or extension)
        search_paths: Additional paths to search
        
    Returns:
        Path to the shared library, or None if not found
    """
    prefix = get_lib_prefix()
    ext = get_lib_extension()
    lib_name = f"{prefix}{name}{ext}"

    paths_to_search = search_paths or []
    paths_to_search.extend([
        Path.cwd() / "target" / "release",
        Path.cwd() / "target" / "debug",
        Path.cwd() / "dist",
        Path.home() / ".elizaos" / "plugins",
    ])

    for path in paths_to_search:
        lib_path = Path(path) / lib_name
        if lib_path.exists():
            return lib_path

    return None

