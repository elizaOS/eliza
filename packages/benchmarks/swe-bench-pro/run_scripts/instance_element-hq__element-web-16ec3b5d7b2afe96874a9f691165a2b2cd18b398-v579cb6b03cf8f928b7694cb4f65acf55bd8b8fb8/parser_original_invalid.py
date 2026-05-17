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
import re
from enum import Enum
from pathlib import Path
from typing import List


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
    
    try:
        combined_content = stdout_content + "\n" + stderr_content
        lines = combined_content.split('\n')
        
        current_test_file = None
        
        # Parse Jest verbose output - extract individual test results
        for line in lines:
            pass_file_match = re.search(r'PASS\s+(test/[^\s]+)', line)
            fail_file_match = re.search(r'FAIL\s+(test/[^\s]+)', line)
            
            if pass_file_match:
                current_test_file = pass_file_match.group(1)
                continue
            elif fail_file_match:
                current_test_file = fail_file_match.group(1)
                continue
            
            if current_test_file:
                test_match = re.search(r'^\s*[✓×]\s+(.+?)\s*\(\d+\s*ms\)', line.strip())
                if test_match:
                    test_name = f"{current_test_file} | {test_match.group(1).strip()}"
                    status = TestStatus.PASSED if '✓' in line else TestStatus.FAILED
                    results.append(TestResult(name=test_name, status=status))
                    continue
                
                # Alternative pattern for test results
                test_match2 = re.search(r'^\s*✓\s+(.+)', line.strip())
                if test_match2:
                    test_name = f"{current_test_file} | {test_match2.group(1).strip()}"
                    results.append(TestResult(name=test_name, status=TestStatus.PASSED))
                    continue
                
                fail_match = re.search(r'^\s*●\s+(.+)', line.strip())
                if fail_match:
                    test_name = f"{current_test_file} | {fail_match.group(1).strip()}"
                    results.append(TestResult(name=test_name, status=TestStatus.FAILED))
                    continue
        
        if not results:
            summary_match = re.search(r'Tests:\s*(\d+)\s*failed,\s*(\d+)\s*skipped,\s*(\d+)\s*todo,\s*(\d+)\s*passed,\s*(\d+)\s*total', combined_content)
            
            if summary_match:
                failed_count = int(summary_match.group(1))
                skipped_count = int(summary_match.group(2))
                todo_count = int(summary_match.group(3))
                passed_count = int(summary_match.group(4))
                total_count = int(summary_match.group(5))
                
                for i in range(passed_count):
                    results.append(TestResult(name=f"test_case_passed_{i+1}", status=TestStatus.PASSED))
                for i in range(failed_count):
                    results.append(TestResult(name=f"test_case_failed_{i+1}", status=TestStatus.FAILED))
                for i in range(skipped_count):
                    results.append(TestResult(name=f"test_case_skipped_{i+1}", status=TestStatus.SKIPPED))
                for i in range(todo_count):
                    results.append(TestResult(name=f"test_case_todo_{i+1}", status=TestStatus.SKIPPED))
    
    except Exception as e:
        results.append(TestResult(name=f"parsing_error: {str(e)}", status=TestStatus.ERROR))
    
    if not results:
        results.append(TestResult(name="no_tests_found", status=TestStatus.ERROR))
    
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

    main(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.a