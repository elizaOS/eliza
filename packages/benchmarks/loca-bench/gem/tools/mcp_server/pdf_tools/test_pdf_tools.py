#!/usr/bin/env python3
"""Test script for PDF Tools MCP server integration."""

import sys
import tempfile
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))

from gem.tools.mcp_server.pdf_tools import create_pdf_tools_tool


def test_basic_connection():
    """Test basic connection and tool discovery."""
    print("=" * 60)
    print("Testing PDF Tools MCP Server Connection")
    print("=" * 60)
    
    try:
        # Create tool with temporary workspace
        workspace = tempfile.mkdtemp()
        tool = create_pdf_tools_tool(
            workspace_path=workspace,
            validate_on_init=True
        )
        
        print("✓ Successfully created PDF Tools")
        print(f"  Workspace: {workspace}")
        
        # Get available tools
        tools = tool.get_available_tools()
        print(f"\n✓ Found {len(tools)} available tools:")
        for t in tools:
            print(f"  - {t['name']}: {t['description']}")
        
        return tool
        
    except Exception as e:
        print(f"\n✗ Failed to create PDF Tools: {e}")
        import traceback
        traceback.print_exc()
        return None


def test_pdf_info(tool, test_file):
    """Test getting PDF information."""
    print("\n" + "=" * 60)
    print("Testing PDF Information Retrieval")
    print("=" * 60)
    
    # This is a generic test - actual tool name and parameters may vary
    # Adjust based on actual pdf-tools-mcp tool specifications
    action = f'''
<tool_call>
<tool_name>get_pdf_info</tool_name>
<arguments>
{{
  "file_path": "{test_file}"
}}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, observation, parsed = tool.execute_action(action)
        
        if is_valid and not has_error:
            print("✓ Successfully retrieved PDF information")
            print(f"Result: {observation}")
        else:
            print(f"✗ Failed to get PDF info: {observation}")
        
        return is_valid and not has_error
    except Exception as e:
        print(f"✗ Exception during info test: {e}")
        return False


def test_extract_text(tool, test_file):
    """Test extracting text from PDF."""
    print("\n" + "=" * 60)
    print("Testing PDF Text Extraction")
    print("=" * 60)
    
    # This is a generic test - actual tool name and parameters may vary
    action = f'''
<tool_call>
<tool_name>extract_text</tool_name>
<arguments>
{{
  "file_path": "{test_file}"
}}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, observation, parsed = tool.execute_action(action)
        
        if is_valid and not has_error:
            print("✓ Successfully extracted text from PDF")
            # Truncate long output
            obs_str = str(observation)
            print(f"Result (first 500 chars): {obs_str[:500]}")
            if len(obs_str) > 500:
                print("  ...")
        else:
            print(f"✗ Failed to extract text: {observation}")
        
        return is_valid and not has_error
    except Exception as e:
        print(f"✗ Exception during text extraction test: {e}")
        return False


def test_merge_pdfs(tool, test_files, output_file):
    """Test merging multiple PDFs."""
    print("\n" + "=" * 60)
    print("Testing PDF Merging")
    print("=" * 60)
    
    # This is a generic test - actual tool name and parameters may vary
    files_json = ', '.join([f'"{f}"' for f in test_files])
    action = f'''
<tool_call>
<tool_name>merge_pdfs</tool_name>
<arguments>
{{
  "input_files": [{files_json}],
  "output_file": "{output_file}"
}}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, observation, parsed = tool.execute_action(action)
        
        if is_valid and not has_error:
            print("✓ Successfully merged PDF files")
            print(f"Result: {observation}")
        else:
            print(f"✗ Failed to merge PDFs: {observation}")
        
        return is_valid and not has_error
    except Exception as e:
        print(f"✗ Exception during merge test: {e}")
        return False


def test_instruction_string(tool):
    """Test instruction string generation."""
    print("\n" + "=" * 60)
    print("Testing Instruction String")
    print("=" * 60)
    
    instruction = tool.instruction_string()
    
    print("\nGenerated instruction string (first 1000 chars):")
    print("-" * 60)
    print(instruction[:1000])
    if len(instruction) > 1000:
        print("...")
    print("-" * 60)
    
    return True


def main():
    """Run all tests."""
    print("\n" + "=" * 60)
    print("PDF Tools MCP Server Test Suite")
    print("=" * 60)
    print("\nNote: This will use 'uvx pdf-tools-mcp'")
    print("The tool will be auto-installed via uvx if not already installed.\n")
    
    # Test connection
    tool = test_basic_connection()
    if not tool:
        print("\n✗ Connection test failed. Exiting.")
        print("\nMake sure pdf-tools-mcp can be installed:")
        print("  uv tool install pdf-tools-mcp")
        print("Or it will auto-install via uvx on first use")
        return 1
    
    # Test instruction string
    test_instruction_string(tool)
    
    # Create temporary test files for testing
    with tempfile.TemporaryDirectory() as tmpdir:
        test_pdf = Path(tmpdir) / "test.pdf"
        merged_pdf = Path(tmpdir) / "merged.pdf"
        
        # Note: These tests require actual PDF files
        print("\n⚠ Note: Actual tool names and parameters may vary.")
        print("  Adjust tests based on pdf-tools-mcp documentation.")
        print("  See: https://github.com/lockon-n/pdf-tools-mcp")
        print("\n⚠ To test with real PDFs, create sample PDF files first.")
        
        # Optional: Test operations if you have sample PDF files
        # if test_pdf.exists():
        #     test_pdf_info(tool, str(test_pdf))
        #     test_extract_text(tool, str(test_pdf))
        # 
        # if len(list(Path(tmpdir).glob("*.pdf"))) > 1:
        #     test_files = [str(f) for f in Path(tmpdir).glob("*.pdf")]
        #     test_merge_pdfs(tool, test_files, str(merged_pdf))
    
    print("\n" + "=" * 60)
    print("Test Suite Complete")
    print("=" * 60)
    
    # Cleanup
    tool.close()
    print("\n✓ Tool closed successfully")
    
    return 0


if __name__ == "__main__":
    sys.exit(main())















