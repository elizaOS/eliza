#!/usr/bin/env python3
"""
Memory Tool MCP Server

An MCP server that provides memory operations (view, create, str_replace, insert, delete, rename)
for file management in a sandboxed /memories directory.
"""

import logging
import os
import shutil
import sys
from pathlib import Path
from typing import Annotated, List, Optional

# Suppress FastMCP banner and reduce log level (must be before import)
os.environ["FASTMCP_SHOW_CLI_BANNER"] = "false"
os.environ["FASTMCP_LOG_LEVEL"] = "ERROR"

# Suppress logging unless verbose mode is enabled
if os.environ.get('LOCA_QUIET', '').lower() in ('1', 'true', 'yes'):
    logging.basicConfig(level=logging.ERROR, force=True)
    logging.getLogger().setLevel(logging.ERROR)
    for _logger_name in ["mcp", "fastmcp", "mcp.server", "mcp.client", "uvicorn", "uvicorn.error", "uvicorn.access"]:
        logging.getLogger(_logger_name).setLevel(logging.ERROR)

# Add parent directory to path for imports
gem_root = Path(__file__).parent.parent.parent.parent.parent
if str(gem_root) not in sys.path:
    sys.path.insert(0, str(gem_root))

from fastmcp import FastMCP

# Create FastMCP server
app = FastMCP("Memory Tool Server")

# Default base path (can be overridden by environment variable)
DEFAULT_BASE_PATH = "./memory_storage"


def get_base_path() -> str:
    """Get the base path from environment or use default."""
    return os.environ.get("MEMORY_TOOL_BASE_PATH", DEFAULT_BASE_PATH)


def get_memory_root() -> Path:
    """Get the memory root directory."""
    base_path = Path(get_base_path()).resolve()
    memory_root = base_path / "memories"
    memory_root.mkdir(parents=True, exist_ok=True)
    return memory_root


def validate_path(path: str) -> Path:
    """
    Validate and resolve memory paths to prevent directory traversal attacks.

    Args:
        path: The path to validate (must start with /memories)

    Returns:
        Resolved absolute Path object within memory_root

    Raises:
        ValueError: If path is invalid or attempts to escape memory directory
    """
    memory_root = get_memory_root()

    if not path.startswith("/memories"):
        raise ValueError(
            f"Path must start with /memories, got: {path}. "
            "All memory operations must be confined to the /memories directory."
        )

    # Remove /memories prefix and any leading slashes
    relative_path = path[len("/memories"):].lstrip("/")

    # Resolve to absolute path within memory_root
    if relative_path:
        full_path = (memory_root / relative_path).resolve()
    else:
        full_path = memory_root.resolve()

    # Verify the resolved path is still within memory_root
    try:
        full_path.relative_to(memory_root.resolve())
    except ValueError as e:
        raise ValueError(
            f"Path '{path}' would escape /memories directory. "
            "Directory traversal attempts are not allowed."
        ) from e

    return full_path


@app.tool()
def view(
    path: Annotated[str, "Path to view (must start with /memories)"],
    view_range: Annotated[Optional[List[int]], "Optional [start_line, end_line] for viewing specific lines. Use -1 for end_line to view to end of file."] = None
) -> str:
    """View directory contents or file contents in the /memories directory."""
    try:
        full_path = validate_path(path)

        # Handle directory listing
        if full_path.is_dir():
            items = []
            for item in sorted(full_path.iterdir()):
                if item.name.startswith("."):
                    continue
                items.append(f"{item.name}/" if item.is_dir() else item.name)

            if not items:
                return f"Directory: {path}\n(empty)"

            return f"Directory: {path}\n" + "\n".join([f"- {item}" for item in items])

        # Handle file reading
        elif full_path.is_file():
            content = full_path.read_text(encoding="utf-8")
            lines = content.splitlines()

            # Apply view range if specified
            if view_range:
                start_line = max(1, view_range[0]) - 1  # Convert to 0-indexed
                end_line = len(lines) if view_range[1] == -1 else view_range[1]
                lines = lines[start_line:end_line]
                start_num = start_line + 1
            else:
                start_num = 1

            # Format with line numbers
            numbered_lines = [f"{i + start_num:4d}: {line}" for i, line in enumerate(lines)]
            return "\n".join(numbered_lines)

        else:
            return f"Error: Path not found: {path}"

    except UnicodeDecodeError:
        return f"Error: Cannot read {path}: File is not valid UTF-8 text"
    except ValueError as e:
        return f"Error: {str(e)}"
    except Exception as e:
        return f"Error: Cannot read {path}: {e}"


@app.tool()
def create(
    path: Annotated[str, "Path to create file at (must start with /memories and end with supported extension)"],
    file_text: Annotated[str, "Content to write to the file"] = ""
) -> str:
    """Create or overwrite a file in the /memories directory."""
    try:
        full_path = validate_path(path)

        # Don't allow creating directories directly
        if not path.endswith((".txt", ".md", ".json", ".py", ".yaml", ".yml")):
            return (
                f"Error: Cannot create {path}: Only text files are supported. "
                "Use file extensions: .txt, .md, .json, .py, .yaml, .yml"
            )

        # Create parent directories if needed
        full_path.parent.mkdir(parents=True, exist_ok=True)

        # Write the file
        full_path.write_text(file_text, encoding="utf-8")
        return f"File created successfully at {path}"

    except ValueError as e:
        return f"Error: {str(e)}"
    except Exception as e:
        return f"Error: Cannot create file {path}: {e}"


