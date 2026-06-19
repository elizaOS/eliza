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

import asyncio
from typing import Tuple


class DockerExecutor:
    """Execute commands using docker exec."""

    def __init__(self, container_name: str):
        self.container_name = container_name

    async def execute(self, cmd: str, timeout: int = 30) -> Tuple[str, int]:
        """Execute a command in the Docker container and return (output, return_code)."""
        try:
            proc = await asyncio.create_subprocess_exec(
                "docker",
                "exec",
                self.container_name,
                "bash",
                "-c",
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )

            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            output = stdout.decode("utf-8", errors="replace")
            exit_code = proc.returncode or 0

            return output, exit_code

        except asyncio.TimeoutError:
            if proc:
                proc.kill()
            return (
                f"Command timed out after {timeout} seconds",
                124,
            )  # 124 is the standard timeout exit code
        except Exception as e:
            return f"Error executing command: {str(e)}", 1

    async def execute_background(self, cmd: str) -> None:
        """Execute a command in background in the Docker container."""
        try:
            proc = await asyncio.create_subprocess_exec(
                "docker", "exec", "-d", self.container_name, "bash", "-c", cmd
            )
            await proc.wait()
        except Exception:
            # Background execution failures are silently ignored
            pass
