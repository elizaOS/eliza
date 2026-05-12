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

"""Env for code datasets."""

import json
import logging
import random
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Optional, SupportsFloat, Tuple

from datasets import Dataset, DatasetDict, load_dataset

from gem.core import Env
from gem.utils.constants import TERMINAL_STATE
from gem.utils.parsing import extract_code_from_model
from gem.utils.sandbox import run_python

logger = logging.getLogger(__name__)


class CodeEnv(Env):
    """Built upon a dataset, serving as a single-turn env (contextual bandits)."""

    def __init__(
        self,
        dataset_name: Optional[str] = "",
        split: Optional[str] = None,
        dataset: Optional[Dataset] = None,
        question_key: str = "problem",
        test_key: str = "tests",
        seed: int = 0,
        max_workers: int = 5,
        max_tests: int = 12,
        verbose: bool = False,
        sandbox_type: str = "none",
        **_,
    ):
        super().__init__()
        self.seed = seed
        self.question_key = question_key
        self.test_key = test_key

        if dataset is None:
            dataset = load_dataset(dataset_name)
            logger.info(f"Loaded: {dataset=}")
        if isinstance(dataset, DatasetDict):
            if split is not None:
                dataset = dataset[split]
            elif len(list(dataset.keys())) == 1:
                dataset = dataset[list(dataset.keys())[0]]
            else:
                raise ValueError(
                    f"Dataset {dataset_name} has multiple splits. "
                    f"Please specify a split: {list(dataset.keys())}"
                )
        assert isinstance(dataset, Dataset), f"Expected a Dataset, got {type(dataset)}"

        self.dataset_name = dataset_name
        self.dataset = dataset.shuffle(seed=self.seed)
        self.dataset_iter = iter(self.dataset)
        self.epoch = 0

        self.max_workers = max_workers
        self.thread_pool_executer = ThreadPoolExecutor(max_workers=max_workers)
        self.max_tests = max_tests
        self.verbose = verbose
        self.sandbox_type = sandbox_type

    def step(
        self, action: str
    ) -> Tuple[str, SupportsFloat, bool, bool, dict[str, Any]]:

        model_code = extract_code_from_model(action)
        if model_code is None:
            return TERMINAL_STATE, -0.1, True, True, {}
        else:
            is_correct = self._check_correct(model_code)
            reward = 1.0 if is_correct else 0.0
        return TERMINAL_STATE, reward, True, True, {}

    def reset(self, seed: Optional[None] = None) -> Tuple[str, dict[str, Any]]:
        """Sample a question from the dataset."""
        super().reset(seed)
        if seed is not None:
            data = random.choice(self.dataset)
        else:
            try:
                data = next(self.dataset_iter)
            except StopIteration:
                self.epoch += 1
                self.dataset = self.dataset.shuffle(seed=self.seed + self.epoch)
                self.dataset_iter = iter(self.dataset)
                data = next(self.dataset_iter)

        self.first_obs = data[self.question_key]
        self.tests = data[self.test_key]
        if isinstance(self.tests, str):
            self.tests = json.loads(self.tests)
        return self.first_obs, {}

    def _check_correct(self, model_code: str) -> bool:
        assert any(
            [
                x in self.dataset_name.lower()
                for x in ["taco", "apps", "codecontest", "primeintellect"]
            ]
        )
        tests = self.tests

        # format of tests: List[Dictionary] - Codeforces, LiveCodeBench
        # format of tests: Dictionary[Lists] - CodeContests, Taco/Apps
        if isinstance(tests, list):
            raise NotImplementedError
        else:
            total_tests = len(tests["inputs"])
            if total_tests > self.max_tests:
                # Select the tests with the longest input length.
                selected_indices = sorted(
                    range(total_tests),
                    key=lambda i: len(tests["inputs"][i]),
                    reverse=True,
                )[: self.max_tests]
                # Create a new dict with only the selected test cases
                selected_tests = {
                    "inputs": [tests["inputs"][i] for i in selected_indices],
                    "outputs": [tests["outputs"][i] for i in selected_indices],
                }
                tests = selected_tests

        def _parse_test(test):
            if isinstance(test, str):
                return test
            if isinstance(test, list):
                return "\n".join(map(str, test))

        code_and_tests = [
            (model_code, self.sandbox_type, _parse_test(test))
            for test in tests["inputs"]
        ]
        results = list(
            self.thread_pool_executer.map(
                lambda args: run_python(*args), code_and_tests
            )
        )

        try:
            successes, stdouts, stderrs = zip(*results)
        except ValueError as e:
            logging.info(code_and_tests)
            logging.info("-" * 20)
            logging.info(list(zip(*results)))
            raise e

        if not all(successes):
            return False
        for gt, pred in zip(tests["outputs"], stdouts):
            gt = _parse_test(gt)
            if gt.strip() != pred.strip():
                return False
        return True

    def get_state(self) -> dict[str, Any]:
        return {
            "first_obs": self.first_obs,
            "tests": self.tests,
        }

    def set_state(self, state: dict[str, Any]) -> None:
        self.first_obs = state["first_obs"]
        self.tests = state["tests"]
