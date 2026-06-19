#!/usr/bin/env python3
"""Example usage of PDF Tools MCP server for PDF manipulation."""

import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))

from gem.tools.mcp_server.pdf_tools import create_pdf_tools_tool


def main():
    """Demonstrate PDF Tools server capabilities with a real-world scenario."""
    print("=" * 70)
    print("PDF Tools MCP Server - PDF Manipulation Example")
    print("=" * 70)
    print("\nScenario: Managing PDF documents with various operations\n")
    
    # Create tool with workspace path
    workspace_path = str(Path.cwd())
    
    try:
        tool = create_pdf_tools_tool(
            workspace_path=workspace_path,
            validate_on_init=True
        )
        print("✓ PDF Tools initialized\n")
    except Exception as e:
        print(f"✗ Failed to initialize PDF Tools: {e}")
        print("\nMake sure pdf-tools-mcp is installed:")
        print("  uv tool install pdf-tools-mcp")
        print("Or it will auto-install via uvx on first use")
        return 1
    
    # Get available tools
    print("Available tools:")
    print("-" * 70)
    tools = tool.get_available_tools()
    for t in tools:
        desc = t['description'][:80]
        print(f"  - {t['name']}: {desc}{'...' if len(t['description']) > 80 else ''}")
    print()
    
    # Step 1: Get PDF information
    print("Step 1: Getting information about a PDF file...")
    print("-" * 70)
    
    # Note: Adjust the tool name and parameters based on actual pdf-tools-mcp API
    # This is a generic example that may need modification
    get_info = '''
<tool_call>
<tool_name>get_pdf_info</tool_name>
<arguments>
{
  "file_path": "./sample.pdf"
}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, obs, _ = tool.execute_action(get_info)
        if is_valid and not has_error:
            print("✓ Successfully retrieved PDF information")
            print(obs)
        else:
            print(f"⚠ Operation result: {obs}")
    except Exception as e:
        print(f"⚠ Note: {e}")
        print("  Actual tool names may differ. See:")
        print("  https://github.com/lockon-n/pdf-tools-mcp")
    
    # Step 2: Extract text from PDF
    print("\nStep 2: Extracting text from PDF...")
    print("-" * 70)
    
    extract_text = '''
<tool_call>
<tool_name>extract_text</tool_name>
<arguments>
{
  "file_path": "./sample.pdf"
}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, obs, _ = tool.execute_action(extract_text)
        if is_valid and not has_error:
            print("✓ Successfully extracted text from PDF")
            # Truncate output if too long
            text = str(obs)
            print(text[:500] + ("..." if len(text) > 500 else ""))
        else:
            print(f"⚠ Operation result: {obs}")
    except Exception as e:
        print(f"⚠ Note: {e}")
    
    # Step 3: Extract specific pages
    print("\nStep 3: Extracting specific pages from PDF...")
    print("-" * 70)
    
    extract_pages = '''
<tool_call>
<tool_name>extract_pages</tool_name>
<arguments>
{
  "input_file": "./sample.pdf",
  "output_file": "./extracted_pages.pdf",
  "pages": [1, 2, 3]
}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, obs, _ = tool.execute_action(extract_pages)
        if is_valid and not has_error:
            print("✓ Successfully extracted pages")
            print(obs)
        else:
            print(f"⚠ Operation result: {obs}")
    except Exception as e:
        print(f"⚠ Note: {e}")
    
    # Step 4: Merge multiple PDFs
    print("\nStep 4: Merging multiple PDF files...")
    print("-" * 70)
    
    merge_pdfs = '''
<tool_call>
<tool_name>merge_pdfs</tool_name>
<arguments>
{
  "input_files": [
    "./document1.pdf",
    "./document2.pdf",
    "./document3.pdf"
  ],
  "output_file": "./merged_document.pdf"
}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, obs, _ = tool.execute_action(merge_pdfs)
        if is_valid and not has_error:
            print("✓ Successfully merged PDF files")
            print(obs)
        else:
            print(f"⚠ Operation result: {obs}")
    except Exception as e:
        print(f"⚠ Note: {e}")
    
    # Step 5: Split PDF
    print("\nStep 5: Splitting PDF into separate files...")
    print("-" * 70)
    
    split_pdf = '''
<tool_call>
<tool_name>split_pdf</tool_name>
<arguments>
{
  "file_path": "./large_document.pdf",
  "output_dir": "./split_output",
  "pages_per_file": 5
}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, obs, _ = tool.execute_action(split_pdf)
        if is_valid and not has_error:
            print("✓ Successfully split PDF")
            print(obs)
        else:
            print(f"⚠ Operation result: {obs}")
    except Exception as e:
        print(f"⚠ Note: {e}")
    
    # Step 6: Convert PDF pages to images
    print("\nStep 6: Converting PDF pages to images...")
    print("-" * 70)
    
    convert_to_images = '''
<tool_call>
<tool_name>convert_to_images</tool_name>
<arguments>
{
  "file_path": "./sample.pdf",
  "output_dir": "./images",
  "format": "png",
  "dpi": 150
}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, obs, _ = tool.execute_action(convert_to_images)
        if is_valid and not has_error:
            print("✓ Successfully converted PDF to images")
            print(obs)
        else:
            print(f"⚠ Operation result: {obs}")
    except Exception as e:
        print(f"⚠ Note: {e}")
    
    # Step 7: Rotate pages
    print("\nStep 7: Rotating PDF pages...")
    print("-" * 70)
    
    rotate_pages = '''
<tool_call>
<tool_name>rotate_pages</tool_name>
<arguments>
{
  "input_file": "./sample.pdf",
  "output_file": "./rotated.pdf",
  "pages": [1, 3, 5],
  "rotation": 90
}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, obs, _ = tool.execute_action(rotate_pages)
        if is_valid and not has_error:
            print("✓ Successfully rotated pages")
            print(obs)
        else:
            print(f"⚠ Operation result: {obs}")
    except Exception as e:
        print(f"⚠ Note: {e}")
    
    print("\n" + "=" * 70)
    print("Example Complete")
    print("=" * 70)
    print("\nNote: This example uses generic tool names.")
    print("Actual tool names and parameters may differ.")
    print("Refer to the official documentation:")
    print("https://github.com/lockon-n/pdf-tools-mcp")
    
    # Display instruction string
    print("\n" + "=" * 70)
    print("Instruction String for Agents")
    print("=" * 70)
    print("\nThis is the instruction string that would be provided to agents:")
    print("-" * 70)
    instruction = tool.instruction_string()
    print(instruction[:1000] + ("...\n[truncated]" if len(instruction) > 1000 else ""))
    
    # Cleanup
    tool.close()
    print("\n✓ Tool closed successfully")
    
    return 0


if __name__ == "__main__":
    sys.exit(main())















