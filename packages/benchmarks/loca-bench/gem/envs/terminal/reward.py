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

import logging
from typing import Dict

from terminal_bench.handlers.trial_handler import TrialHandler
from terminal_bench.parsers.base_parser import UnitTestStatus
from terminal_bench.terminal.terminal import Terminal


async def calculate_test_score(
    terminal: Terminal,
    trial_handler: TrialHandler,
    task_name: str,
    test_weights: Dict[str, float],
    max_test_timeout_sec: float,
    rollout_id: str,
) -> float:
    """
    Run tests in the container and calculate the test-based score.

    Args:
        terminal: Terminal instance for the container
        trial_handler: Trial handler with parser and paths
        task_name: Name of the task
        test_weights: Test name to weight mapping
        max_test_timeout_sec: Maximum timeout for tests
        rollout_id: Unique identifier for this rollout

    Returns:
        Test score between 0.0 and 1.0
    """
    try:
        # Create a new session for running tests
        test_session = terminal.create_session("tests")

        # Copy test files to container
        terminal.copy_to_container(
            paths=[
                trial_handler.trial_paths.post_agent_pane_path,
                trial_handler.task_paths.run_tests_path,
                trial_handler.task_paths.test_dir,
            ],
            container_dir="/tests",
        )

        # Execute tests
        test_script_path = f"/tests/{trial_handler.task_paths.run_tests_path.name}"
        try:
            test_session.send_keys(
                ["bash ", test_script_path, "Enter"],
                block=True,
                max_timeout_sec=max_test_timeout_sec,
            )
        except TimeoutError:
            logging.warning(
                f"Test timeout for task '{task_name}' (rollout {rollout_id})"
            )
            return 0.0

        # Capture test output
        test_output = test_session.capture_pane(capture_entire=True)

        # Parse test results
        try:
            results = trial_handler.parser.parse(test_output)
        except Exception as e:
            logging.error(f"Parse error for {task_name}: {e}")
            return 0.0

        # Calculate weighted score
        return _calculate_weighted_test_score(results, test_weights, task_name)

    except Exception as e:
        logging.error(f"Error in calculate_test_score: {e}", exc_info=True)
        return 0.0


def _calculate_weighted_test_score(
    results: Dict[str, UnitTestStatus], test_weights: Dict[str, float], task_name: str
) -> float:
    """
    Calculate weighted score from test results.

    Args:
        results: Test name to status mapping
        test_weights: Test name to weight mapping
        task_name: Name of the task for logging

    Returns:
        Weighted score between 0.0 and 1.0
    """
    if not results:
        return 0.0

    # If no test weights provided, use equal weights
    if not test_weights:
        logging.warning(f"No test weights for task {task_name}, using equal weights")
        equal_weight = 1.0 / len(results)
        total_score = sum(
            equal_weight if status == UnitTestStatus.PASSED else 0.0
            for status in results.values()
        )
        return total_score

    # Calculate weighted score
    total_score = 0.0
    total_weight = 0.0

    for test_name, status in results.items():
        weight = test_weights.get(test_name, 0.0)
        if weight > 0:
            score = 1.0 if status == UnitTestStatus.PASSED else 0.0
            total_score += score * weight
            total_weight += weight

    # Normalize if weights don't sum to 1.0
    if total_weight > 0:
        return total_score / total_weight

    # Fallback to equal weights if no matching weights found
    logging.warning(
        f"No matching test weights found for {task_name}, using equal weights"
    )
    equal_weight = 1.0 / len(results)
    return sum(
        equal_weight if status == UnitTestStatus.PASSED else 0.0
        for status in results.values()
    )
