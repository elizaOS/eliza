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

"""Env for math datasets."""

import functools
import logging
import multiprocessing
import random
import warnings
from typing import Any, Optional, SupportsFloat, Tuple

from datasets import Dataset, DatasetDict, load_dataset

from gem.core import Env
from gem.utils.constants import TERMINAL_STATE
from gem.utils.math_grader import (
    boxed_reward_fn,
    extract_answer,
    run_with_timeout_signal,
)

logger = logging.getLogger(__name__)
verify_fn = functools.partial(
    boxed_reward_fn,
    fast=False,
    correct_reward=1,
    incorrect_reward=0,
)
FORMAT_ERROR_REWARD = -0.1


class MathEnv(Env):
    """Built upon a dataset, serving as a single-turn env (contextual bandits)."""

    def __init__(
        self,
        dataset_name: Optional[str] = "",
        split: Optional[str] = None,
        dataset: Optional[Dataset] = None,
        question_key: str = "problem",
        answer_key: str = "answer",
        use_format_error_reward: bool = False,
        seed: int = 0,
        use_mp: bool = True,
        **kwargs: Any,
    ):
        super().__init__()
        self.seed = seed
        self.question_key = question_key
        self.answer_key = answer_key
        self.use_format_error_reward = use_format_error_reward
        self.use_mp = use_mp
        if dataset is None:
            dataset = load_dataset(dataset_name)
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
        self.dataset = dataset
        eval = kwargs.get("eval", False)
        if not eval:
            self.dataset = dataset.shuffle(seed=self.seed)
        self.idx = 0
        self.epoch = 0
        if self.use_mp:
            # Process pool is used to enable the timeout mechanism for answer grading in a potential distributed training setup
            self.mp_pool = multiprocessing.Pool(1)

    def _mp_step(
        self, action: str
    ) -> Tuple[str, SupportsFloat, bool, bool, dict[str, Any]]:
        if self.use_format_error_reward:
            extracted_answer = extract_answer(action)
            if extracted_answer is None:
                return TERMINAL_STATE, FORMAT_ERROR_REWARD, True, True, {}
        res = self.mp_pool.apply_async(self.check_correct, (action, self.answer))
        try:
            is_correct = res.get(timeout=1)
        except multiprocessing.context.TimeoutError:
            is_correct = False
        reward = 1.0 if is_correct else 0
        return TERMINAL_STATE, reward, True, True, {"correct": is_correct}

    def _local_step(
        self, action: str
    ) -> Tuple[str, SupportsFloat, bool, bool, dict[str, Any]]:
        if self.use_format_error_reward:
            extracted_answer = extract_answer(action)
            if extracted_answer is None:
                return TERMINAL_STATE, FORMAT_ERROR_REWARD, True, True, {}
        res = run_with_timeout_signal(
            self.check_correct, args=(action, self.answer), timeout_seconds=1
        )
        is_correct = False
        if res is None:
            is_correct = False
        else:
            is_correct = res
        reward = 1.0 if is_correct else 0
        return TERMINAL_STATE, reward, True, True, {"correct": is_correct}

    def step(
        self, action: str
    ) -> Tuple[str, SupportsFloat, bool, bool, dict[str, Any]]:
        if self.use_mp:
            return self._mp_step(action)
        return self._local_step(action)

    def reset(
        self, seed: Optional[None] = None, idx: Optional[int] = None
    ) -> Tuple[str, dict[str, Any]]:
        """Sample a question from the dataset."""
        super().reset(seed)
        if idx is not None:
            assert 0 <= idx < len(self.dataset)
            self.idx = idx
        elif seed is not None:
            self.idx = random.randint(0, len(self.dataset) - 1)
        else:
            if self.idx == len(self.dataset):
                self.epoch += 1
                self.dataset = self.dataset.shuffle(seed=self.seed + self.epoch)
                self.idx = 0

        data = self.dataset[self.idx]
        self.first_obs = data[self.question_key]
        self.answer = data[self.answer_key]
        self.idx += 1
        return self.first_obs, {}

    @staticmethod
    def check_correct(model_answer: str, gt_answer: str) -> bool:
        """Check if the action is correct."""
        # get correct answers from the dataset entry
        if isinstance(gt_answer, (str, float, int)):
            correct_answers = [str(gt_answer)]
        elif isinstance(gt_answer, list):
            correct_answers = gt_answer
        else:
            raise ValueError(f"Unexpected answer type: {type(gt_answer)}")

        # check against all possible correct answers
        is_correct = False
        for correct_answer in correct_answers:
            _, is_correct = verify_fn(model_answer, correct_answer)
            if is_correct:
                break
        return is_correct

    def sample_random_action(self) -> str:
        """Sample a random action."""
        return "\\boxed{42}"

    def close(self):
        self.mp_pool.close()

    def get_state(self) -> dict[str, Any]:
        return {
            "first_obs": self.first_obs,
            "answer": self.answer,
        }

    def set_state(self, state: dict[str, Any]) -> None:
        self.first_obs = state["first_obs"]
        self.answer = state["answer"]

    def spawn(self, same_state: bool = False, **kwargs) -> Env:
        if same_state:
            child = MathEnv(
                dataset=self.dataset,
                question_key=self.question_key,
                answer_key=self.answer_key,
                seed=self.seed,
                use_mp=self.use_mp,
                **kwargs,
            )
            child.set_state(self.get_state())
        else:
            child = MathEnv(
                dataset=self.dataset,
                question_key=self.question_key,
                answer_key=self.answer_key,
                use_mp=self.use_mp,
                **kwargs,
            )
            if child.seed == self.seed:
                warnings.warn(
                    "same_state is False but the seed is not changed, which may lead to the same sequence of questions."
                )
        return child


if __name__ == "__main__":
    ans1 = "\\boxed{${1,2,3,4}$}"
    ans2 = "${1,3} \\cup {2,4}$"
    ans3 = "1,2,3,4"
    ans4 = "none"
    ans7 = str({1, 2, 3, 4})

    print(f"{ans1} == {ans2}: {verify_fn(ans1, ans2)}")  # >> True
    print(f"{ans1} == {ans3}: {verify_fn(ans1, ans3)}")  # >> True
    print(f"{ans1} == {ans4}: {verify_fn(ans1, ans4)}")  # >> False
    print(f"{ans1} == {ans7}: {verify_fn(ans1, ans7)}")  # >> False
