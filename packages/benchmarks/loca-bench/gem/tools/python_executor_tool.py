# Copyright 2025 AxonRL Team. All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Python Executor Tool - Execute Python code using uv run in a workspace.

This tool executes Python code in a dedicated workspace using uv run,
providing isolated execution with proper timeout and error handling.
"""

import json
import os
import subprocess
import time
import uuid
from pathlib import Path
from typing import Tuple

import regex as re

from gem.tools.base_tool import BaseTool


class PythonExecutorTool(BaseTool):
    """Execute Python code using uv run in a workspace directory.
    
    This tool is different from PythonCodeTool in that it:
    - Uses uv run for execution (supports dependencies)
    - Saves code to temporary files
    - Provides detailed execution information (time, return code)
    - Supports configurable timeout
    """
    
    tool_type = "python_executor"

    def __init__(
        self,
        workspace_dir: str = ".",
        tmp_dir_name: str = ".python_tmp",
        default_timeout: int = 30,
        max_timeout: int = 120,
        num_workers: int = 1,
    ):
        """Initialize the Python Executor Tool.
        
        Args:
            workspace_dir: Base workspace directory for execution
            tmp_dir_name: Name of temporary directory for Python files
            default_timeout: Default execution timeout in seconds
            max_timeout: Maximum allowed timeout in seconds
            num_workers: Number of worker processes
        """
        super().__init__(num_workers)
        self.workspace_dir = os.path.abspath(workspace_dir)
        self.tmp_dir_name = tmp_dir_name
        self.default_timeout = default_timeout
        self.max_timeout = max_timeout

    def _parse_action(self, action: str) -> Tuple[str, str, dict, bool]:
        """Parse action to extract Python code and execution parameters.
        
        Expected format:
        <python_execute>
        <code>
        # Python code here
        </code>
        <filename>optional_filename.py</filename>
        <timeout>30</timeout>
        </python_execute>
        
        Args:
            action: Raw action string from agent
        
        Returns:
            tuple: (code, parsed_action, params_dict, is_valid)
        """
        # Pattern for full format with optional parameters
        pattern = r"<python_execute>(.*?)</python_execute>"
        match = re.search(pattern, action, re.DOTALL)
        
        if not match:
            return "", "", {}, False
        
        content = match.group(1)
        parsed_action = match.group(0)
        
        # Extract code
        code_pattern = r"<code>(.*?)</code>"
        code_match = re.search(code_pattern, content, re.DOTALL)
        if not code_match:
            return "", parsed_action, {}, False
        
        code = code_match.group(1).strip()
        
        # Extract optional parameters
        params = {}
        
        # Extract filename
        filename_pattern = r"<filename>(.*?)</filename>"
        filename_match = re.search(filename_pattern, content)
        if filename_match:
            params['filename'] = filename_match.group(1).strip()
        
        # Extract timeout
        timeout_pattern = r"<timeout>(\d+)</timeout>"
        timeout_match = re.search(timeout_pattern, content)
        if timeout_match:
            params['timeout'] = int(timeout_match.group(1))
        
        return code, parsed_action, params, True

    def _execute_python(
        self,
        code: str,
        filename: str = None,
        timeout: int = None
    ) -> str:
        """Execute Python code using uv run.
        
        Args:
            code: Python code to execute
            filename: Optional filename (auto-generated if not provided)
            timeout: Execution timeout in seconds
        
        Returns:
            Formatted execution result string
        """
        # Set defaults
        if filename is None:
            filename = f"{uuid.uuid4()}.py"
        if not filename.endswith(".py"):
            filename += ".py"
        
        if timeout is None:
            timeout = self.default_timeout
        timeout = min(timeout, self.max_timeout)
        
        # Create temporary directory
        tmp_dir = Path(self.workspace_dir) / self.tmp_dir_name
        tmp_dir.mkdir(parents=True, exist_ok=True)
        
        # Write Python file
        file_path = tmp_dir / filename
        try:
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(code)
        except Exception as e:
            return f"=== ERROR ===\nFailed to write Python file: {e}"
        
        # Execute with uv run
        cmd = f"uv run --directory {self.workspace_dir} ./{self.tmp_dir_name}/{filename}"
        
        start_time = time.time()
        
        try:
            result = subprocess.run(
                cmd,
                shell=True,
                capture_output=True,
                text=True,
                encoding='utf-8',
                timeout=timeout
            )
            execution_time = time.time() - start_time
            
            # Build output
            output_parts = []
            
            # Add stdout
            if result.stdout:
                output_parts.append("=== STDOUT ===")
                output_parts.append(result.stdout.rstrip())
            
            # Add stderr
            if result.stderr:
                output_parts.append("=== STDERR ===")
                output_parts.append(result.stderr.rstrip())
            
            # Add execution info
            output_parts.append("=== EXECUTION INFO ===")
            output_parts.append(f"Return code: {result.returncode}")
            output_parts.append(f"Execution time: {execution_time:.3f} seconds")
            output_parts.append(f"Timeout limit: {timeout} seconds")
            
            # If no output
            if not result.stdout and not result.stderr:
                output_parts.insert(0, "No console output produced.")
            
            return "\n".join(output_parts)
            
        except subprocess.TimeoutExpired:
            execution_time = time.time() - start_time
            return (
                f"=== EXECUTION TIMEOUT ===\n"
                f"Execution timed out after {timeout} seconds\n"
                f"Execution time: {execution_time:.3f} seconds"
            )
        except Exception as e:
            return f"=== ERROR ===\nExecution failed: {e}"

    def instruction_string(self) -> str:
        """Return instruction string for using the Python executor tool."""
        return (
            "You have access to a Python code executor that runs code in an isolated workspace.\n\n"
            "To execute Python code, use the following format:\n"
            "<python_execute>\n"
            "<code>\n"
            "# Your Python code here\n"
            "print('Hello, World!')\n"
            "</code>\n"
            "<filename>optional_name.py</filename>  <!-- Optional: specify filename -->\n"
            "<timeout>30</timeout>  <!-- Optional: execution timeout in seconds (max 120) -->\n"
            "</python_execute>\n\n"
            f"Default timeout: {self.default_timeout} seconds\n"
            f"Maximum timeout: {self.max_timeout} seconds\n\n"
            "The executor will return:\n"
            "- Standard output (stdout)\n"
            "- Standard error (stderr)\n"
            "- Return code\n"
            "- Execution time"
        )

    def execute_action(self, action: str) -> Tuple[bool, bool, str, str]:
        """Execute the parsed action.
        
        Args:
            action: Raw action string
        
        Returns:
            tuple: (is_valid, has_error, observation, parsed_action)
        """
        code, parsed_action, params, is_valid = self._parse_action(action)
        
        if not is_valid:
            return False, True, "", ""
        
        # Execute Python code
        result = self._execute_python(
            code,
            filename=params.get('filename'),
            timeout=params.get('timeout')
        )
        
        # Check for errors
        has_error = (
            "=== ERROR ===" in result or
            "=== EXECUTION TIMEOUT ===" in result or
            "Return code: " in result and "Return code: 0" not in result
        )
        
        observation = f"\n{result}\n"
        
        return True, has_error, observation, parsed_action