@app.tool()
def str_replace(
    path: Annotated[str, "Path to file (must start with /memories)"],
    old_str: Annotated[str, "Text to replace (must be unique in the file)"],
    new_str: Annotated[str, "Text to replace with"] = ""
) -> str:
    """Replace text in a file in the /memories directory."""
    try:
        full_path = validate_path(path)

        if not full_path.is_file():
            return f"Error: File not found: {path}"

        content = full_path.read_text(encoding="utf-8")

        # Check if old_str exists
        count = content.count(old_str)
        if count == 0:
            return f"Error: String not found in {path}. The exact text must exist in the file."
        elif count > 1:
            return (
                f"Error: String appears {count} times in {path}. "
                "The string must be unique. Use more specific context."
            )

        # Perform replacement
        new_content = content.replace(old_str, new_str, 1)
        full_path.write_text(new_content, encoding="utf-8")

        return f"File {path} has been edited successfully"

    except ValueError as e:
        return f"Error: {str(e)}"
    except Exception as e:
        return f"Error: Cannot edit file {path}: {e}"


@app.tool()
def insert(
    path: Annotated[str, "Path to file (must start with /memories)"],
    insert_line: Annotated[int, "Line number to insert at (0-indexed)"],
    insert_text: Annotated[str, "Text to insert"] = ""
) -> str:
    """Insert text at a specific line in a file in the /memories directory."""
    try:
        full_path = validate_path(path)

        if not full_path.is_file():
            return f"Error: File not found: {path}"

        lines = full_path.read_text(encoding="utf-8").splitlines()

        # Validate insert_line
        if insert_line < 0 or insert_line > len(lines):
            return (
                f"Error: Invalid insert_line {insert_line}. "
                f"Must be between 0 and {len(lines)}"
            )

        # Insert the text
        lines.insert(insert_line, insert_text.rstrip("\n"))

        # Write back
        full_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

        return f"Text inserted at line {insert_line} in {path}"

    except ValueError as e:
        return f"Error: {str(e)}"
    except Exception as e:
        return f"Error: Cannot insert into {path}: {e}"


@app.tool()
def delete(
    path: Annotated[str, "Path to delete (must start with /memories)"]
) -> str:
    """Delete a file or directory in the /memories directory."""
    try:
        # Prevent deletion of root memories directory
        if path == "/memories":
            return "Error: Cannot delete the /memories directory itself"

        full_path = validate_path(path)

        if not full_path.exists():
            return f"Error: Path not found: {path}"

        if full_path.is_file():
            full_path.unlink()
            return f"File deleted: {path}"
        elif full_path.is_dir():
            shutil.rmtree(full_path)
            return f"Directory deleted: {path}"

    except ValueError as e:
        return f"Error: {str(e)}"
    except Exception as e:
        return f"Error: Cannot delete {path}: {e}"


@app.tool()
def rename(
    old_path: Annotated[str, "Current path (must start with /memories)"],
    new_path: Annotated[str, "New path (must start with /memories)"]
) -> str:
    """Rename or move a file/directory in the /memories directory."""
    try:
        old_full_path = validate_path(old_path)
        new_full_path = validate_path(new_path)

        if not old_full_path.exists():
            return f"Error: Source path not found: {old_path}"

        if new_full_path.exists():
            return (
                f"Error: Destination already exists: {new_path}. "
                "Cannot overwrite existing files/directories."
            )

        # Create parent directories if needed
        new_full_path.parent.mkdir(parents=True, exist_ok=True)

        # Perform rename/move
        old_full_path.rename(new_full_path)

        return f"Renamed {old_path} to {new_path}"

    except ValueError as e:
        return f"Error: {str(e)}"
    except Exception as e:
        return f"Error: Cannot rename {old_path} to {new_path}: {e}"


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Memory Tool MCP Server")
    parser.add_argument(
        "--transport",
        choices=["stdio", "streamable-http"],
        default="stdio",
        help="Transport type (default: stdio)"
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host to bind to (for HTTP transport)"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8085,
        help="Port to bind to (for HTTP transport)"
    )
    parser.add_argument(
        "--base-path",
        default=DEFAULT_BASE_PATH,
        help="Base path for memory storage (default: ./memory_storage)"
    )
    parser.add_argument(
        "--log-level",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        default="INFO",
        help="Logging level"
    )

    args = parser.parse_args()

    # Set base path environment variable
    os.environ["MEMORY_TOOL_BASE_PATH"] = os.path.abspath(args.base_path)

    # Run the server
    if args.transport == "stdio":
        app.run(transport="stdio", show_banner=False)
    else:
        app.run(
            transport="streamable-http",
            host=args.host,
            port=args.port,
            log_level=args.log_level,
            show_banner=False
        )
