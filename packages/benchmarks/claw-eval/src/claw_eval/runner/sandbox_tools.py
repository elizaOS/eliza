"""Sandbox tool definitions aligned with Claude Code tool names."""

from __future__ import annotations

from ..models.tool import ToolSpec

# ---------------------------------------------------------------------------
# Tool specifications (aligned with Claude Code tool definitions)
# ---------------------------------------------------------------------------

_BASH = ToolSpec(
    name="Bash",
    description=(
        "Executes a given bash command and returns its output. "
        "The working directory persists between commands. "
        "Use this for system commands and terminal operations."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "The command to execute.",
            },
            "description": {
                "type": "string",
                "description": "Clear, concise description of what this command does.",
            },
            "timeout": {
                "type": "integer",
                "description": "Optional timeout in milliseconds (max 600000).",
            },
            "run_in_background": {
                "type": "boolean",
                "description": "Set to true to run this command in the background.",
            },
        },
        "required": ["command"],
    },
)

_READ = ToolSpec(
    name="Read",
    description=(
        "Reads a file from the filesystem. Can read text files, images, and PDFs. "
        "For images, returns base64-encoded frames for visual inspection. "
        "For PDFs, use the pages parameter to render specific pages as images."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "file_path": {
                "type": "string",
                "description": "The absolute path to the file to read.",
            },
            "offset": {
                "type": "integer",
                "description": "The line number to start reading from (1-based).",
            },
            "limit": {
                "type": "integer",
                "description": "The number of lines to read.",
            },
            "pages": {
                "type": "string",
                "description": "Page range for PDF files (e.g., '1-5', '3', '1,3,5').",
            },
        },
        "required": ["file_path"],
    },
)

_WRITE = ToolSpec(
    name="Write",
    description=(
        "Writes a file to the filesystem. "
        "Creates parent directories if needed. "
        "Overwrites the existing file if there is one at the provided path."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "file_path": {
                "type": "string",
                "description": "The absolute path to the file to write.",
            },
            "content": {
                "type": "string",
                "description": "The content to write to the file.",
            },
        },
        "required": ["file_path", "content"],
    },
)

_EDIT = ToolSpec(
    name="Edit",
    description=(
        "Performs exact string replacements in files. "
        "The edit will fail if old_string is not found or is not unique "
        "(unless replace_all is set)."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "file_path": {
                "type": "string",
                "description": "The absolute path to the file to modify.",
            },
            "old_string": {
                "type": "string",
                "description": "The text to replace.",
            },
            "new_string": {
                "type": "string",
                "description": "The text to replace it with.",
            },
            "replace_all": {
                "type": "boolean",
                "description": "Replace all occurrences of old_string (default false).",
                "default": False,
            },
        },
        "required": ["file_path", "old_string", "new_string"],
    },
)

_GLOB = ToolSpec(
    name="Glob",
    description=(
        "Fast file pattern matching tool. "
        "Supports glob patterns like '**/*.js' or 'src/**/*.ts'. "
        "Returns matching file paths."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "The glob pattern to match files against.",
            },
            "path": {
                "type": "string",
                "description": "The directory to search in. Defaults to /workspace.",
            },
        },
        "required": ["pattern"],
    },
)

_GREP = ToolSpec(
    name="Grep",
    description=(
        "Search tool for finding patterns in file contents. "
        "Supports regex syntax. "
        "Returns matching lines or file paths."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "The regex pattern to search for.",
            },
            "path": {
                "type": "string",
                "description": "File or directory to search in. Defaults to /workspace.",
            },
            "glob": {
                "type": "string",
                "description": "Glob pattern to filter files (e.g. '*.js', '*.py').",
            },
            "output_mode": {
                "type": "string",
                "description": "Output mode: 'content', 'files_with_matches', or 'count'. Default: 'files_with_matches'.",
                "enum": ["content", "files_with_matches", "count"],
            },
            "case_insensitive": {
                "type": "boolean",
                "description": "Case insensitive search.",
            },
            "context_lines": {
                "type": "integer",
                "description": "Number of context lines before and after each match.",
            },
            "after_context": {
                "type": "integer",
                "description": "Number of lines to show after each match.",
            },
            "before_context": {
                "type": "integer",
                "description": "Number of lines to show before each match.",
            },
            "head_limit": {
                "type": "integer",
                "description": "Limit output to first N entries.",
            },
            "multiline": {
                "type": "boolean",
                "description": "Enable multiline mode where patterns can span lines.",
            },
        },
        "required": ["pattern"],
    },
)

