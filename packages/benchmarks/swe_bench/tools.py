"""Code navigation tools for SWE-bench agent."""

from __future__ import annotations

import logging
from dataclasses import asdict

from elizaos.types.components import (
    Action,
    ActionParameter,
    ActionParameterSchema,
    ActionResult,
    HandlerCallback,
    HandlerOptions,
)
from elizaos.types.memory import Memory
from elizaos.types.runtime import IAgentRuntime
from elizaos.types.state import State

from .repo_manager import RepositoryManager

logger = logging.getLogger(__name__)

# Service key for repository manager
REPO_MANAGER_KEY = "swe_bench_repo_manager"


async def _get_repo_manager(runtime: IAgentRuntime) -> RepositoryManager | None:
    """Get repository manager from runtime."""
    service = runtime.get_service(REPO_MANAGER_KEY)
    if service is None:
        logger.error("Repository manager not found in runtime")
        return None
    # The service wrapper stores the actual manager
    manager = getattr(service, "manager", None)
    if not isinstance(manager, RepositoryManager):
        logger.error("Repository manager service does not have a manager attribute")
        return None
    return manager


# --- SEARCH_CODE Action ---


async def search_code_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    options: HandlerOptions | None,
    callback: HandlerCallback | None,
    responses: list[Memory] | None,
) -> ActionResult | None:
    """Search for code patterns in the repository."""
    params = options.parameters if options else None
    if not params:
        return ActionResult(success=False, error="No parameters provided")

    query = params.get("query")
    file_pattern = params.get("file_pattern", "*.py")

    if not query:
        return ActionResult(success=False, error="Query parameter required")

    repo_manager = await _get_repo_manager(runtime)
    if not repo_manager:
        return ActionResult(success=False, error="Repository manager not available")

    results = await repo_manager.search_code(str(query), str(file_pattern))

    return ActionResult(
        success=True,
        data={
            "matches": [asdict(r) for r in results[:20]],
            "total_matches": len(results),
        },
    )


async def search_code_validate(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
) -> bool:
    """Validate search_code action can run."""
    return await _get_repo_manager(runtime) is not None


search_code_action = Action(
    name="SEARCH_CODE",
    description="Search for code patterns or text in the repository. Use this to find relevant code locations, function definitions, class usages, etc.",
    handler=search_code_handler,
    validate=search_code_validate,
    parameters=[
        ActionParameter(
            name="query",
            description="The text or pattern to search for (e.g., function name, error message, class name)",
            required=True,
            schema=ActionParameterSchema(type="string"),
        ),
        ActionParameter(
            name="file_pattern",
            description="File pattern to search (default: *.py)",
            required=False,
            schema=ActionParameterSchema(type="string", description="default: *.py"),
        ),
    ],
)


# --- READ_FILE Action ---


async def read_file_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    options: HandlerOptions | None,
    callback: object | None,
    responses: list[Memory] | None,
) -> ActionResult | None:
    """Read a file or specific lines from the repository."""
    params = options.parameters if options else None
    if not params:
        return ActionResult(success=False, error="No parameters provided")

    file_path = params.get("file_path")
    if not file_path:
        return ActionResult(success=False, error="file_path parameter required")

    repo_manager = await _get_repo_manager(runtime)
    if not repo_manager:
        return ActionResult(success=False, error="Repository manager not available")

    content = await repo_manager.read_file(str(file_path))
    if content is None:
        return ActionResult(success=False, error=f"File not found: {file_path}")

    # Handle line range if specified
    start_line = params.get("start_line")
    end_line = params.get("end_line")

    if start_line is not None or end_line is not None:
        if start_line is None or end_line is None:
            return ActionResult(
                success=False,
                error="Both start_line and end_line must be provided together",
            )
        start_i = int(start_line)
        end_i = int(end_line)
        if start_i < 1:
            return ActionResult(success=False, error="start_line must be >= 1")
        if end_i < start_i:
            return ActionResult(success=False, error="end_line must be >= start_line")

        lines = content.split("\n")
        start_idx = start_i - 1
        end_idx = min(len(lines), end_i)
        selected_lines = lines[start_idx:end_idx]

        # Add line numbers
        numbered = [f"{i + start_idx + 1:4d} | {line}" for i, line in enumerate(selected_lines)]
        content = "\n".join(numbered)

    return ActionResult(
        success=True,
        data={
            "content": content,
            "file_path": file_path,
            "line_count": len(content.split("\n")),
        },
    )


async def read_file_validate(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
) -> bool:
    """Validate read_file action can run."""
    return await _get_repo_manager(runtime) is not None


read_file_action = Action(
    name="READ_FILE",
    description="Read the contents of a file in the repository. Can read specific line ranges for large files.",
    handler=read_file_handler,
    validate=read_file_validate,
    parameters=[
        ActionParameter(
            name="file_path",
            description="Path to the file relative to repository root (e.g., src/module.py)",
            required=True,
            schema=ActionParameterSchema(type="string"),
        ),
        ActionParameter(
            name="start_line",
            description="Starting line number (1-indexed, optional)",
            required=False,
            schema=ActionParameterSchema(type="number"),
        ),
        ActionParameter(
            name="end_line",
            description="Ending line number (1-indexed, optional)",
            required=False,
            schema=ActionParameterSchema(type="number"),
        ),
    ],
)


