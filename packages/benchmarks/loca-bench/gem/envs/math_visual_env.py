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
import multiprocessing
import random
from typing import Any, Dict, Optional, Tuple

from datasets import Dataset, DatasetDict, load_dataset

from gem.envs.math_env import MathEnv


class MathVisualEnv(MathEnv):
    def __init__(
        self,
        dataset_name: Optional[str] = "",
        split: Optional[str] = None,
        dataset: Optional[Dataset] = None,
        image_key: str = "images",
        question_key: str = "problem",
        answer_key: str = "answer",
        seed: int = 0,
        use_mp: bool = True,
        **kwargs: Any,
    ):
        self.seed = seed
        self.image_key = image_key
        self.question_key = question_key
        self.answer_key = answer_key
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

    def reset(
        self, seed: Optional[None] = None, idx: Optional[int] = None
    ) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        """Sample a question from the dataset."""
        super().reset(seed)
        if idx is not None:
            assert 0 <= idx < len(self.dataset)
            logging.info(
                f"Reset env with a specific idx {idx}. This is only recommended for testing only!!!"
            )
            self.idx = idx
        elif seed is not None:
            self.idx = random.randint(0, len(self.dataset) - 1)
        else:
            if self.idx == len(self.dataset):
                self.epoch += 1
                self.dataset = self.dataset.shuffle(seed=self.seed + self.epoch)
                self.idx = 0

        data = self.dataset[self.idx]
        self.first_obs = {
            "problem": data[self.question_key],
            "images": data[self.image_key],
        }
        self.answer = data[self.answer_key]
        self.idx += 1
        return self.first_obs, {}
