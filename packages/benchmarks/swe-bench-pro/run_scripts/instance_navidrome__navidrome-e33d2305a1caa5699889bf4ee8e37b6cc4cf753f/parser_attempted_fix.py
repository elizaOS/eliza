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
import re
import sys
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
    """
    results = []
    test_results = {}
    
    run_pattern = re.compile(r"=== RUN\s+(\S+)")
    pass_pattern = re.compile(r"--- PASS:\s+(\S+)")
    fail_pattern = re.compile(r"--- FAIL:\s+(\S+)")
    skip_pattern = re.compile(r"--- SKIP:\s+(\S+)")
    
    ginkgo_run_pattern = re.compile(r"Running Suite: (.+)")
    ginkgo_test_pattern = re.compile(r"• (Failure|Success)! \[([\d\.]+) seconds\]")
    ginkgo_desc_pattern = re.compile(r"(•|\[It\])\s+(.+)$")
    
    lines = stdout_content.split('\n')
    current_test = None
    current_ginkgo_suite = None
    current_ginkgo_test = None
    
    for line in lines:
        run_match = run_pattern.search(line)
        if run_match:
            current_test = run_match.group(1)
            test_results[current_test] = TestStatus.ERROR
            continue
            
        pass_match = pass_pattern.search(line)
        if pass_match:
            test_name = pass_match.group(1)
            test_results[test_name] = TestStatus.PASSED
            continue
            
        fail_match = fail_pattern.search(line)
        if fail_match:
            test_name = fail_match.group(1)
            test_results[test_name] = TestStatus.FAILED
            continue
            
        skip_match = skip_pattern.search(line)
        if skip_match:
            test_name = skip_match.group(1)
            test_results[test_name] = TestStatus.SKIPPED
            continue
        
        ginkgo_run_match = ginkgo_run_pattern.search(line)
        if ginkgo_run_match:
            current_ginkgo_suite = ginkgo_run_match.group(1)
            continue
            
        ginkgo_test_match = ginkgo_test_pattern.search(line)
        if ginkgo_test_match:
            status = ginkgo_test_match.group(1)
            if current_ginkgo_test:
                test_name = f"{current_ginkgo_suite}.{current_ginkgo_test}"
                test_results[test_name] = TestStatus.PASSED if status == "Success" else TestStatus.FAILED
            continue
            
        ginkgo_desc_match = ginkgo_desc_pattern.search(line)
        if ginkgo_desc_match:
            current_ginkgo_test = ginkgo_desc_match.group(2).strip()
            continue
    
    if stderr_content:
        for line in stderr_content.split('\n'):
            if "panic:" in line or "build failed" in line:
                for test_name, status in test_results.items():
                    if status == TestStatus.ERROR:
                        test_results[test_name] = TestStatus.FAILED
    
    for test_name, status in test_results.items():
        results.append(TestResult(name=test_name, status=status))
    
    return results




def export_to_json(results: List[TestResult], output_path: Path) -> None:
    """
    Export the test results to a JSON file.

    Args:
        results: List of TestResult objects
        output_path: Path to the output JSON file
    """
    json_results = {
        'tests': [
            {'name': result.name, 'status': result.status.name} for result in results
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

main(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))th(sys.argv[3)