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

    Note to implementer:
        - Implement the parsing logic here
        - Use regular expressions or string parsing to extract test results
        - Create TestResult objects for each test found
    """
    results = []

    json_pattern = re.compile(r'({\s*"stats".*?"tests":\s*\[.*?\]\s*})', re.MULTILINE | re.DOTALL)
    
    for json_match in json_pattern.finditer(stdout_content):
        json_str = json_match.group(1)
        try:
            test_results = json.loads(json_str)
            
            for test in test_results.get('passes', []):
                file_path = test.get('file', '').replace('/app/', '')
                title = test.get('title', '')
                full_title = test.get('fullTitle', title)
                name = f"{file_path} | {full_title}"
                results.append(TestResult(name=name, status=TestStatus.PASSED))
            
            for test in test_results.get('pending', []):
                file_path = test.get('file', '').replace('/app/', '')
                title = test.get('title', '')
                full_title = test.get('fullTitle', title)
                name = f"{file_path} | {full_title}"
                results.append(TestResult(name=name, status=TestStatus.SKIPPED))
            
            for test in test_results.get('failures', []):
                file_path = test.get('file', '').replace('/app/', '')
                title = test.get('title', '')
                full_title = test.get('fullTitle', title)
                name = f"{file_path} | {full_title}"
                results.append(TestResult(name=name, status=TestStatus.FAILED))
                
        except json.JSONDecodeError:
            print("Failed to decode JSON from stdout content")
            continue

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

    main(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