_BROWSER_SCREENSHOT = ToolSpec(
    name="BrowserScreenshot",
    description=(
        "Capture screenshots of a web page over time. "
        "Opens the URL in a headless browser, then takes multiple screenshots "
        "at regular intervals to show animation progress. "
        "Use this to preview and verify your generated web pages and animations."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "The URL to navigate to and capture.",
            },
            "wait_seconds": {
                "type": "number",
                "description": "Total observation time in seconds (default: 2.0).",
                "default": 2.0,
            },
            "frame_count": {
                "type": "integer",
                "description": "Number of screenshots to capture (default: 4).",
                "default": 4,
            },
        },
        "required": ["url"],
    },
)

_READ_MEDIA = ToolSpec(
    name="ReadMedia",
    description=(
        "Read and preview a video file. "
        "Extracts frames at specified intervals. "
        "Returns metadata and base64-encoded frame images."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Path to the video file.",
            },
            "media_type": {
                "type": "string",
                "description": "Type of media: 'auto', 'image', 'video', or 'pdf'. Default: auto-detect.",
                "default": "auto",
            },
            "max_frames": {
                "type": "integer",
                "description": "Maximum number of frames to extract (default: 8).",
                "default": 8,
            },
            "fps": {
                "type": "number",
                "description": "Frames per second to extract (default: 1.0).",
                "default": 1.0,
            },
            "start_time": {
                "type": "number",
                "description": "Start time in seconds (default: 0.0).",
                "default": 0.0,
            },
            "end_time": {
                "type": "number",
                "description": "End time in seconds. None means end of video.",
            },
            "screen_size": {
                "type": "string",
                "description": "Resize output dimension, e.g. '1280x720'.",
            },
        },
        "required": ["path"],
    },
)

_DOWNLOAD = ToolSpec(
    name="Download",
    description="Download a file as binary (base64-encoded). Use for retrieving generated files (mp4, gif, html, etc.).",
    input_schema={
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Path to the file to download.",
            },
            "max_bytes": {
                "type": "integer",
                "description": "Maximum file size in bytes (default: 50MB).",
                "default": 50000000,
            },
        },
        "required": ["path"],
    },
)

# Full list of all sandbox tools
SANDBOX_TOOLS: list[ToolSpec] = [
    _BASH,
    _READ,
    _WRITE,
    _EDIT,
    _GLOB,
    _GREP,
    _BROWSER_SCREENSHOT,
    _READ_MEDIA,
    _DOWNLOAD,
]

SANDBOX_TOOL_NAMES: frozenset[str] = frozenset(t.name for t in SANDBOX_TOOLS)


def get_sandbox_tools(
    *,
    enable_shell: bool = True,
    enable_browser: bool = True,
    enable_file: bool = True,
    enable_media: bool = True,
) -> list[ToolSpec]:
    """Return a filtered list of sandbox tools based on capability flags."""
    tools: list[ToolSpec] = []
    if enable_shell:
        tools.append(_BASH)
    if enable_file:
        tools.append(_READ)
        tools.append(_WRITE)
        tools.append(_EDIT)
        tools.append(_GLOB)
        tools.append(_GREP)
    if enable_browser:
        tools.append(_BROWSER_SCREENSHOT)
    if enable_media:
        tools.append(_READ_MEDIA)
        tools.append(_DOWNLOAD)
    return tools