# --- EDIT_FILE Action ---


async def edit_file_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    options: HandlerOptions | None,
    callback: HandlerCallback | None,
    responses: list[Memory] | None,
) -> ActionResult | None:
    """Edit a file by replacing specific content."""
    params = options.parameters if options else None
    if not params:
        return ActionResult(success=False, error="No parameters provided")

    file_path = params.get("file_path")
    old_content = params.get("old_content")
    new_content = params.get("new_content")

    if not all([file_path, old_content is not None, new_content is not None]):
        return ActionResult(
            success=False,
            error="file_path, old_content, and new_content parameters required",
        )

    repo_manager = await _get_repo_manager(runtime)
    if not repo_manager:
        return ActionResult(success=False, error="Repository manager not available")

    current_content = await repo_manager.read_file(str(file_path))
    if current_content is None:
        return ActionResult(success=False, error=f"File not found: {file_path}")

    old_str = str(old_content)
    new_str = str(new_content)

    if old_str not in current_content:
        return ActionResult(
            success=False,
            error=f"Old content not found in file. Make sure it matches exactly.",
            data={"file_path": file_path},
        )

    # Replace only the first occurrence
    updated_content = current_content.replace(old_str, new_str, 1)

    success = await repo_manager.write_file(str(file_path), updated_content)
    if not success:
        return ActionResult(success=False, error="Failed to write file")

    return ActionResult(
        success=True,
        data={
            "message": f"Successfully edited {file_path}",
            "file_path": file_path,
        },
    )


async def edit_file_validate(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
) -> bool:
    """Validate edit_file action can run."""
    return await _get_repo_manager(runtime) is not None


edit_file_action = Action(
    name="EDIT_FILE",
    description="Edit a file by replacing specific content. Provide the exact old content to replace and the new content.",
    handler=edit_file_handler,
    validate=edit_file_validate,
    parameters=[
        ActionParameter(
            name="file_path",
            description="Path to the file to edit",
            required=True,
            schema=ActionParameterSchema(type="string"),
        ),
        ActionParameter(
            name="old_content",
            description="The exact content to replace (must match exactly)",
            required=True,
            schema=ActionParameterSchema(type="string"),
        ),
        ActionParameter(
            name="new_content",
            description="The new content to insert",
            required=True,
            schema=ActionParameterSchema(type="string"),
        ),
    ],
)


# --- LIST_FILES Action ---


async def list_files_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    options: HandlerOptions | None,
    callback: object | None,
    responses: list[Memory] | None,
) -> ActionResult | None:
    """List files in the repository."""
    params = options.parameters if options else None
    directory = params.get("directory", ".") if params else "."
    pattern = params.get("pattern", "*") if params else "*"

    repo_manager = await _get_repo_manager(runtime)
    if not repo_manager:
        return ActionResult(success=False, error="Repository manager not available")

    if pattern == "*.py" or pattern == "python":
        files = await repo_manager.get_python_files()
    else:
        files = await repo_manager.get_file_tree()

    # Filter by directory if specified
    if directory and directory != ".":
        dir_str = str(directory)
        files = [f for f in files if f.startswith(dir_str)]

    return ActionResult(
        success=True,
        data={
            "files": files[:100],  # Limit to 100 files
            "total_count": len(files),
        },
    )


async def list_files_validate(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
) -> bool:
    """Validate list_files action can run."""
    return await _get_repo_manager(runtime) is not None


list_files_action = Action(
    name="LIST_FILES",
    description="List files in the repository, optionally filtering by directory or file type.",
    handler=list_files_handler,
    validate=list_files_validate,
    parameters=[
        ActionParameter(
            name="directory",
            description="Directory to list files from (default: repository root)",
            required=False,
            schema=ActionParameterSchema(type="string", description="default: ."),
        ),
        ActionParameter(
            name="pattern",
            description="File pattern to filter by (e.g., '*.py' for Python files)",
            required=False,
            schema=ActionParameterSchema(type="string", description="default: *"),
        ),
    ],
)


# --- SUBMIT Action ---


async def submit_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    options: HandlerOptions | None,
    callback: HandlerCallback | None,
    responses: list[Memory] | None,
) -> ActionResult | None:
    """Submit the current changes as the final solution."""
    repo_manager = await _get_repo_manager(runtime)
    if not repo_manager:
        return ActionResult(success=False, error="Repository manager not available")

    # Generate the patch from current changes
    patch = await repo_manager.get_diff()

    return ActionResult(
        success=True,
        data={
            "patch": patch,
            "submitted": True,
            "has_changes": bool(patch.strip()),
        },
    )


async def submit_validate(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
) -> bool:
    """Validate submit action can run."""
    return await _get_repo_manager(runtime) is not None


submit_action = Action(
    name="SUBMIT",
    description="Submit your solution. This generates a patch from all changes made and signals completion.",
    handler=submit_handler,
    validate=submit_validate,
    parameters=[],
)


# Export all actions
SWE_BENCH_ACTIONS = [
    search_code_action,
    read_file_action,
    edit_file_action,
    list_files_action,
    submit_action,
]
