# PDF Tools MCP Server

Comprehensive PDF file manipulation system for reading, extracting text, merging, splitting, and other PDF operations.

## Overview

This module provides easy access to the `pdf-tools-mcp` MCP server, which implements comprehensive PDF file manipulation capabilities including:

- Reading and extracting text from PDF files
- Getting PDF metadata and information
- Merging multiple PDF files
- Splitting PDF files
- Converting PDF pages to images
- Extracting pages from PDFs
- Rotating and manipulating PDF pages

The PDF Tools server communicates through stdio transport, making it easy to use without any manual server setup.

## Prerequisites

- Python with `uv` package manager
- `pdf-tools-mcp` package available via uvx

### Installation

```bash
# Install via uv tool (recommended)
uv tool install pdf-tools-mcp

# Or use uvx (auto-installs on first use)
uvx pdf-tools-mcp --help
```

## Usage

### Method 1: Using the Helper Function (Recommended)

```python
from gem.tools.mcp_server.pdf_tools import create_pdf_tools_tool

# Create tool with default settings
tool = create_pdf_tools_tool(workspace_path="/path/to/workspace")

# Or with custom configuration
tool = create_pdf_tools_tool(
    workspace_path="/path/to/workspace",
    tempfile_dir="/path/to/temp",
    validate_on_init=False,
    client_session_timeout_seconds=120
)

# Get available tools
tools = tool.get_available_tools()
for t in tools:
    print(f"{t['name']}: {t['description']}")

# Use in your application
instruction = tool.instruction_string()
print(instruction)
```

### Method 2: Using MCPTool Directly

```python
from gem.tools.mcp_tool import MCPTool

# Create configuration
config = {
    "mcpServers": {
        "pdf-tools": {
            "command": "uvx",
            "args": [
                "pdf-tools-mcp",
                "--workspace_path",
                "/path/to/workspace",
                "--tempfile_dir",
                "/path/to/workspace/.pdf_tools_tempfiles"
            ]
        }
    }
}

# Create tool
tool = MCPTool(config, validate_on_init=False)
```

### Method 3: From Config File

```python
from gem.tools.mcp_server.pdf_tools import create_pdf_tools_tool_from_config

# Uses the default config.json in this directory
tool = create_pdf_tools_tool_from_config()

# Or specify a custom config file
tool = create_pdf_tools_tool_from_config(
    config_path="/path/to/custom_config.json"
)
```

## Available Tools

The PDF Tools server provides a comprehensive set of tools for PDF manipulation. The exact tools and their parameters depend on the pdf-tools-mcp implementation.

Common operations include:

### Text Extraction
- **extract_text**: Extract text content from PDF files
- **extract_text_from_page**: Extract text from specific pages
- **search_text**: Search for text within PDFs

### PDF Information
- **get_pdf_info**: Get metadata and information about PDF files
- **get_page_count**: Get the number of pages in a PDF
- **get_page_size**: Get dimensions of specific pages

### PDF Manipulation
- **merge_pdfs**: Combine multiple PDF files into one
- **split_pdf**: Split a PDF file into multiple parts
- **extract_pages**: Extract specific pages from a PDF
- **rotate_pages**: Rotate pages in a PDF
- **delete_pages**: Remove pages from a PDF

### Conversion
- **convert_to_images**: Convert PDF pages to images
- **pdf_to_text_file**: Export PDF content to text file

