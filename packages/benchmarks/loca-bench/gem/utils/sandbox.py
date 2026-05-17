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

import copy
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import uuid
from tempfile import NamedTemporaryFile
from typing import List, Optional

from gem.utils.constants import BASE_IMPORTS

DEFAULT_TIMEOUT = 10
CLI_ARG_SIZE_LIMIT = 1024 * 3
ERROR_MSG_PREFIX = "Failed to execute program: "


def check_forbidden_imports(code: str) -> bool:
    """
    Checks if the code contains imports of potentially dangerous packages.
    Args: code: Python code string to analyze
    Returns: Boolean indicating if the code contains forbidden imports
    """
    # List of potentially dangerous modules that could affect the host system
    forbidden_modules = [
        "subprocess",
        "multiprocessing",
        "threading",
        "socket",
        "psutil",
        "resource",
        "ctypes",
    ]

    # Simple string-based check for import statements
    for module in forbidden_modules:
        if f"import {module}" in code or f"from {module}" in code:
            return True

    # Check for os.system, os.popen, and similar dangerous calls
    dangerous_patterns = [
        "os.system",
        "os.popen",
        "os.spawn",
        "os.fork",
        "os.exec",
        "sys.exit",
        "os._exit",
        "os.kill",
    ]

    for pattern in dangerous_patterns:
        if pattern in code:
            return True

    return False


def subprocess_run(
    code: str,
    cmd_list: List[str],
    sandbox_type: str,
    stdin: Optional[str] = None,
    timeout: int = DEFAULT_TIMEOUT,
):
    # Dealing with special cases for immediate return.
    if code == "...":
        stdout = ""
        stderr = "SyntaxError: invalid syntax"
        return False, stdout, stderr

    # Create a minimal environment instead of copying everything
    original_env = os.environ.copy()
    env = {}

    # Core system variables
    essential_vars = [
        "PATH",
        "HOME",
        "USER",
        "SHELL",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TERM",
        # Python-specific
        "PYTHONIOENCODING",
        "PYTHONUNBUFFERED",
        "PYTHONHASHSEED",
        "PYTHONDONTWRITEBYTECODE",
        # Runtime optimization
        "MKL_NUM_THREADS",
        "OMP_NUM_THREADS",
        "NUMEXPR_NUM_THREADS",
        # Temp directories
        "TMPDIR",
        "TEMP",
        "TMP",
        # Display if needed
        "DISPLAY",
        "XAUTHORITY",
    ]

    # Copy only essential variables if they exist
    for var in essential_vars:
        if var in original_env:
            env[var] = original_env[var]

    # Explicitly set optimization variables
    env["OPENBLAS_NUM_THREADS"] = "1"

    if "PYTHONPATH" in env:
        del env["PYTHONPATH"]

    if len(code) < CLI_ARG_SIZE_LIMIT:
        temp_dir = tempfile.mkdtemp(dir=".")
        cmd_list.extend(["python", "-c", code])
        try:
            result = subprocess.run(
                cmd_list,
                cwd=temp_dir,
                input=stdin.encode() if stdin else None,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                timeout=timeout,
            )
        except Exception as e:
            shutil.rmtree(temp_dir)
            raise e
        shutil.rmtree(temp_dir)
    else:
        with NamedTemporaryFile(
            mode="wb", prefix=uuid.uuid4().hex, suffix=".py"
        ) as tmp:
            tmp.write(code.encode())
            tmp.flush()
            if sandbox_type == "bwrap":
                cmd_list.extend(["--ro-bind", tmp.name, tmp.name])
            cmd_list.extend(["python", tmp.name])
            result = subprocess.run(
                cmd_list,
                input=stdin.encode() if stdin else None,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                check=False,
                timeout=timeout,
            )
    stderr = result.stderr.decode().strip()
    stdout = result.stdout.decode()
    if result.returncode == 0:
        return True, stdout, stderr
    return False, stdout, stderr


def run_python(
    code: str,
    sandbox_type: str,
    stdin: Optional[str] = None,
    timeout: int = DEFAULT_TIMEOUT,
):
    if sandbox_type == "bwrap":
        command = """bwrap \
    --unshare-all \
    --ro-bind {python_env} /python_env \
    --setenv PATH "/python_env/bin:/usr/bin:/bin" \
    --ro-bind /lib /lib \
    --ro-bind /lib64 /lib64 \
    --ro-bind /usr/lib /usr/lib \
    --proc /proc \
    --dev /dev \
    """
        command = command.format(python_env=sys.prefix)
    elif sandbox_type == "none":
        command = ""
        if check_forbidden_imports(code):
            return (
                False,
                "",
                "Execution blocked: Code contains potentially dangerous operations or imports.",
            )

    cmd_list = shlex.split(command)
    try:
        # 1) Run the code without extra imports first
        run_success, stdout, stderr = subprocess_run(
            code, copy.deepcopy(cmd_list), sandbox_type, stdin
        )
        if not run_success and "is not defined" in stderr:
            # 2) Fix the missing imports and run again
            code = BASE_IMPORTS + "\n" + code
            run_success, stdout, stderr = subprocess_run(
                code, cmd_list, sandbox_type, stdin
            )
    except subprocess.TimeoutExpired:
        run_success, stdout, stderr = (
            False,
            "",
            f"\nExecution timed out after {timeout} seconds.",
        )
    return run_success, stdout, stderr
