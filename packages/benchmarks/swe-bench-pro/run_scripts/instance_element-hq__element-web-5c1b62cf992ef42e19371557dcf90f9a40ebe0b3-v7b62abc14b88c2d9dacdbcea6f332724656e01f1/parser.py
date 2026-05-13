"""
Test Results Parser

This script parses test execution outputs to extract structured test results.

Input:
    - stdout_file: Path to the file containing standard output from test execution
    - stderr_file: Path to the file containing standard error from test execution

Output:
    - JSON file containing parsed test results with structure:
      {
          "tests": [
              {
                  "name": "test_name",
                  "status": "PASSED|FAILED|SKIPPED|ERROR"
              },
              ...
          ]
      }
"""

import dataclasses
import json
import sys
from enum import Enum
from pathlib import Path
from typing import List
import re


class TestStatus(Enum):
    """The test status enum."""

    PASSED = 1
    FAILED = 2
    SKIPPED = 3
    ERROR = 4


@dataclasses.dataclass
class TestResult:
    """The test result dataclass."""

    name: str
    status: TestStatus



def parse_test_output(stdout_content: str, stderr_content: str) -> List[TestResult]:
    """
    Parse the test output content and extract test results.

    Args:
        stdout_content: Content of the stdout file
        stderr_content: Content of the stderr file

    Returns:
        List of TestResult objects
    """
    results = []
    
    jest_results = parse_jest_output(stdout_content)
    results.extend(jest_results)
    
    cypress_results = parse_cypress_output(stdout_content)
    results.extend(cypress_results)
    
    if not results:
        error_results = parse_error_output(stderr_content)
        results.extend(error_results)
    
    return results


def parse_jest_output(content: str) -> List[TestResult]:
    """Parse Jest test output format."""
    results = []
    current_file = None
    context_stack = []
    
    suite_pattern = re.compile(r'^(PASS|FAIL)\s+(.+?)(\s|$)')
    describe_pattern = re.compile(r'^(\s{2,})([^✓✖○\s].+?)$')
    test_pattern = re.compile(r'^\s*([✓✖○])\s+(.+?)(?:\s\((\d+)\s*ms\))?$')
    skipped_pattern = re.compile(r'^\s*○\s+(.+?)(?:\s\(skipped\))?$')
    
    current_indent_level = 0
    
    lines = content.splitlines()
    for line in lines:
        line = line.rstrip()
        
        suite_match = suite_pattern.match(line)
        if suite_match:
            status_text, suite_name = suite_match.group(1), suite_match.group(2).strip()
            context_stack = []
            current_indent_level = 0
            current_file = suite_name
            continue
        
        describe_match = describe_pattern.match(line)
        if describe_match and not test_pattern.search(line):
            indent, describe_name = describe_match.group(1), describe_match.group(2).strip()
            indent_level = len(indent) // 2
            
            if indent_level == 1:
                context_stack = [describe_name]
            elif indent_level > current_indent_level:
                context_stack.append(describe_name)
            else:
                context_stack = context_stack[:indent_level-1] + [describe_name]
            
            current_indent_level = indent_level
            continue
        
        test_match = test_pattern.search(line)
        if test_match and current_file:
            status_symbol, test_name = test_match.group(1), test_match.group(2).strip()
            
            if status_symbol == '✓':
                status = TestStatus.PASSED
            elif status_symbol == '✖':
                status = TestStatus.FAILED
            elif status_symbol == '○':
                status = TestStatus.SKIPPED
            else:
                status = TestStatus.ERROR
            
            full_name_parts = [current_file]
            if context_stack:
                full_name_parts.extend(context_stack)
            full_name_parts.append(test_name)
            full_name = " | ".join(full_name_parts)
            
            results.append(TestResult(name=full_name, status=status))
            continue
        
        skipped_match = skipped_pattern.search(line)
        if skipped_match and current_file:
            test_name = skipped_match.group(1).strip()
            
            full_name_parts = [current_file]
            if context_stack:
                full_name_parts.extend(context_stack)
            full_name_parts.append(test_name)
            full_name = " | ".join(full_name_parts)
            
            results.append(TestResult(name=full_name, status=TestStatus.SKIPPED))
    
    return results


def parse_cypress_output(content: str) -> List[TestResult]:
    """Parse Cypress test output format."""
    results = []
    
    running_pattern = re.compile(r'^\s*Running:\s+(.+)$')
    test_pattern = re.compile(r'^\s*([✓✖])\s+(.+?)(?:\s+\((\d+)ms\))?$')
    spec_pattern = re.compile(r'^\s*(.+\.spec\.[jt]s).*$')
    
    current_file = None
    
    for line in content.splitlines():
        line = line.strip()
        
        running_match = running_pattern.search(line)
        if running_match:
            current_file = running_match.group(1).strip()
            continue
        
        spec_match = spec_pattern.search(line)
        if spec_match and not current_file:
            current_file = spec_match.group(1).strip()
            continue
        
        test_match = test_pattern.search(line)
        if test_match and current_file:
            status_symbol, test_name = test_match.group(1), test_match.group(2).strip()
            
            if status_symbol == '✓':
                status = TestStatus.PASSED
            elif status_symbol == '✖':
                status = TestStatus.FAILED
            else:
                status = TestStatus.ERROR
            
            full_name = f"{current_file} | {test_name}"
            results.append(TestResult(name=full_name, status=status))
    
    return results


def parse_error_output(content: str) -> List[TestResult]:
    """Parse error messages from stderr."""
    results = []
    
    error_patterns = [
        r'Error:\s+(.+)',
        r'AssertionError:\s+(.+)',
        r'TypeError:\s+(.+)',
        r'ReferenceError:\s+(.+)',
        r'SyntaxError:\s+(.+)',
        r'Test suite failed to run:\s+(.+)'
    ]
    
    for pattern in error_patterns:
        for match in re.finditer(pattern, content, re.MULTILINE):
            error_msg = match.group(1).strip()
            if error_msg and len(error_msg) > 10:
                results.append(TestResult(name=f"Error | {error_msg[:100]}", status=TestStatus.ERROR))
    
    return results




def export_to_json(results: List[TestResult], output_path: Path) -> None:
    """
    Export the test results to a JSON file.

    Args:
        results: List of TestResult objects
        output_path: Path to the output JSON file
    """

    unique_results = {result.name: result for result in results}.values()

    json_results = {
        'tests': [
            {'name': result.name, 'status': result.status.name} for result in unique_results
        ]
    }

    with open(output_path, 'w') as f:
        json.dump(json_results, f, indent=2)


def main(stdout_path: Path, stderr_path: Path, output_path: Path) -> None:
    """
    Main function to orchestrate the parsing process.

    Args:
        stdout_path: Path to the stdout file
        stderr_path: Path to the stderr file
        output_path: Path to the output JSON file
    """
    with open(stdout_path) as f:
        stdout_content = f.read()
    with open(stderr_path) as f:
        stderr_content = f.read()

    results = parse_test_output(stdout_content, stderr_content)

    export_to_json(results, output_path)


if __name__ == '__main__':
    if len(sys.argv) != 4:
        print('Usage: python parsing.py <stdout_file> <stderr_file> <output_json>')
        sys.exit(1)

main(Path(sys.argv[1]), Path(sys.argv[2]))