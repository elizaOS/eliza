# This file contains logic for running evaluations on Modal: <https://modal.com/>.

from __future__ import annotations

import asyncio
import json
import modal
import modal.container_process
import modal.io_streams
import tenacity
import time
import traceback

from dataclasses import dataclass
from pathlib import Path
from swebench.harness.docker_build import setup_logger
from swebench.harness.reporting import make_run_report
from swebench.harness.utils import EvaluationError
from typing import cast

SANDBOX_ENTRYPOINT = "run_evaluation_modal_entrypoint"
LOCAL_SANDBOX_ENTRYPOINT_PATH = (
    Path(__file__).parent / f"{SANDBOX_ENTRYPOINT}.py"
).resolve()
REMOTE_SANDBOX_ENTRYPOINT_PATH = f"/root/{SANDBOX_ENTRYPOINT}.py"

app = modal.App("swebench-evaluation")

swebench_image = modal.Image.debian_slim().pip_install("swebench", "tenacity")

from swebench.harness.constants import (
    APPLY_PATCH_FAIL,
    APPLY_PATCH_PASS,
    RUN_EVALUATION_LOG_DIR,
)
from swebench.harness.grading import get_eval_report
from swebench.harness.test_spec.test_spec import make_test_spec, TestSpec


@dataclass
class TestOutput:
    instance_id: str
    test_output: str
    report_json_str: str
    run_instance_log: str
    patch_diff: str
    log_dir: Path
    errored: bool


class ModalSandboxRuntime:
    """
    Runtime for running instances in a Modal Sandbox.
    """

    def __init__(
        self, test_spec: TestSpec, timeout: int | None = None, verbose: bool = True
    ):
        self.test_spec = test_spec
        self.image = ModalSandboxRuntime.get_instance_image(test_spec)
        self.sandbox = self._get_sandbox(timeout)
        self.verbose = verbose
        self._stream_tasks = []

        # Hack for pylint
        self.write_file("/sys/fs/cgroup/cpu/cpu.shares", "2048")

    @tenacity.retry(
        stop=tenacity.stop_after_attempt(7),
        wait=tenacity.wait_exponential(multiplier=1, min=4, max=10),
    )
    def _get_sandbox(self, timeout: int | None = None):
        # Sometimes network flakiness causes the image build to fail,
        # so we retry a few times.
        if timeout is None:
            # Default 30 minutes
            timeout = 60 * 30

        return modal.Sandbox.create(
            image=self.image.add_local_file(
                REMOTE_SANDBOX_ENTRYPOINT_PATH,
                REMOTE_SANDBOX_ENTRYPOINT_PATH,
            ),
            timeout=timeout,
            cpu=4,
        )

    async def _read_stream(
        self, stream: modal.io_streams.StreamReader, output_list: list[str]
    ):
        try:
            async for line in stream:
                output_list.append(line)
                if self.verbose:
                    print(line)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"Error reading stream: {e}")

    async def _read_output(
        self,
        p: modal.container_process.ContainerProcess,
        stdout: list[str],
        stderr: list[str],
    ):
        self._stream_tasks = [
            asyncio.create_task(self._read_stream(p.stdout, stdout)),
            asyncio.create_task(self._read_stream(p.stderr, stderr)),
        ]
        try:
            await asyncio.gather(*self._stream_tasks)
        except asyncio.CancelledError:
            pass

    def write_file(self, file_path: str, content: str):
        self.sandbox.open(file_path, "w").write(content)

    def exec(self, command: str) -> tuple[str, int]:
        """
        Execute a command in the sandbox.

        Returns:
            tuple[str, int]: Sandbox output and return code.
        """
        p = self.sandbox.exec("python", "-m", SANDBOX_ENTRYPOINT, command)
        stdout = []
        stderr = []
        try:
            # We separate stdout/stderr because some tests rely on them being separate.
            # We still read stdout/stderr simultaneously to continuously
            # flush both streams and avoid blocking.
            asyncio.run(self._read_output(p, stdout, stderr))
        except Exception as e:
            print(f"Error during command execution: {e}")
        p.wait()
        return "".join(stdout + stderr), p.returncode

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self._stream_tasks:
            try:
                # Forcefully kill remaining streams
                for task in self._stream_tasks:
                    if not task.done():
                        task.cancel()
                        try:
                            asyncio.wait_for(task, timeout=0.1)
                        except asyncio.TimeoutError:
                            pass
                        except Exception:
                            pass

                self.sandbox.terminate()
            except Exception:
                pass
            finally:
                self._stream_tasks = []

    @staticmethod
    def get_instance_image(test_spec: TestSpec) -> modal.Image:
        env_script = test_spec.setup_env_script
        # add trusted host flag for Modal's PyPI mirror
        env_script = env_script.replace(
            "conda activate testbed && python -m pip install -r $HOME/requirements.txt",
            "conda activate testbed && python -m pip install --trusted-host pypi-mirror.modal.local -r $HOME/requirements.txt",
        )
        repo_script = test_spec.install_repo_script

        remote_env_script_path = "/root/setup_env.sh"
        remote_repo_script_path = "/root/setup_repo.sh"

        Path(remote_env_script_path).write_text(env_script)
        Path(remote_repo_script_path).write_text(repo_script)

        # Modal automatically caches images
        # https://modal.com/docs/guide/custom-container#image-caching-and-rebuilds
        return (
            modal.Image.from_registry("ubuntu:22.04", add_python="3.11")
            .run_commands("apt update")
            .env({"DEBIAN_FRONTEND": "noninteractive", "TZ": "Etc/UTC"})
            .apt_install(
                "wget",
                "git",
                "build-essential",
                "libffi-dev",
                "libtiff-dev",
                "jq",
                "curl",
                "locales",
                "locales-all",
                "tzdata",
            )
            .run_commands(
                "wget 'https://repo.anaconda.com/miniconda/Miniconda3-py311_23.11.0-2-Linux-x86_64.sh' -O miniconda.sh",
                "bash miniconda.sh -b -p /opt/miniconda3",
                "echo 'export PATH=/opt/miniconda3/bin:$PATH' >> ~/.bashrc",
                "/opt/miniconda3/bin/conda init --all",
                "/opt/miniconda3/bin/conda config --append channels conda-forge",
                "adduser --disabled-password --gecos 'dog' nonroot",
            )
            .add_local_file(
                Path(remote_env_script_path), remote_env_script_path, copy=True
            )
            .add_local_file(
                Path(remote_repo_script_path), remote_repo_script_path, copy=True
            )
            .run_commands(
                f"chmod +x {remote_env_script_path}",
                f"/bin/bash -c 'source ~/.bashrc && {remote_env_script_path}'",
                "echo 'source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed' >> /root/.bashrc",
                f"/bin/bash {remote_repo_script_path}",
            )
            .workdir("/testbed/")
        )


