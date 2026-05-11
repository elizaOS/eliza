"""YAML-based MCP server configuration loader.

This module provides a generic loader for MCP server configurations,
replacing the individual helper.py files with declarative YAML configs.
"""

import os
import warnings
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml


class ServerConfigLoader:
    """Loads and processes MCP server configurations from YAML files."""

    def __init__(self, base_dir: Optional[Path] = None):
        """Initialize the config loader.

        Args:
            base_dir: Base directory containing server subdirectories.
                     Defaults to the directory of this file.
        """
        self.base_dir = base_dir or Path(__file__).parent

    def load_config(self, server_type: str) -> Dict[str, Any]:
        """Load and validate YAML config for a server type.

        Args:
            server_type: Type of server (e.g., 'canvas', 'claim_done')

        Returns:
            Parsed YAML configuration dictionary

        Raises:
            FileNotFoundError: If config YAML doesn't exist
            ValueError: If YAML is invalid or missing required fields
        """
        # New location: config/{server_type}.yaml
        config_path = self.base_dir / "config" / f"{server_type}.yaml"

        # Fallback to old location for backward compatibility during transition
        if not config_path.exists():
            old_config_path = self.base_dir / server_type / "server_config.yaml"
            if old_config_path.exists():
                config_path = old_config_path
            else:
                raise FileNotFoundError(
                    f"No YAML config found for server type '{server_type}'. "
                    f"Tried: {config_path} and {old_config_path}"
                )

        try:
            with open(config_path, "r", encoding="utf-8") as f:
                config = yaml.safe_load(f)
        except yaml.YAMLError as e:
            raise ValueError(f"Invalid YAML in {config_path}: {e}") from e

        # Validate required fields
        if "name" not in config:
            raise ValueError(f"Missing 'name' field in {config_path}")
        if "execution" not in config:
            raise ValueError(f"Missing 'execution' field in {config_path}")

        return config

    def build_stdio_config(
        self,
        server_type: str,
        params: Dict[str, Any],
        server_name: Optional[str] = None,
    ) -> Dict[str, Dict[str, Any]]:
        """Build stdio configuration for a server.

        Args:
            server_type: Type of server (e.g., 'canvas', 'claim_done')
            params: Runtime parameters from JSON config
            server_name: Override server name (defaults to config name)

        Returns:
            Configuration dict in format: {server_name: {"command": ..., "args": [...], "env": {...}}}

        Raises:
            FileNotFoundError: If config doesn't exist
            ValueError: If config is invalid or required params missing
        """
        config = self.load_config(server_type)

        # Resolve server name
        actual_server_name = server_name or config["name"]

        # Build command
        command, args = self._build_command(config, params)

        # Build environment variables
        env = self._build_env_vars(config, params)

        # Determine working directory
        cwd = self._determine_cwd(config, params)

        # Build stdio config
        stdio_config = {
            "command": command,
            "args": args,
        }

        if env:
            stdio_config["env"] = env

        if cwd:
            stdio_config["cwd"] = cwd

        return {actual_server_name: stdio_config}

    def _build_command(
        self, config: Dict[str, Any], params: Dict[str, Any]
    ) -> tuple[str, List[str]]:
        """Build command and arguments from config.

        Args:
            config: Server configuration dict
            params: Runtime parameters

        Returns:
            Tuple of (command, args_list)

        Raises:
            ValueError: If command type is unknown or required fields missing
        """
        execution = config["execution"]
        command_type = execution.get("command_type")

        if command_type == "python":
            return self._build_python_command(config, params)
        elif command_type == "uv":
            return self._build_uv_command(config, params)
        elif command_type == "uvx":
            return self._build_uvx_command(config, params)
        elif command_type == "node":
            return self._build_node_command(config, params)
        elif command_type == "npx":
            return self._build_npx_command(config, params)
        elif command_type == "direct":
            return self._build_direct_command(config, params)
        else:
            raise ValueError(f"Unknown command_type: {command_type}")

    def _build_python_command(
        self, config: Dict[str, Any], params: Dict[str, Any]
    ) -> tuple[str, List[str]]:
        """Build Python command."""
        execution = config["execution"]
        script_path = self._resolve_script_path(execution.get("script", {}))

        args = [str(script_path)]
        args.extend(self._build_cli_args(config, params))

        return "python", args

    def _build_uv_command(
        self, config: Dict[str, Any], params: Dict[str, Any]
    ) -> tuple[str, List[str]]:
        """Build UV command."""
        execution = config["execution"]
        script_path = self._resolve_script_path(execution.get("script", {}))

        # Determine project root
        project_root = self._get_project_root(script_path)

        args = ["--directory", str(project_root), "run", "python", str(script_path)]
        args.extend(self._build_cli_args(config, params))

        return "uv", args

    def _build_uvx_command(
        self, config: Dict[str, Any], params: Dict[str, Any]
    ) -> tuple[str, List[str]]:
        """Build UVX command."""
        execution = config["execution"]
        package_name = execution.get("package_name")

        if not package_name:
            raise ValueError("uvx command_type requires 'package_name' in execution config")

        args = [package_name]
        args.extend(self._build_cli_args(config, params))

        return "uvx", args

    def _build_node_command(
        self, config: Dict[str, Any], params: Dict[str, Any]
    ) -> tuple[str, List[str]]:
        """Build Node command with optional fallback to NPX."""
        execution = config["execution"]

        # Try to resolve script path
        try:
            script_path = self._resolve_script_path(execution.get("script", {}))
            args = [str(script_path)]
            args.extend(self._build_cli_args(config, params))
            return "node", args
        except FileNotFoundError:
            # Fall back to NPX if defined
            fallback = execution.get("fallback_command")
            if fallback and fallback.get("command_type") == "npx":
                package_name = fallback.get("package_name")
                if package_name:
                    args = [package_name]
                    args.extend(self._build_cli_args(config, params))
                    return "npx", args
            # Re-raise if no fallback
            raise

    def _build_npx_command(
        self, config: Dict[str, Any], params: Dict[str, Any]
    ) -> tuple[str, List[str]]:
        """Build NPX command."""
        execution = config["execution"]
        package_name = execution.get("package_name")

        if not package_name:
            raise ValueError("npx command_type requires 'package_name' in execution config")

        args = [package_name]
        args.extend(self._build_cli_args(config, params))

        return "npx", args

    def _build_direct_command(
        self, config: Dict[str, Any], params: Dict[str, Any]
    ) -> tuple[str, List[str]]:
        """Build direct executable command."""
        execution = config["execution"]
        executable_name = execution.get("executable_name")

        if not executable_name:
            raise ValueError("direct command_type requires 'executable_name' in execution config")

        args = execution.get("additional_args", []).copy()
        args.extend(self._build_cli_args(config, params))

        return executable_name, args

    def _build_cli_args(self, config: Dict[str, Any], params: Dict[str, Any]) -> List[str]:
        """Build CLI arguments from parameters.

        Args:
            config: Server configuration dict
            params: Runtime parameters

        Returns:
            List of CLI argument strings
        """
        args = []
        param_config = config.get("parameters", {})

        # Process parameters in config order
        for param_name, param_spec in param_config.items():
            # Handle parameter aliases
            if "alias_for" in param_spec:
                continue  # Skip aliases, they'll be resolved when processing the target param

            # Get parameter value (check aliases too)
            param_value = params.get(param_name)
            if param_value is None and "aliases" in param_spec:
                for alias in param_spec["aliases"]:
                    if alias in params:
                        param_value = params[alias]
                        break

            # Use default if value not provided
            if param_value is None:
                if param_spec.get("required", False):
                    raise ValueError(f"Required parameter '{param_name}' not provided")
                param_value = param_spec.get("default")

            # Skip if no value
            if param_value is None:
                continue

            # Replace placeholders
            if isinstance(param_value, str):
                param_value = self._replace_placeholders(param_value, params)

            # Add to args if cli_arg specified
            cli_arg = param_spec.get("cli_arg")
            if cli_arg is not None:
                if cli_arg == "":
                    # Positional argument (no flag)
                    args.append(str(param_value))
                else:
                    # Flag-based argument
                    args.extend([cli_arg, str(param_value)])

        return args

    def _build_env_vars(self, config: Dict[str, Any], params: Dict[str, Any]) -> Dict[str, str]:
        """Build environment variables from parameters.

        Args:
            config: Server configuration dict
            params: Runtime parameters

        Returns:
            Dictionary of environment variables
        """
        env = {}
        param_config = config.get("parameters", {})

        for param_name, param_spec in param_config.items():
            # Handle parameter aliases
            if "alias_for" in param_spec:
                continue

            # Get parameter value (check aliases too)
            param_value = params.get(param_name)
            if param_value is None and "aliases" in param_spec:
                for alias in param_spec["aliases"]:
                    if alias in params:
                        param_value = params[alias]
                        break

            # Use default if value not provided
            if param_value is None:
                param_value = param_spec.get("default")

            # Skip if no value
            if param_value is None:
                continue

            # Replace placeholders
            if isinstance(param_value, str):
                param_value = self._replace_placeholders(param_value, params)

            # Add to env if env_var specified
            env_var = param_spec.get("env_var")
            if env_var:
                env[env_var] = str(param_value)

        # Add terminal-specific env vars if present
        if config["name"] == "terminal":
            self._add_terminal_env_vars(env, params)

        return env

    def _add_terminal_env_vars(self, env: Dict[str, str], params: Dict[str, Any]) -> None:
        """Add terminal-specific environment variables.

        The terminal server uses many env vars that don't follow the standard pattern.
        """
        terminal_env_mapping = {
            "allowed_commands": "ALLOWED_COMMANDS",
            "allowed_flags": "ALLOWED_FLAGS",
            "max_command_length": "MAX_COMMAND_LENGTH",
            "command_timeout": "COMMAND_TIMEOUT",
            "allow_shell_operators": "ALLOW_SHELL_OPERATORS",
            "max_output_length": "MAX_OUTPUT_LENGTH",
            "max_stdout_length": "MAX_STDOUT_LENGTH",
            "max_stderr_length": "MAX_STDERR_LENGTH",
            "cli_proxy_enabled": "CLI_PROXY_ENABLED",
            "cli_proxy_url": "CLI_PROXY_URL",
        }

        for param_name, env_name in terminal_env_mapping.items():
            if param_name in params:
                value = params[param_name]
                if isinstance(value, list):
                    value = ",".join(str(v) for v in value)
                env[env_name] = str(value)

    def _determine_cwd(self, config: Dict[str, Any], params: Dict[str, Any]) -> Optional[str]:
        """Determine working directory for server.

        Args:
            config: Server configuration dict
            params: Runtime parameters

        Returns:
            Working directory path or None
        """
        workspace = config.get("workspace", {})

        if not workspace.get("set_cwd", False):
            return None

        # Determine which parameter contains the workspace path
        cwd_param = workspace.get("cwd_param")
        if cwd_param:
            cwd_value = params.get(cwd_param)
            if cwd_value:
                cwd_value = self._replace_placeholders(cwd_value, params)
                cwd_path = Path(cwd_value).resolve()

                # Create directory if it doesn't exist and mkdir_if_needed is True
                if workspace.get("mkdir_if_needed", True):
                    cwd_path.mkdir(parents=True, exist_ok=True)

                return str(cwd_path)

        return None

    def _resolve_script_path(self, script_config: Dict[str, Any]) -> Path:
        """Resolve script path with fallback logic.

        Args:
            script_config: Script configuration dict with 'primary' and optional 'fallbacks'

        Returns:
            Resolved Path object

        Raises:
            FileNotFoundError: If no valid script path found
        """
        if not script_config:
            raise ValueError("Script configuration is empty")

        primary = script_config.get("primary")
        if not primary:
            raise ValueError("Script configuration missing 'primary' field")

        fallbacks = script_config.get("fallbacks", [])

        # Try primary path (relative to gem root)
        gem_root = self._get_gem_root()
        primary_path = gem_root / primary

        if primary_path.exists():
            return primary_path

        # Try fallback paths (absolute)
        for fallback in fallbacks:
            fallback_path = Path(fallback)
            if fallback_path.exists():
                return fallback_path

        # Try relative to current directory as last resort
        if Path(primary).exists():
            return Path(primary).resolve()

        raise FileNotFoundError(
            f"Script not found. Tried:\n"
            f"  - {primary_path}\n"
            + "\n".join(f"  - {fb}" for fb in fallbacks)
        )

    def _get_project_root(self, script_path: Path) -> Path:
        """Get project root for uv commands.

        For mcp_convert servers, returns mcp_convert directory.
        Otherwise returns gem root.

        Args:
            script_path: Path to the server script

        Returns:
            Project root path
        """
        if "mcp_convert" in script_path.parts:
            # Find mcp_convert directory
            for i, part in enumerate(script_path.parts):
                if part == "mcp_convert":
                    return Path(*script_path.parts[: i + 1])

        return self._get_gem_root()

    def _get_gem_root(self) -> Path:
        """Get GEM project root directory.

        Returns:
            Path to gem root (4 levels up from this file)
        """
        return Path(__file__).parent.parent.parent.parent

    def _replace_placeholders(self, value: str, params: Dict[str, Any]) -> str:
        """Replace placeholders like {task_workspace} in values.

        Args:
            value: String value potentially containing placeholders
            params: Runtime parameters

        Returns:
            String with placeholders replaced
        """
        if not isinstance(value, str):
            return value

        # Replace common placeholders
        replacements = {
            "{task_workspace}": params.get("task_workspace", ""),
            "{agent_workspace}": params.get("agent_workspace", ""),
        }

        for placeholder, replacement in replacements.items():
            if placeholder in value:
                value = value.replace(placeholder, str(replacement))

        return value


# Global loader instance
_loader = ServerConfigLoader()


def build_server_config(
    server_type: str,
    params: Dict[str, Any],
    server_name: Optional[str] = None,
) -> Dict[str, Dict[str, Any]]:
    """Build stdio configuration for a server (convenience function).

    Args:
        server_type: Type of server (e.g., 'canvas', 'claim_done')
        params: Runtime parameters from JSON config
        server_name: Override server name (defaults to config name)

    Returns:
        Configuration dict in format: {server_name: {"command": ..., "args": [...], "env": {...}}}

    Raises:
        FileNotFoundError: If config doesn't exist
        ValueError: If config is invalid or required params missing

    Example:
        >>> config = build_server_config("canvas", {"data_dir": "/path/to/data"})
        >>> print(config)
        {"canvas": {"command": "python", "args": [...], "env": {...}}}
    """
    return _loader.build_stdio_config(server_type, params, server_name)
