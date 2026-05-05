"""Evaluation harness for SWE-bench using the official SWE-bench harness.

The upstream `swebench` harness runs the real repository test suite inside Docker.
This evaluator wraps that harness for a single instance at a time.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import platform as _platform
import re
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from .types import PatchStatus, SWEBenchInstance, SWEBenchResult

logger = logging.getLogger(__name__)


@dataclass
class PatchQualityResult:
    """Result of patch quality evaluation."""

    similarity: float
    file_overlap: float
    line_overlap: float
    generated_files: list[str]
    truth_files: list[str]


class SWEBenchEvaluator:
    """Evaluate patches using the SWE-bench harness (Docker)."""

    DEFAULT_DATASET_NAME = "SWE-bench/SWE-bench_Lite"

    def __init__(
        self,
        timeout_seconds: int = 600,
        use_docker: bool = True,
        dataset_name: str | None = None,
        dataset_split: str = "test",
        max_workers: int = 1,
        namespace: str | None = None,
        instance_image_tag: str = "latest",
        env_image_tag: str = "latest",
    ):
        self.timeout_seconds = timeout_seconds
        self.use_docker = use_docker
        self.dataset_name = dataset_name or self.DEFAULT_DATASET_NAME
        self.dataset_split = dataset_split
        self.max_workers = max_workers
        self.namespace = namespace
        self.instance_image_tag = instance_image_tag
        self.env_image_tag = env_image_tag
        self._docker_available: bool | None = None

    async def check_docker_available(self) -> bool:
        """Check if Docker is available."""
        if self._docker_available is not None:
            return self._docker_available

        try:
            result = await asyncio.create_subprocess_exec(
                "docker",
                "info",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await result.wait()
            self._docker_available = result.returncode == 0
        except Exception:
            self._docker_available = False

        return self._docker_available

    async def evaluate_patch(
        self,
        instance: SWEBenchInstance,
        patch: str,
    ) -> SWEBenchResult:
        """Evaluate a generated patch via the SWE-bench harness."""
        start_time = time.time()

        # If no patch, return early
        if not patch.strip():
            return SWEBenchResult(
                instance_id=instance.instance_id,
                generated_patch=patch,
                patch_status=PatchStatus.NOT_GENERATED,
                tests_passed=[],
                tests_failed=[],
                success=False,
                duration_seconds=time.time() - start_time,
                tokens_used=0,
                error="No patch generated",
            )

        # Check if Docker is available and enabled
        if not self.use_docker or not await self.check_docker_available():
            logger.warning("Docker not available, performing basic patch validation only")
            return await self._basic_validation(instance, patch, start_time)

        try:
            return await self._harness_evaluation(instance, patch, start_time)
        except Exception as e:
            logger.error(f"SWE-bench harness evaluation failed: {e}")
            return SWEBenchResult(
                instance_id=instance.instance_id,
                generated_patch=patch,
                patch_status=PatchStatus.GENERATED,
                tests_passed=[],
                tests_failed=[],
                success=False,
                duration_seconds=time.time() - start_time,
                tokens_used=0,
                error=f"Evaluation error: {str(e)}",
            )

    def _safe_run_id(self, instance_id: str) -> str:
        """Create a filesystem-safe run id for the harness."""
        ts = int(time.time())
        base = f"elizaos_{ts}_{instance_id}"
        # Keep it conservative: letters, digits, underscore, dash, dot.
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", base)
        return safe[:200]

    async def _maybe_prepare_epoch_prebuilt_image(self, instance_id: str) -> None:
        """Best-effort: tag Epoch prebuilt images to match harness naming.

        The public registry provides images named like:
        `ghcr.io/epoch-research/swe-bench.eval.<arch>.<instance_id>:latest`

        Newer swebench harness versions may look for `sweb.eval.*` and may also
        rewrite `__` in names. If `self.namespace` is set and points at
        `ghcr.io/epoch-research`, we try to pull + retag so the harness can find
        the image without rebuilding.
        """
        if self.namespace != "ghcr.io/epoch-research":
            return

        arch = "x86_64"
        instance_id_lower = instance_id.lower()

        source = f"{self.namespace}/swe-bench.eval.{arch}.{instance_id_lower}:{self.instance_image_tag}"

        # This is the name the harness will look for when namespace is provided.
        # See swebench.harness.test_spec.test_spec.TestSpec.instance_image_key.
        expected_local = (
            f"{self.namespace}/sweb.eval.{arch}.{instance_id_lower}:{self.instance_image_tag}"
        ).replace("__", "_1776_")

        # If it's already present, nothing to do.
        inspect = await asyncio.create_subprocess_exec(
            "docker",
            "image",
            "inspect",
            expected_local,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await inspect.wait()
        if inspect.returncode == 0:
            return

        # Pull the Epoch image if needed.
        logger.info(f"Attempting to pull prebuilt instance image: {source}")
        pull = await asyncio.create_subprocess_exec(
            "docker",
            "pull",
            source,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await pull.communicate()

        # Tag to the name the harness expects.
        logger.info(f"Tagging {source} -> {expected_local}")
        tag = await asyncio.create_subprocess_exec(
            "docker",
            "tag",
            source,
            expected_local,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await tag.communicate()

    async def _harness_evaluation(
        self,
        instance: SWEBenchInstance,
        patch: str,
        start_time: float,
    ) -> SWEBenchResult:
        """Run evaluation via `python -m swebench.harness.run_evaluation`.

        We run the harness in an isolated temp directory to avoid polluting the repo with
        `logs/run_evaluation/**` and report JSON files.
        """
        model_name_or_path = "elizaos"
        run_id = self._safe_run_id(instance.instance_id)

        # Best-effort speedup: use Epoch's prebuilt images when configured.
        await self._maybe_prepare_epoch_prebuilt_image(instance.instance_id)

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            predictions_path = tmp_path / "predictions.jsonl"

            record = {
                "instance_id": instance.instance_id,
                "model_name_or_path": model_name_or_path,
                "model_patch": patch,
            }
            predictions_path.write_text(json.dumps(record) + "\n", encoding="utf-8")

            cmd: list[str] = [
                "python",
                "-m",
                "swebench.harness.run_evaluation",
                "--dataset_name",
                self.dataset_name,
                "--split",
                self.dataset_split,
                "--instance_ids",
                instance.instance_id,
                "--predictions_path",
                str(predictions_path),
                "--max_workers",
                str(self.max_workers),
                "--timeout",
                str(self.timeout_seconds),
                "--run_id",
                run_id,
            ]

            # IMPORTANT: swebench harness defaults --namespace to "swebench",
            # which makes it treat images as "remote" and attempt `docker pull`.
            # For local builds we must explicitly pass `--namespace none`.
            namespace_arg = self.namespace if self.namespace is not None else "none"
            cmd.extend(["--namespace", namespace_arg])

            if self.namespace is not None:
                cmd.extend(["--instance_image_tag", self.instance_image_tag])
                cmd.extend(["--env_image_tag", self.env_image_tag])

            logger.info(f"Running SWE-bench harness for {instance.instance_id} (run_id={run_id})")

            # On Apple Silicon (ARM64), the SWE-bench Docker images are x86_64-only.
            # Set DOCKER_DEFAULT_PLATFORM so Docker uses QEMU emulation transparently.
            env = dict(os.environ)
            if _platform.machine() in ("arm64", "aarch64"):
                env["DOCKER_DEFAULT_PLATFORM"] = "linux/amd64"
                logger.info("ARM64 detected; setting DOCKER_DEFAULT_PLATFORM=linux/amd64")

            process = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=str(tmp_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            stdout_bytes, stderr_bytes = await process.communicate()
            stdout = stdout_bytes.decode("utf-8", errors="replace")
            stderr = stderr_bytes.decode("utf-8", errors="replace")

            # Locate the per-instance report file.
            report_path = (
                tmp_path
                / "logs"
                / "run_evaluation"
                / run_id
                / model_name_or_path.replace("/", "__")
                / instance.instance_id
                / "report.json"
            )

            if not report_path.exists():
                return SWEBenchResult(
                    instance_id=instance.instance_id,
                    generated_patch=patch,
                    patch_status=PatchStatus.GENERATED,
                    tests_passed=[],
                    tests_failed=[],
                    success=False,
                    duration_seconds=time.time() - start_time,
                    tokens_used=0,
                    error=(
                        "Harness did not produce a report.json. "
                        f"Exit code={process.returncode}. stderr tail:\n{stderr[-4000:]}"
                    ),
                )

            report_obj = json.loads(report_path.read_text(encoding="utf-8"))
            instance_report = report_obj.get(instance.instance_id, {})

            resolved = bool(instance_report.get("resolved", False))
            applied = bool(instance_report.get("patch_successfully_applied", False))

            tests_passed: list[str] = []
            tests_failed: list[str] = []
            tests_status = instance_report.get("tests_status")
            if isinstance(tests_status, dict):
                f2p = tests_status.get("FAIL_TO_PASS")
                p2p = tests_status.get("PASS_TO_PASS")
                if isinstance(f2p, dict):
                    succ = f2p.get("success")
                    fail = f2p.get("failure")
                    if isinstance(succ, list):
                        tests_passed.extend([str(x) for x in succ])
                    if isinstance(fail, list):
                        tests_failed.extend([str(x) for x in fail])
                if isinstance(p2p, dict):
                    succ = p2p.get("success")
                    fail = p2p.get("failure")
                    if isinstance(succ, list):
                        tests_passed.extend([str(x) for x in succ])
                    if isinstance(fail, list):
                        tests_failed.extend([str(x) for x in fail])

            if not applied:
                patch_status = PatchStatus.APPLY_FAILED
            else:
                patch_status = PatchStatus.TESTS_PASSED if resolved else PatchStatus.TESTS_FAILED

            # If harness exited non-zero, surface stderr even if we have a report.
            error: str | None = None
            if process.returncode != 0:
                error = f"Harness exited with code {process.returncode}. stderr tail:\n{stderr[-4000:]}"

            return SWEBenchResult(
                instance_id=instance.instance_id,
                generated_patch=patch,
                patch_status=patch_status,
                tests_passed=tests_passed,
                tests_failed=tests_failed,
                success=resolved,
                duration_seconds=time.time() - start_time,
                tokens_used=0,
                error=error,
            )

    async def _basic_validation(
        self,
        instance: SWEBenchInstance,
        patch: str,
        start_time: float,
    ) -> SWEBenchResult:
        """Perform basic patch validation without Docker."""
        # Check if patch looks valid
        is_valid_patch = (
            patch.strip().startswith("diff --git")
            or patch.strip().startswith("---")
            or "@@" in patch
        )

        if not is_valid_patch:
            return SWEBenchResult(
                instance_id=instance.instance_id,
                generated_patch=patch,
                patch_status=PatchStatus.NOT_GENERATED,
                tests_passed=[],
                tests_failed=[],
                success=False,
                duration_seconds=time.time() - start_time,
                tokens_used=0,
                error="Invalid patch format",
            )

        # Count number of files changed
        files_changed = patch.count("diff --git")

        return SWEBenchResult(
            instance_id=instance.instance_id,
            generated_patch=patch,
            patch_status=PatchStatus.GENERATED,
            tests_passed=[],
            tests_failed=[],
            success=False,  # Can't verify without running tests
            duration_seconds=time.time() - start_time,
            tokens_used=0,
            error=f"Basic validation only (Docker not available). Patch modifies {files_changed} file(s).",
        )

    def _parse_test_results(self, logs: str) -> tuple[list[str], list[str]]:
        """Parse test results from Docker logs."""
        passed: list[str] = []
        failed: list[str] = []

        for line in logs.split("\n"):
            line = line.strip()

            # pytest output format
            if " PASSED" in line:
                test_name = line.split(" PASSED")[0].strip()
                if test_name and test_name not in passed:
                    passed.append(test_name)
            elif " FAILED" in line:
                test_name = line.split(" FAILED")[0].strip()
                if test_name and test_name not in failed:
                    failed.append(test_name)
            elif " ERROR" in line:
                test_name = line.split(" ERROR")[0].strip()
                if test_name and test_name not in failed:
                    failed.append(test_name)

            # unittest output format
            elif line.startswith("ok "):
                test_name = line[3:].strip()
                if test_name and test_name not in passed:
                    passed.append(test_name)
            elif line.startswith("FAIL: "):
                test_name = line[6:].strip()
                if test_name and test_name not in failed:
                    failed.append(test_name)
            elif line.startswith("ERROR: "):
                test_name = line[7:].strip()
                if test_name and test_name not in failed:
                    failed.append(test_name)

        return passed, failed


class SimplePatchEvaluator:
    """Simple patch evaluator that checks patch quality without running tests."""

    def evaluate_patch_quality(
        self,
        generated_patch: str,
        ground_truth_patch: str,
    ) -> PatchQualityResult:
        """Evaluate patch quality compared to ground truth."""
        if not generated_patch.strip():
            return PatchQualityResult(
                similarity=0.0,
                file_overlap=0.0,
                line_overlap=0.0,
                generated_files=[],
                truth_files=[],
            )

        gen_files = self._extract_files(generated_patch)
        truth_files = self._extract_files(ground_truth_patch)

        # Calculate file overlap
        if truth_files:
            file_overlap = len(gen_files & truth_files) / len(truth_files)
        else:
            file_overlap = 0.0

        # Calculate line-level similarity
        gen_lines = set(generated_patch.split("\n"))
        truth_lines = set(ground_truth_patch.split("\n"))

        if truth_lines:
            line_overlap = len(gen_lines & truth_lines) / len(truth_lines)
        else:
            line_overlap = 0.0

        # Overall similarity
        similarity = (file_overlap + line_overlap) / 2

        return PatchQualityResult(
            similarity=similarity,
            file_overlap=file_overlap,
            line_overlap=line_overlap,
            generated_files=list(gen_files),
            truth_files=list(truth_files),
        )

    def _extract_files(self, patch: str) -> set[str]:
        """Extract file paths from a patch."""
        files: set[str] = set()

        for line in patch.split("\n"):
            if line.startswith("diff --git"):
                parts = line.split()
                if len(parts) >= 4:
                    # Extract b/path from "diff --git a/path b/path"
                    file_path = parts[3]
                    if file_path.startswith("b/"):
                        file_path = file_path[2:]
                    files.add(file_path)
            elif line.startswith("+++ ") or line.startswith("--- "):
                parts = line.split()
                if len(parts) >= 2:
                    file_path = parts[1]
                    if file_path.startswith("b/") or file_path.startswith("a/"):
                        file_path = file_path[2:]
                    if file_path != "/dev/null":
                        files.add(file_path)

        return files