For detailed tool documentation, see:
- [PDF Tools MCP Repository](https://github.com/lockon-n/pdf-tools-mcp)

## Example: Complete Workflow

```python
from gem.tools.mcp_server.pdf_tools import create_pdf_tools_tool

# Initialize the tool
tool = create_pdf_tools_tool(
    workspace_path="/path/to/workspace",
    validate_on_init=False
)

# Example action: Extract text from PDF
action1 = '''
<tool_call>
<tool_name>extract_text</tool_name>
<arguments>
{
  "file_path": "/path/to/workspace/document.pdf"
}
</arguments>
</tool_call>
'''

is_valid, has_error, observation, parsed = tool.execute_action(action1)
print(f"Extracted text: {observation}")

# Example action: Get PDF information
action2 = '''
<tool_call>
<tool_name>get_pdf_info</tool_name>
<arguments>
{
  "file_path": "/path/to/workspace/document.pdf"
}
</arguments>
</tool_call>
'''

is_valid, has_error, observation, parsed = tool.execute_action(action2)
print(f"PDF info: {observation}")

# Example action: Merge multiple PDFs
action3 = '''
<tool_call>
<tool_name>merge_pdfs</tool_name>
<arguments>
{
  "input_files": [
    "/path/to/workspace/doc1.pdf",
    "/path/to/workspace/doc2.pdf",
    "/path/to/workspace/doc3.pdf"
  ],
  "output_file": "/path/to/workspace/merged.pdf"
}
</arguments>
</tool_call>
'''

is_valid, has_error, observation, parsed = tool.execute_action(action3)
print(f"Merge result: {observation}")

# Example action: Split PDF
action4 = '''
<tool_call>
<tool_name>split_pdf</tool_name>
<arguments>
{
  "file_path": "/path/to/workspace/document.pdf",
  "output_dir": "/path/to/workspace/split_output",
  "pages_per_file": 5
}
</arguments>
</tool_call>
'''

is_valid, has_error, observation, parsed = tool.execute_action(action4)
print(f"Split result: {observation}")
```

## Configuration

Default configuration (`config.json`):

```json
{
  "mcpServers": {
    "pdf-tools": {
      "command": "uvx",
      "args": [
        "pdf-tools-mcp",
        "--workspace_path",
        ".",
        "--tempfile_dir",
        "./.pdf_tools_tempfiles"
      ]
    }
  }
}
```

### Configuration Parameters

- **workspace_path**: Directory where PDF operations are permitted. Defaults to current directory.
- **tempfile_dir**: Directory for temporary files created during PDF operations. Defaults to `workspace_path/.pdf_tools_tempfiles`.

## Integration with GEM

The PDF Tools can be used with GEM environments:

```python
import gem
from gem.tools.mcp_server.pdf_tools import create_pdf_tools_tool
from gem.tools.tool_env_wrapper import ToolEnvWrapper

# Create environment
env = gem.make("your-env-id")

# Create PDF Tools
pdf_tool = create_pdf_tools_tool(
    workspace_path="/path/to/workspace",
    validate_on_init=False
)

# Wrap environment with tool
wrapped_env = ToolEnvWrapper(env, tools=[pdf_tool])

# Use the environment
obs, info = wrapped_env.reset()
```

## Multi-Server Configuration

You can combine the PDF Tools with other MCP servers:

```python
from gem.tools.mcp_server.pdf_tools import get_pdf_tools_stdio_config
from gem.tools.mcp_server.excel import get_excel_stdio_config
from gem.tools.mcp_tool import MCPTool

# Get individual configs
pdf_config = get_pdf_tools_stdio_config(workspace_path="/path/to/workspace")
excel_config = get_excel_stdio_config()

# Merge configs
merged_config = {
    "mcpServers": {
        **pdf_config,
        **excel_config
    }
}

# Create combined tool
tool = MCPTool(merged_config, validate_on_init=False)

# Now you have both PDF and Excel tools available
tools = tool.get_available_tools()
```

## Troubleshooting

### "uv: command not found"
Make sure `uv` is installed:
```bash
# Install uv (if not already installed)
pip install uv
```

### "pdf-tools-mcp not found"
Install the PDF Tools MCP package:
```bash
uv tool install pdf-tools-mcp

# Or test with uvx (auto-installs)
uvx pdf-tools-mcp --help
```

### File Permission Errors
Make sure the workspace directory and PDF files are accessible:
```bash
chmod 755 /path/to/workspace
chmod 644 /path/to/workspace/*.pdf
```

### Timeout Issues
If operations are timing out (especially for large PDFs), increase the timeout:
```python
tool = create_pdf_tools_tool(
    workspace_path="/path/to/workspace",
    client_session_timeout_seconds=120,
    execution_timeout=60.0
)
```

### Temporary Files
The PDF Tools server creates temporary files during operations. By default, they are stored in `workspace_path/.pdf_tools_tempfiles`. You can customize this location:

```python
tool = create_pdf_tools_tool(
    workspace_path="/path/to/workspace",
    tempfile_dir="/custom/temp/directory"
)
```

Remember to clean up temporary files periodically:
```bash
rm -rf /path/to/workspace/.pdf_tools_tempfiles/*
```

## Testing

Create a simple test script to verify the installation:

```python
from gem.tools.mcp_server.pdf_tools import create_pdf_tools_tool

# Initialize the tool
tool = create_pdf_tools_tool(
    workspace_path=".",
    validate_on_init=True  # Enable validation to check connection
)

# Display available tools
print("Available PDF Tools:")
tools = tool.get_available_tools()
for t in tools:
    print(f"- {t['name']}: {t['description']}")

# Display instruction string
print("\nInstruction String:")
print(tool.instruction_string())
```

## References

- [PDF Tools MCP Repository](https://github.com/lockon-n/pdf-tools-mcp)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [GEM Framework Documentation](https://github.com/axon-rl/gem)

## Notes

- The exact tool names and parameters depend on the pdf-tools-mcp implementation
- Refer to the [official documentation](https://github.com/lockon-n/pdf-tools-mcp) for the most up-to-date tool specifications
- This module uses stdio transport for communication, which auto-starts the server as a subprocess
- The server timeout can be configured via `client_session_timeout_seconds` parameter
- Temporary files are created during PDF operations in the specified tempfile directory
- Large PDF files may require longer timeouts and more memory















