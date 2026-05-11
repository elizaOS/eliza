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

"""Inference module for GEM."""

from typing import Any


def run_config_combinations(*args: Any, **kwargs: Any) -> Any:
    """Lazy entrypoint to avoid importing heavy runner deps at module import time."""
    from .run_react import run_config_combinations as _run_config_combinations

    return _run_config_combinations(*args, **kwargs)


__all__ = ["run_config_combinations"]
