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

"""Overlong Output Tool - Manage and navigate through long tool outputs.

This tool provides functionality to search, view, and navigate through
overlong tool outputs that are stored in files.
"""

import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Dict, List, Tuple, Any

import regex

from gem.tools.base_tool import BaseTool

# Configuration constants
OVERLONG_DIR_NAME = '.overlong_tool_outputs'
SEARCH_PAGE_SIZE = 10
VIEW_PAGE_SIZE = 10000
MAX_VIEW_PAGE_SIZE = 100000
CONTEXT_SIZE = 1000


class OverlongOutputTool(BaseTool):
    """Manage overlong tool outputs with search, view, and navigation capabilities.
    
    This tool provides:
    - Listing all overlong output files
    - Searching within files using regex
    - Viewing file content with pagination
    - Navigating through search/view results
    - Automatic cleanup of old files
    """
    
    tool_type = "overlong_output"

    def __init__(
        self,
        workspace_dir: str = ".",
        overlong_dir_name: str = OVERLONG_DIR_NAME,
        search_page_size: int = SEARCH_PAGE_SIZE,
        view_page_size: int = VIEW_PAGE_SIZE,
        context_size: int = CONTEXT_SIZE,
        num_workers: int = 1,
    ):
        """Initialize the Overlong Output Tool.
        
        Args:
            workspace_dir: Base workspace directory
            overlong_dir_name: Name of directory for overlong outputs
            search_page_size: Default page size for search results
            view_page_size: Default page size for viewing content
            context_size: Characters of context around search matches
            num_workers: Number of worker processes
        """
        super().__init__(num_workers)
        self.workspace_dir = os.path.abspath(workspace_dir)
        self.overlong_dir_name = overlong_dir_name
        self.search_page_size = search_page_size
        self.view_page_size = view_page_size
        self.context_size = context_size
        
        # Session storage for pagination
        self.search_sessions = {}
        self.view_sessions = {}

    def _get_overlong_dir(self) -> str:
        """Get the overlong outputs directory path."""
        return os.path.join(self.workspace_dir, self.overlong_dir_name)

    def _touch_file(self, file_path: str) -> None:
        """Touch a file to update its access time."""
        current_time = time.time()
        os.utime(file_path, (current_time, current_time))

    def _cleanup_old_files(self) -> List[str]:
        """Remove files older than 1 hour. Returns list of removed files."""
        overlong_dir = self._get_overlong_dir()
        if not os.path.exists(overlong_dir):
            return []
        
        current_time = time.time()
        one_hour_ago = current_time - 3600
        removed_files = []
        
        for filename in os.listdir(overlong_dir):
            if filename.endswith('.json'):
                file_path = os.path.join(overlong_dir, filename)
                try:
                    stat = os.stat(file_path)
                    if stat.st_atime < one_hour_ago:
                        os.remove(file_path)
                        removed_files.append(filename)
                except OSError:
                    continue
        
        return removed_files

    def _get_file_list(self) -> List[Dict[str, Any]]:
        """Get list of all overlong output files with metadata."""
        overlong_dir = self._get_overlong_dir()
        if not os.path.exists(overlong_dir):
            return []
        
        files = []
        current_time = time.time()
        
        for filename in os.listdir(overlong_dir):
            if filename.endswith('.json'):
                file_path = os.path.join(overlong_dir, filename)
                try:
                    stat = os.stat(file_path)
                    shortuuid = filename[:-5]
                    age_hours = (current_time - stat.st_atime) / 3600
                    size_mb = stat.st_size / (1024 * 1024)
                    
                    files.append({
                        'shortuuid': shortuuid,
                        'filename': filename,
                        'age_hours': round(age_hours, 2),
                        'size_mb': round(size_mb, 2),
                        'last_accessed': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(stat.st_atime))
                    })
                except OSError:
                    continue
        
        files.sort(key=lambda x: x['age_hours'])
        return files

    def _search_in_content(self, content: str, pattern: str, context_size: int) -> List[Dict[str, Any]]:
        """Search for regex pattern in content and return matches with context."""
        try:
            regex_pattern = re.compile(pattern, re.IGNORECASE | re.MULTILINE | re.DOTALL)
        except re.error as e:
            raise ValueError(f"Invalid regex pattern: {e}")
        
        matches = []
        for match in regex_pattern.finditer(content):
            start_pos = match.start()
            end_pos = match.end()
            
            context_start = max(0, start_pos - context_size // 2)
            context_end = min(len(content), end_pos + context_size // 2)
            
            before_context = content[context_start:start_pos]
            match_text = content[start_pos:end_pos]
            after_context = content[end_pos:context_end]
            
            line_num = content[:start_pos].count('\n') + 1
            
            matches.append({
                'match_text': match_text,
                'start_pos': start_pos,
                'end_pos': end_pos,
                'line_num': line_num,
                'before_context': before_context,
                'after_context': after_context,
            })
        
        return matches

    def _parse_action(self, action: str) -> Tuple[str, str, dict, bool]:
        """Parse action to extract operation and parameters.
        
        Supported operations:
        - list: List all overlong output files
        - search: Search within a file
        - view: View file content
        - search_navigate: Navigate through search results
        - view_navigate: Navigate through view results
        - cleanup: Clean up old files
        
        Args:
            action: Raw action string
        
        Returns:
            tuple: (operation, parsed_action, params, is_valid)
        """
        # Pattern for overlong operations
        pattern = r"<overlong_(\w+)>(.*?)</overlong_\1>"
        match = regex.search(pattern, action, regex.DOTALL)
        
        if not match:
            return "", "", {}, False
        
        operation = match.group(1)
        content = match.group(2).strip()
        parsed_action = match.group(0)
        
        # Parse parameters from content
        params = {}
        
        # Extract common parameters
        param_patterns = {
            'shortuuid': r"<shortuuid>(.*?)</shortuuid>",
            'pattern': r"<pattern>(.*?)</pattern>",
            'page_size': r"<page_size>(\d+)</page_size>",
            'context_size': r"<context_size>(\d+)</context_size>",
            'search_session_id': r"<search_session_id>(.*?)</search_session_id>",
            'view_session_id': r"<view_session_id>(.*?)</view_session_id>",
            'action': r"<action>(.*?)</action>",
            'target_page': r"<target_page>(\d+)</target_page>",
        }
        
        for param_name, param_pattern in param_patterns.items():
            param_match = regex.search(param_pattern, content)
            if param_match:
                value = param_match.group(1)
                if param_name in ['page_size', 'context_size', 'target_page']:
                    params[param_name] = int(value)
                else:
                    params[param_name] = value
        
        return operation, parsed_action, params, True

    def _execute_list(self, params: dict) -> str:
        """Execute list operation."""
        files = self._get_file_list()
        
        if not files:
            return "No overlong tool output files found."
        
        result = f"Found {len(files)} overlong tool output file(s):\n"
        result += "=" * 80 + "\n\n"
        
        for file_info in files:
            result += f"UUID: {file_info['shortuuid']}\n"
            result += f"  Size: {file_info['size_mb']:.2f} MB\n"
            result += f"  Age: {file_info['age_hours']:.2f} hours\n"
            result += f"  Last accessed: {file_info['last_accessed']}\n\n"
        
        return result

    def _execute_search(self, params: dict) -> str:
        """Execute search operation."""
        shortuuid = params.get('shortuuid', '').strip()
        pattern = params.get('pattern', '').strip()
        page_size = params.get('page_size', self.search_page_size)
        context_size = params.get('context_size', self.context_size)
        
        if not shortuuid:
            return "Error: shortuuid parameter is required"
        if not pattern:
            return "Error: pattern parameter is required"
        
        overlong_dir = self._get_overlong_dir()
        file_path = os.path.join(overlong_dir, f"{shortuuid}.json")
        
        if not os.path.exists(file_path):
            return f"Error: No overlong output found for shortuuid: {shortuuid}"
        
        try:
            self._touch_file(file_path)
            
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            matches = self._search_in_content(content, pattern, context_size)
            
            if not matches:
                return f"No matches found for pattern '{pattern}' in {shortuuid}\nFile size: {len(content)} characters"
            
            # Create search session
            search_session_id = str(uuid.uuid4())[:8]
            self.search_sessions[search_session_id] = {
                'shortuuid': shortuuid,
                'pattern': pattern,
                'matches': matches,
                'page_size': page_size,
                'context_size': context_size,
                'content_length': len(content),
                'current_page': 1,
            }
            
            # Return first page
            total_matches = len(matches)
            total_pages = (total_matches + page_size - 1) // page_size
            page_matches = matches[:page_size]
            
            result = f"Search Results in {shortuuid} (Page 1/{total_pages})\n"
            result += f"Pattern: '{pattern}' | Total matches: {total_matches}\n"
            result += f"Session ID: {search_session_id}\n"
            result += "=" * 80 + "\n\n"
            
            for i, match in enumerate(page_matches):
                result += f"Match {i+1} (Line ~{match['line_num']}, Pos {match['start_pos']}):\n"
                result += "-" * 60 + "\n"
                context_text = match['before_context'] + f">>>{match['match_text']}<<<" + match['after_context']
                result += context_text + "\n\n"
            
            result += f"Use session ID '{search_session_id}' for navigation"
            
            return result
            
        except ValueError as e:
            return f"Error: {str(e)}"
        except Exception as e:
            return f"Error: {str(e)}"

    def _execute_view(self, params: dict) -> str:
        """Execute view operation."""
        shortuuid = params.get('shortuuid', '').strip()
        page_size = params.get('page_size', self.view_page_size)
        
        if not shortuuid:
            return "Error: shortuuid parameter is required"
        
        overlong_dir = self._get_overlong_dir()
        file_path = os.path.join(overlong_dir, f"{shortuuid}.json")
        
        if not os.path.exists(file_path):
            return f"Error: No overlong output found for shortuuid: {shortuuid}"
        
        try:
            self._touch_file(file_path)
            
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            total_length = len(content)
            total_pages = (total_length + page_size - 1) // page_size
            
            # Create view session
            view_session_id = str(uuid.uuid4())[:8]
            self.view_sessions[view_session_id] = {
                'shortuuid': shortuuid,
                'content_length': total_length,
                'page_size': page_size,
                'current_page': 1,
            }
            
            # Get first page
            end_pos = min(page_size, total_length)
            excerpt = content[:end_pos]
            
            result = f"Viewing {shortuuid} (Page 1/{total_pages})\n"
            result += f"Characters 0-{end_pos} of {total_length}\n"
            result += f"Session ID: {view_session_id}\n"
            result += "=" * 80 + "\n\n"
            result += excerpt
            
            if end_pos < total_length:
                result += f"\n\n[Page 1/{total_pages}]\n"
                result += f"Use session ID '{view_session_id}' for navigation"
            
            return result
            
        except Exception as e:
            return f"Error: {str(e)}"

    def _execute_cleanup(self, params: dict) -> str:
        """Execute cleanup operation."""
        removed = self._cleanup_old_files()
        
        if not removed:
            return "No old files to clean up (files older than 1 hour)"
        
        result = f"Cleaned up {len(removed)} old file(s):\n"
        for filename in removed:
            result += f"  - {filename}\n"
        
        return result

    def instruction_string(self) -> str:
        """Return instruction string for using the overlong output tool."""
        return (
            "You have access to manage overlong tool outputs stored in files.\n\n"
            "Available operations:\n\n"
            "1. List all files:\n"
            "<overlong_list></overlong_list>\n\n"
            "2. Search within a file:\n"
            "<overlong_search>\n"
            "<shortuuid>file_uuid</shortuuid>\n"
            "<pattern>regex_pattern</pattern>\n"
            "<page_size>10</page_size>  <!-- Optional -->\n"
            "<context_size>1000</context_size>  <!-- Optional -->\n"
            "</overlong_search>\n\n"
            "3. View file content:\n"
            "<overlong_view>\n"
            "<shortuuid>file_uuid</shortuuid>\n"
            "<page_size>10000</page_size>  <!-- Optional -->\n"
            "</overlong_view>\n\n"
            "4. Clean up old files:\n"
            "<overlong_cleanup></overlong_cleanup>\n\n"
            "Navigation is handled automatically through session IDs."
        )

    def execute_action(self, action: str) -> Tuple[bool, bool, str, str]:
        """Execute the parsed action.
        
        Args:
            action: Raw action string
        
        Returns:
            tuple: (is_valid, has_error, observation, parsed_action)
        """
        operation, parsed_action, params, is_valid = self._parse_action(action)
        
        if not is_valid:
            return False, True, "", ""
        
        # Execute operation
        if operation == 'list':
            result = self._execute_list(params)
        elif operation == 'search':
            result = self._execute_search(params)
        elif operation == 'view':
            result = self._execute_view(params)
        elif operation == 'cleanup':
            result = self._execute_cleanup(params)
        else:
            result = f"Error: Unknown operation '{operation}'"
        
        has_error = result.startswith("Error:")
        observation = f"\n{result}\n"
        
        return True, has_error, observation, parsed_action
