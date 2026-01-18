from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess
import uuid
from datetime import datetime
from pathlib import Path

import anthropic

from elizaos_plugin_n8n.config import N8nConfig
from elizaos_plugin_n8n.errors import (
    InvalidPluginNameError,
    MaxConcurrentJobsError,
    PluginExistsError,
    RateLimitError,
)
from elizaos_plugin_n8n.models import ClaudeModel, JobStatus
from elizaos_plugin_n8n.types import (
    CreatePluginOptions,
    JobError,
    PluginCreationJob,
    PluginSpecification,
    TestResults,
)


class PluginCreationClient:
    _config: N8nConfig
    _anthropic: anthropic.AsyncAnthropic
    _jobs: dict[str, PluginCreationJob]
    _created_plugins: set[str]
    _last_job_creation: float
    _job_creation_count: int

    def __init__(self, config: N8nConfig) -> None:
        self._config = config
        self._anthropic = anthropic.AsyncAnthropic(api_key=config.api_key)
        self._jobs: dict[str, PluginCreationJob] = {}
        self._created_plugins: set[str] = set()
        self._last_job_creation = 0.0
        self._job_creation_count = 0

    @property
    def config(self) -> N8nConfig:
        return self._config

    async def close(self) -> None:
        await self._anthropic.close()

    async def __aenter__(self) -> PluginCreationClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    def get_created_plugins(self) -> list[str]:
        return list(self._created_plugins)

    def is_plugin_created(self, name: str) -> bool:
        return name in self._created_plugins

    def get_all_jobs(self) -> list[PluginCreationJob]:
        return list(self._jobs.values())

    def get_job_status(self, job_id: str) -> PluginCreationJob | None:
        return self._jobs.get(job_id)

    async def create_plugin(
        self,
        specification: PluginSpecification,
        options: CreatePluginOptions | None = None,
    ) -> str:
        if self.is_plugin_created(specification.name):
            raise PluginExistsError(specification.name)

        if not self._is_valid_plugin_name(specification.name):
            raise InvalidPluginNameError(specification.name)

        if not self._check_rate_limit():
            raise RateLimitError()

        if len(self._jobs) >= self._config.max_concurrent_jobs:
            raise MaxConcurrentJobsError(self._config.max_concurrent_jobs)

        opts = options or CreatePluginOptions()
        model = ClaudeModel(opts.model) if opts.model else self._config.model

        job_id = str(uuid.uuid4())
        sanitized_name = self._sanitize_plugin_name(specification.name)
        output_path = self._config.get_plugins_dir() / job_id / sanitized_name

        job = PluginCreationJob(
            id=job_id,
            specification=specification,
            status=JobStatus.PENDING,
            currentPhase="initializing",
            progress=0.0,
            logs=[],
            outputPath=str(output_path),
            startedAt=datetime.now(),
            currentIteration=0,
            maxIterations=self._config.max_iterations,
            errors=[],
            modelUsed=model.value,
        )

        self._jobs[job_id] = job
        self._created_plugins.add(specification.name)

        asyncio.create_task(self._run_creation_process(job, opts.use_template))

        return job_id

    def cancel_job(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if job and job.status.is_active:
            job.status = JobStatus.CANCELLED
            job.completed_at = datetime.now()
            self._log_to_job(job_id, "Job cancelled by user")
            return True
        return False

    def cleanup_old_jobs(self, days: int = 7) -> int:
        cutoff = datetime.now().timestamp() - (days * 24 * 60 * 60)
        jobs_to_remove: list[str] = []

        for job_id, job in self._jobs.items():
            if job.completed_at and job.completed_at.timestamp() < cutoff:
                jobs_to_remove.append(job_id)
                output_path = Path(job.output_path)
                if output_path.exists():
                    shutil.rmtree(output_path, ignore_errors=True)

        for job_id in jobs_to_remove:
            del self._jobs[job_id]

        return len(jobs_to_remove)

    def _log_to_job(self, job_id: str, message: str) -> None:
        job = self._jobs.get(job_id)
        if job:
            timestamp = datetime.now().isoformat()
            job.logs.append(f"[{timestamp}] {message}")

    async def _run_creation_process(
        self,
        job: PluginCreationJob,
        use_template: bool = True,
    ) -> None:
        try:
            job.status = JobStatus.RUNNING
            await self._setup_plugin_workspace(job, use_template)

            success = False
            while job.current_iteration < job.max_iterations and not success:
                job.current_iteration += 1
                job.current_phase = f"iteration {job.current_iteration}/{job.max_iterations}"
                job.progress = (job.current_iteration / job.max_iterations) * 100
                self._log_to_job(job.id, f"Starting iteration {job.current_iteration}")

                success = await self._run_single_iteration(job)

                if not success and job.current_iteration < job.max_iterations:
                    await self._prepare_next_iteration(job)

            if success:
                job.status = JobStatus.COMPLETED
                job.completed_at = datetime.now()
                self._log_to_job(job.id, "Job completed successfully")
            else:
                job.status = JobStatus.FAILED
                job.completed_at = datetime.now()
                self._log_to_job(job.id, "Job failed after maximum iterations")

        except Exception as e:
            job.status = JobStatus.FAILED
            job.error = str(e)
            job.completed_at = datetime.now()
            self._log_to_job(job.id, f"Unexpected error: {e}")

    async def _run_single_iteration(self, job: PluginCreationJob) -> bool:
        try:
            job.current_phase = "generating"
            await self._generate_plugin_code(job)

            job.current_phase = "building"
            build_success = await self._build_plugin(job)
            if not build_success:
                job.errors.append(
                    JobError(
                        iteration=job.current_iteration,
                        phase="building",
                        error=job.error or "Build failed",
                        timestamp=datetime.now(),
                    )
                )
                return False

            job.current_phase = "linting"
            lint_success = await self._lint_plugin(job)
            if not lint_success:
                job.errors.append(
                    JobError(
                        iteration=job.current_iteration,
                        phase="linting",
                        error=job.error or "Lint failed",
                        timestamp=datetime.now(),
                    )
                )
                return False

            job.current_phase = "testing"
            test_success = await self._test_plugin(job)
            if not test_success:
                job.errors.append(
                    JobError(
                        iteration=job.current_iteration,
                        phase="testing",
                        error=job.error or "Tests failed",
                        timestamp=datetime.now(),
                    )
                )
                return False

            job.current_phase = "validating"
            validation_success = await self._validate_plugin(job)
            if not validation_success:
                job.errors.append(
                    JobError(
                        iteration=job.current_iteration,
                        phase="validating",
                        error=job.error or "Validation failed",
                        timestamp=datetime.now(),
                    )
                )
                return False

            return True

        except Exception as e:
            job.error = str(e)
            job.errors.append(
                JobError(
                    iteration=job.current_iteration,
                    phase=job.current_phase,
                    error=str(e),
                    timestamp=datetime.now(),
                )
            )
            self._log_to_job(job.id, f"Error in iteration: {e}")
            return False

    async def _setup_plugin_workspace(
        self,
        job: PluginCreationJob,
        use_template: bool = True,
    ) -> None:
        output_path = Path(job.output_path)
        output_path.mkdir(parents=True, exist_ok=True)

        (output_path / "src").mkdir(exist_ok=True)
        (output_path / "src" / "__tests__").mkdir(exist_ok=True)

        package_json = {
            "name": job.specification.name,
            "version": job.specification.version,
            "description": job.specification.description,
            "main": "dist/index.js",
            "types": "dist/index.d.ts",
            "scripts": {
                "build": "tsc",
                "test": "vitest run",
                "lint": "bunx @biomejs/biome check --write --unsafe .",
                "lint:check": "bunx @biomejs/biome check .",
            },
            "dependencies": {
                "@elizaos/core": "^2.0.0",
                **(job.specification.dependencies or {}),
            },
            "devDependencies": {
                "@types/node": "^20.0.0",
                "typescript": "^5.0.0",
                "vitest": "^1.0.0",
                "@biomejs/biome": "^2.3.11",
            },
        }

        with open(output_path / "package.json", "w") as f:
            json.dump(package_json, f, indent=2)

        tsconfig = {
            "compilerOptions": {
                "target": "ES2022",
                "module": "commonjs",
                "outDir": "./dist",
                "rootDir": "./src",
                "strict": True,
                "esModuleInterop": True,
                "declaration": True,
            },
            "include": ["src/**/*"],
            "exclude": ["node_modules", "dist"],
        }

        with open(output_path / "tsconfig.json", "w") as f:
            json.dump(tsconfig, f, indent=2)

    async def _generate_plugin_code(self, job: PluginCreationJob) -> None:
        is_first_iteration = job.current_iteration == 1
        previous_errors = [e for e in job.errors if e.iteration == job.current_iteration - 1]

        prompt = (
            self._generate_initial_prompt(job.specification)
            if is_first_iteration
            else self._generate_iteration_prompt(job, previous_errors)
        )

        message = await self._anthropic.messages.create(
            model=job.model_used or self._config.model.value,
            max_tokens=8192,
            temperature=0,
            messages=[{"role": "user", "content": prompt}],
        )

        response_text = "".join(block.text for block in message.content if hasattr(block, "text"))

        await self._write_generated_code(job, response_text)

    def _generate_initial_prompt(self, spec: PluginSpecification) -> str:
        actions_text = ""
        if spec.actions:
            actions_text = "Actions:\n" + "\n".join(
                f"- {a.name}: {a.description}" for a in spec.actions
            )

        providers_text = ""
        if spec.providers:
            providers_text = "Providers:\n" + "\n".join(
                f"- {p.name}: {p.description}" for p in spec.providers
            )

        services_text = ""
        if spec.services:
            services_text = "Services:\n" + "\n".join(
                f"- {s.name}: {s.description}" for s in spec.services
            )

        evaluators_text = ""
        if spec.evaluators:
            evaluators_text = "Evaluators:\n" + "\n".join(
                f"- {e.name}: {e.description}" for e in spec.evaluators
            )

        return f"""You are creating an ElizaOS plugin with the following specification:

Name: {spec.name}
Description: {spec.description}
Version: {spec.version}

{actions_text}
{providers_text}
{services_text}
{evaluators_text}

Create a complete ElizaOS plugin implementation following these requirements:

1. Create src/index.ts that exports the plugin object
2. Implement all specified components
3. Follow ElizaOS plugin structure and conventions
4. Include proper TypeScript types
5. Add comprehensive error handling
6. Create unit tests
7. Ensure all imports use @elizaos/core
8. No stubs or incomplete implementations

Provide the complete implementation with file paths clearly marked."""

    def _generate_iteration_prompt(
        self,
        job: PluginCreationJob,
        errors: list[JobError],
    ) -> str:
        error_summary = "\n".join(f"Phase: {e.phase}\nError: {e.error}" for e in errors)

        return f"""The ElizaOS plugin {job.specification.name} has the following errors:

{error_summary}

Current plugin specification:
{job.specification.model_dump_json(indent=2)}

Please fix all the errors and provide updated code with file paths marked."""

    async def _write_generated_code(
        self,
        job: PluginCreationJob,
        response_text: str,
    ) -> None:
        output_path = Path(job.output_path)
        file_regex = re.compile(
            r"```(?:typescript|ts|javascript|js)?\s*\n(?://\s*)?(?:File:\s*)?(.+?)\n([\s\S]*?)```"
        )

        for match in file_regex.finditer(response_text):
            file_path = match.group(1).strip()
            file_content = match.group(2).strip()

            normalized_path = file_path if file_path.startswith("src/") else f"src/{file_path}"
            full_path = output_path / normalized_path

            full_path.parent.mkdir(parents=True, exist_ok=True)
            full_path.write_text(file_content)

    async def _build_plugin(self, job: PluginCreationJob) -> bool:
        try:
            result = await self._run_command(job, ["npm", "install"])
            if not result[0]:
                job.error = result[1]
                return False

            result = await self._run_command(job, ["npm", "run", "build"])
            if not result[0]:
                job.error = result[1]
                return False

            return True
        except Exception as e:
            job.error = str(e)
            return False

    async def _lint_plugin(self, job: PluginCreationJob) -> bool:
        try:
            result = await self._run_command(job, ["npm", "run", "lint"])
            if not result[0]:
                job.error = result[1]
                return False
            return True
        except Exception as e:
            job.error = str(e)
            return False

    async def _test_plugin(self, job: PluginCreationJob) -> bool:
        try:
            result = await self._run_command(job, ["npm", "test"])
            job.test_results = self._parse_test_results(result[1])
            if not result[0] or (job.test_results and job.test_results.failed > 0):
                job.error = f"{job.test_results.failed if job.test_results else 0} tests failed"
                return False
            return True
        except Exception as e:
            job.error = str(e)
            return False

    async def _validate_plugin(self, job: PluginCreationJob) -> bool:
        try:
            code_files = await self._collect_code_files(Path(job.output_path))

            def format_code_file(f: dict[str, str]) -> str:
                return f"File: {f['path']}\n```typescript\n{f['content']}\n```"

            code_section = "\n".join(format_code_file(f) for f in code_files)
            validation_prompt = f"""Review this ElizaOS plugin:

Plugin: {job.specification.name}

Generated Code:
{code_section}

Respond with JSON:
{{"score": 0-100, "production_ready": boolean, "issues": [], "suggestions": []}}"""

            message = await self._anthropic.messages.create(
                model=job.model_used or self._config.model.value,
                max_tokens=4096,
                temperature=0,
                messages=[{"role": "user", "content": validation_prompt}],
            )

            response_text = "".join(
                block.text for block in message.content if hasattr(block, "text")
            )

            validation = json.loads(response_text)
            job.validation_score = validation.get("score", 0)

            if not validation.get("production_ready", False):
                issues = validation.get("issues", [])
                job.error = f"Score: {job.validation_score}/100. Issues: {', '.join(issues)}"
                return False

            return True
        except Exception as e:
            job.error = str(e)
            return False

    async def _run_command(
        self,
        job: PluginCreationJob,
        command: list[str],
    ) -> tuple[bool, str]:
        self._log_to_job(job.id, f"Running: {' '.join(command)}")

        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                cwd=job.output_path,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )

            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=300,
            )

            output = stdout.decode() + stderr.decode()
            return (process.returncode == 0, output)
        except TimeoutError:
            return (False, "Command timed out")
        except Exception as e:
            return (False, str(e))

    def _parse_test_results(self, output: str) -> TestResults:
        passed_match = re.search(r"(\d+) passed", output)
        failed_match = re.search(r"(\d+) failed", output)
        duration_match = re.search(r"Duration (\d+\.?\d*)s", output)

        return TestResults(
            passed=int(passed_match.group(1)) if passed_match else 0,
            failed=int(failed_match.group(1)) if failed_match else 0,
            duration=float(duration_match.group(1)) if duration_match else 0.0,
        )

    async def _collect_code_files(
        self,
        dir_path: Path,
    ) -> list[dict[str, str]]:
        files: list[dict[str, str]] = []

        for path in dir_path.rglob("*"):
            if path.is_file() and path.suffix in (".ts", ".js", ".json"):
                if "node_modules" not in path.parts and "dist" not in path.parts:
                    relative_path = path.relative_to(dir_path)
                    files.append(
                        {
                            "path": str(relative_path),
                            "content": path.read_text(),
                        }
                    )

        return files

    async def _prepare_next_iteration(self, job: PluginCreationJob) -> None:
        dist_path = Path(job.output_path) / "dist"
        if dist_path.exists():
            shutil.rmtree(dist_path)

    def _is_valid_plugin_name(self, name: str) -> bool:
        pattern = r"^@?[a-zA-Z0-9-_]+/[a-zA-Z0-9-_]+$"
        return bool(re.match(pattern, name)) and ".." not in name and "./" not in name

    def _sanitize_plugin_name(self, name: str) -> str:
        return name.lstrip("@").replace("/", "-").lower()

    def _check_rate_limit(self) -> bool:
        import time

        now = time.time()
        one_hour = 3600

        if now - self._last_job_creation > one_hour:
            self._job_creation_count = 0

        if self._job_creation_count >= self._config.rate_limit_per_hour:
            return False

        self._last_job_creation = now
        self._job_creation_count += 1
        return True
