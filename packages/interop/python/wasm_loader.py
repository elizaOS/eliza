"""
WASM Plugin Loader for elizaOS

This module provides utilities for loading WASM plugins into the Python runtime
via wasmtime or similar WASM runtimes.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, Awaitable

# Try to import wasmtime, provide fallback if not available
try:
    import wasmtime
    HAS_WASMTIME = True
except ImportError:
    HAS_WASMTIME = False
    wasmtime = None  # type: ignore

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


class WasmPluginLoader:
    """
    WASM plugin loader for elizaOS.

    Loads Rust or TypeScript plugins compiled to WASM and adapts them
    to the Python Plugin interface.

    Requires wasmtime-py: pip install wasmtime

    The WASM plugin must export these functions:
    - get_manifest() -> ptr (JSON string)
    - init(config_ptr: i32, config_len: i32)
    - validate_action(name_ptr, name_len, memory_ptr, memory_len, state_ptr, state_len) -> i32
    - invoke_action(name_ptr, name_len, memory_ptr, memory_len, state_ptr, state_len, options_ptr, options_len) -> ptr
    - get_provider(name_ptr, name_len, memory_ptr, memory_len, state_ptr, state_len) -> ptr
    - validate_evaluator(name_ptr, name_len, memory_ptr, memory_len, state_ptr, state_len) -> i32
    - invoke_evaluator(name_ptr, name_len, memory_ptr, memory_len, state_ptr, state_len) -> ptr
    - alloc(size: i32) -> ptr
    - dealloc(ptr: i32, size: i32)
    """

    def __init__(
        self,
        wasm_path: str | Path,
        *,
        max_module_bytes: int | None = None,
        max_memory_bytes: int | None = None,
        fuel: int | None = None,
        max_string_bytes: int = 1_000_000,
    ) -> None:
        """
        Initialize the WASM plugin loader.

        Args:
            wasm_path: Path to the WASM file.

        Raises:
            ImportError: If wasmtime is not installed.
            FileNotFoundError: If the WASM file doesn't exist.
        """
        if not HAS_WASMTIME:
            raise ImportError(
                "wasmtime is required for WASM plugin loading. "
                "Install with: pip install wasmtime"
            )

        self.wasm_path = Path(wasm_path)
        if not self.wasm_path.exists():
            raise FileNotFoundError(f"WASM file not found: {wasm_path}")

        if max_module_bytes is not None:
            size = self.wasm_path.stat().st_size
            if size > max_module_bytes:
                raise ValueError(
                    f"WASM module too large ({size} bytes > {max_module_bytes} bytes)"
                )

        self.max_memory_bytes = max_memory_bytes
        self.max_string_bytes = max_string_bytes

        # Initialize wasmtime engine and store
        if fuel is not None:
            config = wasmtime.Config()
            config.consume_fuel = True
            self.engine = wasmtime.Engine(config)
        else:
            self.engine = wasmtime.Engine()
        self.store = wasmtime.Store(self.engine)
        if fuel is not None:
            self.store.add_fuel(fuel)
        self.linker = wasmtime.Linker(self.engine)

        # Load and instantiate the module
        self._setup_imports()
        self._load_module()
        self.manifest: dict[str, Any] | None = None

    def _setup_imports(self) -> None:
        """Set up the import functions for the WASM module."""
        # WASI imports (minimal stubs)
        wasi_config = wasmtime.WasiConfig()
        wasi_config.inherit_stdout()
        wasi_config.inherit_stderr()
        self.store.set_wasi(wasi_config)
        self.linker.define_wasi()

        # Environment imports for console logging
        @wasmtime.Func(self.store, wasmtime.FuncType([wasmtime.ValType.i32(), wasmtime.ValType.i32()], []))
        def console_log(ptr: int, len_: int) -> None:
            data = self._read_memory(ptr, len_)
            print(data.decode("utf-8"))

        @wasmtime.Func(self.store, wasmtime.FuncType([wasmtime.ValType.i32(), wasmtime.ValType.i32()], []))
        def console_error(ptr: int, len_: int) -> None:
            data = self._read_memory(ptr, len_)
            print(f"[ERROR] {data.decode('utf-8')}")

        self.linker.define(self.store, "env", "console_log", console_log)
        self.linker.define(self.store, "env", "console_error", console_error)

    def _load_module(self) -> None:
        """Load and instantiate the WASM module."""
        with open(self.wasm_path, "rb") as f:
            wasm_bytes = f.read()

        self.module = wasmtime.Module(self.engine, wasm_bytes)
        self.instance = self.linker.instantiate(self.store, self.module)

        # Get memory export
        memory_export = self.instance.exports(self.store).get("memory")
        if memory_export is None:
            raise RuntimeError("WASM module does not export 'memory'")
        self.memory = memory_export

        if self.max_memory_bytes is not None:
            mem_data = self.memory.data_ptr(self.store)
            if len(mem_data) > self.max_memory_bytes:
                raise RuntimeError(
                    f"WASM memory too large ({len(mem_data)} bytes > {self.max_memory_bytes} bytes)"
                )

    def _read_memory(self, ptr: int, length: int) -> bytes:
        """Read bytes from WASM memory."""
        data = self.memory.data_ptr(self.store)
        return bytes(data[ptr:ptr + length])

    def _write_memory(self, ptr: int, data: bytes) -> None:
        """Write bytes to WASM memory."""
        mem_data = self.memory.data_ptr(self.store)
        for i, byte in enumerate(data):
            mem_data[ptr + i] = byte

    def _read_string(self, ptr: int) -> str:
        """Read a null-terminated string from WASM memory."""
        mem_data = self.memory.data_ptr(self.store)
        end = ptr
        limit = ptr + self.max_string_bytes
        while end < len(mem_data) and end < limit and mem_data[end] != 0:
            end += 1
        if end >= len(mem_data) or end >= limit:
            raise RuntimeError("WASM string exceeded maximum length or memory bounds")
        return bytes(mem_data[ptr:end]).decode("utf-8")

    def _call_with_string(self, func_name: str, *strings: str) -> str | None:
        """Call a WASM function with string arguments and get string result."""
        exports = self.instance.exports(self.store)
        func = exports.get(func_name)
        if func is None:
            raise RuntimeError(f"WASM function '{func_name}' not found")

        alloc = exports.get("alloc")
        dealloc = exports.get("dealloc")
        if alloc is None or dealloc is None:
            raise RuntimeError("WASM module must export 'alloc' and 'dealloc'")

        # Allocate and write each string
        ptrs_and_lens: list[tuple[int, int]] = []
        for s in strings:
            encoded = s.encode("utf-8")
            ptr = alloc(self.store, len(encoded))
            self._write_memory(ptr, encoded)
            ptrs_and_lens.append((ptr, len(encoded)))

        # Build arguments (alternating ptr, len for each string)
        args = []
        for ptr, length in ptrs_and_lens:
            args.extend([ptr, length])

        # Call the function
        result_ptr = func(self.store, *args)

        # Cleanup input strings
        for ptr, length in ptrs_and_lens:
            dealloc(self.store, ptr, length)

        if result_ptr == 0:
            return None

        return self._read_string(result_ptr)

    def get_manifest(self) -> dict[str, Any]:
        """Get the plugin manifest from the WASM module."""
        if self.manifest is not None:
            return self.manifest

        exports = self.instance.exports(self.store)
        get_manifest_fn = exports.get("get_manifest")
        if get_manifest_fn is None:
            raise RuntimeError("WASM module must export 'get_manifest'")

        result_ptr = get_manifest_fn(self.store)
        if result_ptr == 0:
            raise RuntimeError("get_manifest returned null")

        json_str = self._read_string(result_ptr)
        self.manifest = json.loads(json_str)
        return self.manifest

    def init(self, config: dict[str, str]) -> None:
        """Initialize the plugin with configuration."""
        exports = self.instance.exports(self.store)
        init_fn = exports.get("init")
        if init_fn is None:
            return  # init is optional

        alloc = exports.get("alloc")
        if alloc is None:
            return

        config_json = json.dumps(config).encode("utf-8")
        ptr = alloc(self.store, len(config_json))
        self._write_memory(ptr, config_json)
        init_fn(self.store, ptr, len(config_json))

    def validate_action(self, name: str, memory: Memory, state: State | None) -> bool:
        """Validate an action."""
        result = self._call_validate("validate_action", name, memory, state)
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

        result_json = self._call_with_string(
            "invoke_action", name, memory_json, state_json, options_json
        )
        if not result_json:
            return ActionResult(success=False, error="No result from WASM plugin")

        result_data = json.loads(result_json)
        return ActionResult(**result_data)

    def get_provider(self, name: str, memory: Memory, state: State) -> ProviderResult:
        """Get provider data."""
        memory_json = json.dumps(memory.model_dump() if hasattr(memory, "model_dump") else memory)
        state_json = json.dumps(state.model_dump() if hasattr(state, "model_dump") else state)

        result_json = self._call_with_string("get_provider", name, memory_json, state_json)
        if not result_json:
            return ProviderResult()

        result_data = json.loads(result_json)
        return ProviderResult(**result_data)

    def validate_evaluator(self, name: str, memory: Memory, state: State | None) -> bool:
        """Validate an evaluator."""
        result = self._call_validate("validate_evaluator", name, memory, state)
        return result != 0

    def invoke_evaluator(self, name: str, memory: Memory, state: State | None) -> ActionResult | None:
        """Invoke an evaluator."""
        memory_json = json.dumps(memory.model_dump() if hasattr(memory, "model_dump") else memory)
        state_json = json.dumps(
            state.model_dump() if state and hasattr(state, "model_dump") else state
        )

        result_json = self._call_with_string("invoke_evaluator", name, memory_json, state_json)
        if not result_json or result_json == "null":
            return None

        result_data = json.loads(result_json)
        return ActionResult(**result_data)

    def _call_validate(
        self, func_name: str, name: str, memory: Memory, state: State | None
    ) -> int:
        """Call a validation function."""
        exports = self.instance.exports(self.store)
        func = exports.get(func_name)
        alloc = exports.get("alloc")
        dealloc = exports.get("dealloc")

        if func is None or alloc is None or dealloc is None:
            return 0

        name_bytes = name.encode("utf-8")
        memory_json = json.dumps(
            memory.model_dump() if hasattr(memory, "model_dump") else memory
        ).encode("utf-8")
        state_json = json.dumps(
            state.model_dump() if state and hasattr(state, "model_dump") else state
        ).encode("utf-8")

        name_ptr = alloc(self.store, len(name_bytes))
        mem_ptr = alloc(self.store, len(memory_json))
        state_ptr = alloc(self.store, len(state_json))

        self._write_memory(name_ptr, name_bytes)
        self._write_memory(mem_ptr, memory_json)
        self._write_memory(state_ptr, state_json)

        result = func(
            self.store,
            name_ptr, len(name_bytes),
            mem_ptr, len(memory_json),
            state_ptr, len(state_json),
        )

        dealloc(self.store, name_ptr, len(name_bytes))
        dealloc(self.store, mem_ptr, len(memory_json))
        dealloc(self.store, state_ptr, len(state_json))

        return result


def load_wasm_plugin(
    wasm_path: str | Path,
    manifest_path: str | Path | None = None,
    *,
    max_module_bytes: int | None = None,
    max_memory_bytes: int | None = None,
    fuel: int | None = None,
) -> Plugin:
    """
    Load a WASM plugin and return an elizaOS Plugin interface.

    Args:
        wasm_path: Path to the WASM file.
        manifest_path: Optional path to external manifest JSON (uses embedded if not provided).

    Returns:
        elizaOS Plugin instance.
    """
    loader = WasmPluginLoader(
        wasm_path,
        max_module_bytes=max_module_bytes,
        max_memory_bytes=max_memory_bytes,
        fuel=fuel,
    )

    # Get manifest
    if manifest_path:
        with open(manifest_path) as f:
            manifest = json.load(f)
    else:
        manifest = loader.get_manifest()

    # Create action wrappers
    actions: list[Action] = []
    for action_def in manifest.get("actions", []):
        action_name = action_def["name"]

        def make_validate(name: str) -> Callable[..., Awaitable[bool]]:
            async def validate(runtime: Any, message: Memory, state: State | None) -> bool:
                return loader.validate_action(name, message, state)
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
                return loader.invoke_action(
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
                return loader.get_provider(name, message, state)
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
                return loader.validate_evaluator(name, message, state)
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
                return loader.invoke_evaluator(name, message, state)
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
        loader.init(config)

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


def validate_wasm_plugin(wasm_path: str | Path) -> dict[str, Any]:
    """
    Validate a WASM plugin without fully loading it.

    Args:
        wasm_path: Path to the WASM file.

    Returns:
        Dict with 'valid', 'manifest', and optionally 'error' keys.
    """
    try:
        loader = WasmPluginLoader(wasm_path)
        manifest = loader.get_manifest()

        if not manifest.get("name") or not manifest.get("description"):
            return {"valid": False, "error": "Missing required manifest fields"}

        return {"valid": True, "manifest": manifest}
    except Exception as e:
        return {"valid": False, "error": str(e)}






