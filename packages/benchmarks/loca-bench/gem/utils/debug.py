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

"""Debugging utils."""

import time
from pprint import pprint

import numpy as np


def ppprint(x):
    if isinstance(x, (list, tuple)):
        for i, item in enumerate(x):
            print("-" * 5, f"{i + 1}/{len(x)}:")
            pprint(item)
            print("")
    else:
        pprint(x)


def run_and_print_episode_with_selective_step(
    env, policy, ignore_done: bool = False, max_steps: int = 1e9
):
    start_time = time.time()
    obs, _ = env.reset()
    done = False
    step_count = 0
    while True:
        step_count += 1
        action = policy(obs)
        # random select 50% as active actions
        active_actions = {}
        while not active_actions:
            active_actions = {
                i: a for i, a in enumerate(action) if np.random.rand() > 0.5
            }

        next_obs, reward, terminated, truncated, _ = env.step(active_actions)

        print("=" * 30)
        print(f"Step {step_count}")
        print(
            "-" * 10,
            "action",
            "-" * 10,
        )
        ppprint(active_actions)
        print(
            "-" * 10,
            "next_observation",
            "-" * 10,
        )
        ppprint(next_obs)
        print(
            "-" * 10,
            "reward",
            "-" * 10,
        )
        ppprint(reward)

        done = terminated | truncated

        print("terminated: ", terminated, "truncated: ", truncated)
        if isinstance(done, np.ndarray):
            done = done.all()

        print("=" * 30)
        obs = next_obs

        if not ignore_done and done:
            break
        if step_count >= max_steps:
            break

    print(f"----TIME: {time.time() - start_time:.2f} seconds")


def run_and_print_episode(env, policy, ignore_done: bool = False, max_steps: int = 1e9):
    start_time = time.time()
    obs, _ = env.reset()
    done = False
    step_count = 0
    while True:
        step_count += 1
        action = policy(obs)
        next_obs, reward, terminated, truncated, _ = env.step(action)

        print("=" * 30)
        print(f"Step {step_count}")
        print(
            "-" * 10,
            "observation",
            "-" * 10,
        )
        ppprint(obs)
        print(
            "-" * 10,
            "action",
            "-" * 10,
        )
        ppprint(action)
        print(
            "-" * 10,
            "reward",
            "-" * 10,
        )
        ppprint(reward)

        done = terminated | truncated

        print("terminated: ", terminated, "truncated: ", truncated)
        if isinstance(done, np.ndarray):
            done = done.all()

        print("=" * 30)
        obs = next_obs

        if not ignore_done and done:
            break
        if step_count >= max_steps:
            break

    print(f"----TIME: {time.time() - start_time:.2f} seconds")


async def run_and_print_episode_async(
    env, policy, ignore_done: bool = False, max_steps: int = 1e9
):
    start_time = time.time()
    obs, _ = await env.reset()
    done = False
    step_count = 0
    while True:
        step_count += 1
        action = policy(obs)
        next_obs, reward, terminated, truncated, _ = await env.step(action)

        print("=" * 30)
        print(f"Step {step_count}")
        print(
            "-" * 10,
            "observation",
            "-" * 10,
        )
        ppprint(obs)
        print(
            "-" * 10,
            "action",
            "-" * 10,
        )
        ppprint(action)
        print(
            "-" * 10,
            "reward",
            "-" * 10,
        )
        ppprint(reward)

        done = terminated | truncated

        print("terminated: ", terminated, "truncated: ", truncated)
        if isinstance(done, np.ndarray):
            done = done.all()

        print("=" * 30)
        obs = next_obs

        if not ignore_done and done:
            break
        if step_count >= max_steps:
            break

    print(f"----TIME: {time.time() - start_time:.2f} seconds")