def get_log_dir(pred: dict, run_id: str, instance_id: str) -> Path:
    model_name_or_path = cast(
        str, pred.get("model_name_or_path", "None").replace("/", "__")
    )
    return RUN_EVALUATION_LOG_DIR / run_id / model_name_or_path / instance_id


@app.function(
    image=swebench_image.add_local_file(
        LOCAL_SANDBOX_ENTRYPOINT_PATH,
        REMOTE_SANDBOX_ENTRYPOINT_PATH,
    ),
    timeout=120
    * 60,  # Much larger than default timeout to account for image build time
    include_source=True,
)
def run_instance_modal(
    test_spec: TestSpec,
    pred: dict,
    run_id: str,
    timeout: int | None = None,
) -> TestOutput:
    """
    Run a single instance with the given prediction.

    Args:
        test_spec (TestSpec): TestSpec instance
        pred (dict): Prediction w/ model_name_or_path, model_patch, instance_id
        run_id (str): Run ID
        timeout (int): Timeout for running tests
    """
    instance_id = test_spec.instance_id
    log_dir = get_log_dir(pred, run_id, instance_id)
    log_dir.mkdir(parents=True, exist_ok=True)

    log_file = log_dir / "run_instance.log"

    logger = setup_logger(instance_id, log_file, add_stdout=True)

    try:
        runner = ModalSandboxRuntime(test_spec, timeout)
    except Exception as e:
        print(f"Error creating sandbox: {e}")
        raise EvaluationError(
            instance_id,
            f"Error creating sandbox: {e}",
            logger,
        ) from e

    patch_diff = pred.get("model_patch", "")

    try:
        patch_file = "/tmp/patch.diff"
        runner.write_file(patch_file, patch_diff)

        apply_patch_output, returncode = runner.exec(
            "cd /testbed && git apply -v /tmp/patch.diff",
        )

        if returncode != 0:
            logger.info("Failed to apply patch to container, trying again...")

            apply_patch_output, returncode = runner.exec(
                "cd /testbed && patch --batch --fuzz=5 -p1 -i /tmp/patch.diff",
            )

            if returncode != 0:
                logger.info(f"{APPLY_PATCH_FAIL}:\n{apply_patch_output}")
                raise EvaluationError(
                    instance_id,
                    f"{APPLY_PATCH_FAIL}:\n{apply_patch_output}",
                    logger,
                )
            else:
                logger.info(f"{APPLY_PATCH_PASS}:\n{apply_patch_output}")
        else:
            logger.info(f"{APPLY_PATCH_PASS}:\n{apply_patch_output}")

        # Get git diff before running eval script
        git_diff_output_before, returncode = runner.exec(
            "cd /testbed && git diff",
        )
        logger.info(f"Git diff before:\n{git_diff_output_before}")

        eval_file = "/root/eval.sh"
        eval_script = test_spec.eval_script
        # django hack
        eval_script = eval_script.replace("locale-gen", "locale-gen en_US.UTF-8")
        runner.write_file(eval_file, eval_script)

        start_time = time.time()

        run_command = "cd /testbed"
        # pylint hack
        if "pylint" in test_spec.instance_id:
            run_command += " && PYTHONPATH="
        # increase recursion limit for testing
        run_command += " && python3 -c 'import sys; sys.setrecursionlimit(10000)'"
        # run eval script
        run_command += " && /bin/bash /root/eval.sh"
        test_output, returncode = runner.exec(run_command)

        total_runtime = time.time() - start_time

        test_output_path = log_dir / "test_output.txt"
        logger.info(f"Test runtime: {total_runtime:_.2f} seconds")
        with open(test_output_path, "w") as f:
            f.write(test_output)
            logger.info(f"Test output for {instance_id} written to {test_output_path}")
            print(f"Test output for {instance_id} written to {test_output_path}")

        # Get git diff after running eval script
        git_diff_output_after, returncode = runner.exec("cd /testbed && git diff")

        # Check if git diff changed after running eval script
        logger.info(f"Git diff after:\n{git_diff_output_after}")
        if git_diff_output_after != git_diff_output_before:
            logger.info("Git diff changed after running eval script")

        # Get report from test output
        logger.info(f"Grading answer for {instance_id}...")
        report = get_eval_report(
            test_spec=test_spec,
            prediction=pred,
            test_log_path=test_output_path,
            include_tests_status=True,
        )
        logger.info(
            f"report: {report}\n"
            f"Result for {instance_id}: resolved: {report[instance_id]['resolved']}"
        )

        return TestOutput(
            instance_id=instance_id,
            test_output=test_output,
            report_json_str=json.dumps(report, indent=4),
            run_instance_log=log_file.read_text(),
            patch_diff=patch_diff,
            log_dir=log_dir,
            errored=False,
        )
    except modal.exception.SandboxTimeoutError as e:
        raise EvaluationError(
            instance_id,
            f"Test timed out after {timeout} seconds.",
            logger,
        ) from e
    except EvaluationError:
        error_msg = traceback.format_exc()
        logger.info(error_msg)
        return TestOutput(
            instance_id=instance_id,
            test_output="",
            report_json_str="",
            run_instance_log=log_file.read_text(),
            patch_diff=patch_diff,
            log_dir=log_dir,
            errored=True,
        )
    except Exception as e:
        error_msg = (
            f"Error in evaluating model for {instance_id}: {e}\n"
            f"{traceback.format_exc()}\n"
            f"Check ({logger.log_file}) for more information."
        )
        logger.error(error_msg)
        return TestOutput(
            instance_id=instance_id,
            test_output="",
            report_json_str="",
            run_instance_log=log_file.read_text(),
            patch_diff=patch_diff,
            log_dir=log_dir,
            errored=True,
        )


def run_instances_modal(
    predictions: dict,
    instances: list,
    full_dataset: list,
    run_id: str,
    timeout: int,
):
    """
    Run all instances for the given predictions on Modal.

    Args:
        predictions (dict): Predictions dict generated by the model
        instances (list): List of instances
        run_id (str): Run ID
        timeout (int): Timeout for running tests
    """
    test_specs = list(map(make_test_spec, instances))

    with modal.enable_output():
        with app.run():
            run_test_specs = []

            # Check for instances that have already been run
            for test_spec in test_specs:
                log_dir = get_log_dir(
                    predictions[test_spec.instance_id], run_id, test_spec.instance_id
                )
                if log_dir.exists():
                    continue
                run_test_specs.append(test_spec)

            if run_test_specs:
                # Run instances that haven't been run yet
                results = run_instance_modal.starmap(
                    [
                        (
                            test_spec,
                            predictions[test_spec.instance_id],
                            run_id,
                            timeout,
                        )
                        for test_spec in run_test_specs
                    ],
                    return_exceptions=True,
                )

                for result in results:
                    if not isinstance(result, TestOutput):
                        print(f"Result failed with error: {result}")
                        continue

                    # Save logs locally
                    log_dir = result.log_dir
                    log_dir.mkdir(parents=True, exist_ok=True)
                    with open(log_dir / "run_instance.log", "w") as f:
                        f.write(result.run_instance_log)
                    with open(log_dir / "test_output.txt", "w") as f:
                        f.write(result.test_output)
                    with open(log_dir / "patch.diff", "w") as f:
                        f.write(result.patch_diff)
                    with open(log_dir / "report.json", "w") as f:
                        try:
                            report_json = json.loads(result.report_json_str)
                            json.dump(report_json, f, indent=4)
                        except Exception:
                            # This happens if the test fails with any exception
                            print(f"{result.instance_id}: no report.json")

            make_run_report(predictions, full_dataset, run_id)
