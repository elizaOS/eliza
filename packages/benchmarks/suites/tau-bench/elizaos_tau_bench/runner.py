"""Benchmark runner.

Wires the vendored upstream ``Env`` (which already contains the LLM-driven
user simulator) to an ElizaOS agent, runs each task ``num_trials`` times,
applies the LLM judge to gate ``task.outputs``, and computes pass^k.

This replaces the previous handwritten environments + executor pipeline.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import time
from pathlib import Path
from typing import Optional

from elizaos_tau_bench.dataset import (
    count_task_items,
    expand_task_items,
    iter_sample_tasks,
    iter_tasks,
    validate_task_items,
)
from elizaos_tau_bench.data_assets import data_provenance
from elizaos_tau_bench.eliza_agent import (
    AgentRunResult,
    BaseTauAgent,
    LiteLLMToolCallingAgent,
    MockTauAgent,
)
from elizaos_tau_bench.judge import judge_outputs_satisfied
from elizaos_tau_bench.pass_k import calculate_pass_hat_k
from elizaos_tau_bench.types import (
    BenchmarkReport,
    DomainName,
    PassKResult,
    Task,
    TaskRunResult,
    TauBenchConfig,
)
from elizaos_tau_bench.noop_user import NoopUserSimulationEnv
from elizaos_tau_bench.upstream.envs import get_env
from elizaos_tau_bench.upstream.envs.base import Env

logger = logging.getLogger(__name__)

OFFICIAL_TEST_TASK_COUNTS: dict[DomainName, int] = {
    "retail": 115,
    "airline": 50,
}


def _workload_sha256(
    task_list: list[tuple[DomainName, int, Task, str, str]],
    config: TauBenchConfig,
) -> str:
    payload = {
        "schema_version": 1,
        "task_split": config.task_split,
        "num_trials": config.num_trials,
        "seed": config.seed,
        "tasks": [
            {
                "domain": domain,
                "task_index": task_index,
                "scenario_id": scenario_id,
                "scenario_note": scenario_note,
                "task": task.model_dump(mode="json"),
            }
            for domain, task_index, task, scenario_id, scenario_note in task_list
        ],
    }
    canonical = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


class TauBenchRunner:
    """Orchestrates evaluation of a set of tasks across trials."""

    def __init__(self, config: TauBenchConfig) -> None:
        if not config.domains or len(set(config.domains)) != len(config.domains):
            raise ValueError("tau-bench domains must be a non-empty unique list")
        if any(domain not in OFFICIAL_TEST_TASK_COUNTS for domain in config.domains):
            raise ValueError(f"unknown tau-bench domain selection: {config.domains!r}")
        if config.num_trials <= 0:
            raise ValueError("tau-bench num_trials must be positive")
        if (
            not config.pass_k_values
            or len(set(config.pass_k_values)) != len(config.pass_k_values)
            or any(k <= 0 or k > config.num_trials for k in config.pass_k_values)
        ):
            raise ValueError(
                "tau-bench pass_k_values must be unique positive values no larger "
                "than num_trials"
            )
        if config.agent_max_turns <= 0:
            raise ValueError("tau-bench agent_max_turns must be positive")
        if config.max_concurrency <= 0:
            raise ValueError("tau-bench max_concurrency must be positive")
        if config.start_index < 0:
            raise ValueError("tau-bench start_index cannot be negative")
        if config.end_index != -1 and config.end_index <= config.start_index:
            raise ValueError("tau-bench end_index must be -1 or greater than start_index")
        if config.max_tasks_per_domain is not None and config.max_tasks_per_domain <= 0:
            raise ValueError("tau-bench max_tasks_per_domain must be positive")
        if config.task_ids is not None and (
            not config.task_ids
            or len(set(config.task_ids)) != len(config.task_ids)
            or any(task_id < 0 for task_id in config.task_ids)
        ):
            raise ValueError("tau-bench task_ids must be unique non-negative ids")
        self.config = config

    # --- Env construction -------------------------------------------------

    def _make_env(self, domain: DomainName, task_index: int) -> Env:
        if self.config.use_mock:
            # Monkey-patch the user loader so the Env constructor doesn't hit an LLM.
            from elizaos_tau_bench.upstream.envs import base as _base_envs

            original_loader = _base_envs.load_user
            _base_envs.load_user = lambda *a, **kw: NoopUserSimulationEnv()
            try:
                env = get_env(
                    env_name=domain,
                    user_strategy="llm",  # ignored — overridden by patch
                    user_model="mock",
                    user_provider="mock",
                    task_split=self.config.task_split,
                    task_index=task_index,
                )
            finally:
                _base_envs.load_user = original_loader
            return env

        user_strategy = self.config.user_strategy
        if self.config.use_sample_tasks and user_strategy == "llm":
            # Sample mode is a harness smoke check. Keep official non-sample
            # runs on the upstream LLM user simulator, but avoid sample
            # failures from simulated-user hallucinations such as invented
            # customer emails.
            user_strategy = "grounded"

        return get_env(
            env_name=domain,
            user_strategy=user_strategy,
            user_model=self.config.user_model,
            user_provider=self.config.user_provider,
            task_split=self.config.task_split,
            task_index=task_index,
        )

    def _apply_scenario_note(self, env: Env, task_index: int, scenario_note: str) -> None:
        if not scenario_note:
            return
        task = env.tasks[task_index]
        note = f"\n\nAdditional conversation condition: {scenario_note}"
        env.tasks[task_index] = task.model_copy(update={"instruction": task.instruction + note})

    def _make_agent(self) -> BaseTauAgent:
        if self.config.use_mock:
            return MockTauAgent()
        harness = (self.config.agent_harness or "litellm").strip().lower()
        if harness in {"", "litellm"}:
            return LiteLLMToolCallingAgent(
                model=self.config.agent_model,
                provider=self.config.agent_provider,
                temperature=self.config.agent_temperature,
            )
        if harness == "hermes":
            from hermes_adapter.tau_bench import HermesTauAgent  # noqa: WPS433

            return HermesTauAgent(
                model=self.config.agent_model,
                provider=self.config.agent_provider,
                temperature=self.config.agent_temperature,
            )
        if harness == "openclaw":
            from openclaw_adapter.tau_bench import OpenClawTauAgent  # noqa: WPS433

            return OpenClawTauAgent(
                model=self.config.agent_model,
                provider=self.config.agent_provider,
                temperature=self.config.agent_temperature,
            )
        if harness == "smithers":
            from smithers_adapter.tau_bench import SmithersTauAgent  # noqa: WPS433

            return SmithersTauAgent(
                model=self.config.agent_model,
                provider=self.config.agent_provider,
                temperature=self.config.agent_temperature,
            )
        if harness == "eliza":
            from eliza_adapter.tau_bench import ElizaTauAgent  # noqa: WPS433

            return ElizaTauAgent(
                model=self.config.agent_model,
                provider=self.config.agent_provider,
                temperature=self.config.agent_temperature,
            )
        raise ValueError(
            f"Unknown --agent-harness {harness!r}; "
            "expected one of: litellm, hermes, openclaw, eliza, smithers"
        )

    # --- Per-trial -------------------------------------------------------

    def _extract_agent_messages(self, messages: list[dict]) -> list[str]:
        """Pull out the agent's RESPOND content (visible to the user)."""
        out: list[str] = []
        for m in messages:
            if m.get("role") != "assistant":
                continue
            # Only count plain content (tool calls are not customer-facing)
            if m.get("tool_calls"):
                continue
            content = m.get("content")
            if content:
                out.append(str(content))
        return out

    def _run_trial(
        self,
        domain: DomainName,
        task_index: int,
        task: Task,
        trial: int,
        agent: BaseTauAgent,
        scenario_id: str = "base",
        scenario_note: str = "",
    ) -> TaskRunResult:
        try:
            env = self._make_env(domain, task_index)
            self._apply_scenario_note(env, task_index, scenario_note)
        except Exception as exc:
            # error-policy:J2 Attach the scheduled rollout identity before the
            # full-run boundary aborts without writing a partial report.
            raise RuntimeError(
                f"failed to construct tau-bench env for {domain} task {task_index}"
            ) from exc

        run: AgentRunResult = agent.solve(
            env=env, task_index=task_index, max_num_steps=self.config.agent_max_turns
        )
        if run.error is not None:
            raise RuntimeError(
                f"tau-bench agent failed for {domain} task {task_index} "
                f"scenario={scenario_id} trial={trial}: {run.error}"
            )
        if (
            not isinstance(run.reward, (int, float))
            or isinstance(run.reward, bool)
            or not math.isfinite(float(run.reward))
            or not 0 <= float(run.reward) <= 1
        ):
            raise ValueError(
                f"tau-bench agent returned invalid reward for {domain} task "
                f"{task_index}: {run.reward!r}"
            )

        # Upstream env's calculate_reward fired on done; pull both data-hash and
        # outputs sub-rewards out of info.reward_info.
        reward_info = run.info.get("reward_info") if isinstance(run.info, dict) else None
        r_actions: Optional[float] = None
        r_outputs: Optional[float] = None
        if reward_info:
            sub = reward_info.get("info") if isinstance(reward_info, dict) else None
            if sub:
                if "r_actions" in sub:
                    r_actions = float(sub["r_actions"])
                if "r_outputs" in sub:
                    r_outputs = float(sub["r_outputs"])

        # LLM judge — only consulted when outputs are required. A judge-LLM
        # failure raises out of here (JudgeUnavailableError) unless the
        # operator opted into the heuristic degrade, which is recorded
        # per-trial so degraded verdicts stay visible in report.json.
        judge_passed: Optional[bool] = None
        judge_expl = ""
        judge_mode: Optional[str] = None
        judge_degraded = False
        outputs_required = list(task.outputs or [])
        if outputs_required:
            agent_messages = self._extract_agent_messages(run.messages)
            judge = judge_outputs_satisfied(
                outputs=outputs_required,
                agent_messages=agent_messages,
                model=self.config.judge_model,
                provider=self.config.judge_provider,
                use_llm=self.config.use_llm_judge,
                allow_heuristic_fallback=self.config.judge_allow_heuristic_fallback,
            )
            judge_passed = judge.satisfied
            judge_expl = judge.explanation
            judge_mode = judge.mode
            judge_degraded = judge.degraded

        # Final success: upstream reward + (if outputs present) judge pass.
        success = run.reward >= 1.0
        if outputs_required and judge_passed is not None:
            # Replace the brittle substring check with the judge result.
            # Reward goes to 1.0 iff actions match AND judge_passed.
            if r_actions is not None and r_actions >= 1.0 and judge_passed:
                success = True
            elif r_actions is not None and r_actions < 1.0:
                success = False
            else:
                success = bool(judge_passed and run.reward >= 1.0)

        user_cost = 0.0
        ri = run.info.get("user_cost") if isinstance(run.info, dict) else None
        if isinstance(ri, (int, float)):
            user_cost = float(ri)

        return TaskRunResult(
            task_id=task_index,
            trial=trial,
            domain=domain,
            reward=float(run.reward),
            success=bool(success),
            scenario_id=scenario_id,
            scenario_note=scenario_note,
            judge_passed=judge_passed,
            judge_explanation=judge_expl,
            judge_mode=judge_mode,
            judge_degraded=judge_degraded,
            r_actions=r_actions,
            r_outputs=r_outputs,
            num_turns=run.num_turns,
            num_tool_calls=run.num_tool_calls,
            user_cost=user_cost,
            agent_cost=run.agent_cost,
            error=run.error,
            messages=run.messages,
            info={"reward_info": reward_info} if reward_info else {},
        )

    # --- Public API ------------------------------------------------------

    def run(self) -> BenchmarkReport:
        previous_data_mode = os.environ.get("TAU_BENCH_DATA_MODE")
        if self.config.use_sample_tasks:
            os.environ["TAU_BENCH_DATA_MODE"] = "smoke"
        if self.config.use_sample_tasks:
            task_iter = iter_sample_tasks(
                self.config.domains,
                self.config.task_split,
                task_ids=self.config.task_ids,
                start_index=self.config.start_index,
                end_index=self.config.end_index,
                max_per_domain=self.config.max_tasks_per_domain,
            )
        else:
            task_iter = iter_tasks(
                domains=self.config.domains,
                split=self.config.task_split,
                task_ids=self.config.task_ids,
                start_index=self.config.start_index,
                end_index=self.config.end_index,
                max_per_domain=self.config.max_tasks_per_domain,
            )
        try:
            base_task_list = list(task_iter)
            validation_errors = validate_task_items(
                base_task_list,
                include_edge_scenarios=self.config.include_edge_scenarios,
            )
            if validation_errors:
                raise ValueError(
                    "invalid tau-bench task selection: " + "; ".join(validation_errors)
                )
            if (
                not self.config.use_sample_tasks
                and self.config.task_split == "test"
                and self.config.task_ids is None
                and self.config.start_index == 0
                and self.config.end_index == -1
                and self.config.max_tasks_per_domain is None
            ):
                actual_by_domain = {
                    domain: sum(1 for selected, _, _ in base_task_list if selected == domain)
                    for domain in self.config.domains
                }
                expected_by_domain = {
                    domain: OFFICIAL_TEST_TASK_COUNTS[domain]
                    for domain in self.config.domains
                }
                if actual_by_domain != expected_by_domain:
                    raise RuntimeError(
                        "official tau-bench test corpus count mismatch: "
                        f"expected={expected_by_domain}, actual={actual_by_domain}"
                    )
            task_list = (
                expand_task_items(base_task_list)
                if self.config.include_edge_scenarios
                else [(domain, idx, task, "base", "") for domain, idx, task in base_task_list]
            )
            if not task_list:
                raise ValueError("No tasks selected — check --domains / --task-ids / --split")

            expected_keys = [
                (domain, task_index, scenario_id, trial)
                for domain, task_index, _task, scenario_id, _note in task_list
                for trial in range(self.config.num_trials)
            ]
            if len(set(expected_keys)) != len(expected_keys):
                raise ValueError("tau-bench workload contains duplicate rollout identities")

            agent = self._make_agent()

            results: list[TaskRunResult] = []
            domain_results: dict[str, list[TaskRunResult]] = {}
            start_ts = time.time()
            total = len(expected_keys)
            logger.info(
                "Running tau-bench: %d tasks × %d trials = %d rollouts",
                len(task_list),
                self.config.num_trials,
                total,
            )

            done = 0
            for domain, task_index, task, scenario_id, scenario_note in task_list:
                for trial in range(self.config.num_trials):
                    r = self._run_trial(
                        domain,
                        task_index,
                        task,
                        trial,
                        agent,
                        scenario_id,
                        scenario_note,
                    )
                    results.append(r)
                    domain_results.setdefault(domain, []).append(r)
                    done += 1
                    logger.info(
                        "[%d/%d] %s#%d trial=%d reward=%.2f success=%s",
                        done,
                        total,
                        domain,
                        task_index,
                        trial,
                        r.reward,
                        r.success,
                    )

            completed_keys = [
                (result.domain, result.task_id, result.scenario_id, result.trial)
                for result in results
            ]
            if completed_keys != expected_keys:
                raise RuntimeError(
                    "tau-bench completed rollouts do not match the scheduled workload"
                )
            for result in results:
                if result.error is not None:
                    raise RuntimeError(
                        "tau-bench workload contains a failed rollout: "
                        f"{result.domain}#{result.task_id}/{result.scenario_id}/"
                        f"trial-{result.trial}: {result.error}"
                    )
                if not math.isfinite(result.reward) or not 0 <= result.reward <= 1:
                    raise ValueError(
                        "tau-bench workload contains an invalid reward: "
                        f"{result.reward!r}"
                    )

            # Pass^k aggregation
            pass_k: dict[int, PassKResult] = {}
            for k in self.config.pass_k_values:
                pk, num_tasks = calculate_pass_hat_k(results, k)
                pass_k[k] = PassKResult(k=k, num_tasks=num_tasks, pass_hat_k=pk)

            avg_reward = sum(r.reward for r in results) / len(results)

            report = BenchmarkReport(
                config=self.config,
                results=results,
                pass_k=pass_k,
                avg_reward=avg_reward,
                num_tasks=len(task_list),
                num_trials_per_task=self.config.num_trials,
                data_provenance=data_provenance(self.config.domains),
                scenario_counts=count_task_items(
                    base_task_list,
                    include_edge_scenarios=self.config.include_edge_scenarios,
                ),
                complete=True,
                expected_rollouts=len(expected_keys),
                completed_rollouts=len(completed_keys),
                workload_sha256=_workload_sha256(task_list, self.config),
                domain_results=domain_results,
            )

            # Persist
            self._save_report(report)
            elapsed = time.time() - start_ts
            logger.info("Done in %.1fs. Avg reward=%.3f", elapsed, avg_reward)
            return report
        finally:
            if previous_data_mode is None:
                os.environ.pop("TAU_BENCH_DATA_MODE", None)
            else:
                os.environ["TAU_BENCH_DATA_MODE"] = previous_data_mode

    def _save_report(self, report: BenchmarkReport) -> None:
        if (
            not report.complete
            or report.expected_rollouts <= 0
            or report.completed_rollouts != report.expected_rollouts
            or len(report.results) != report.expected_rollouts
            or any(result.error is not None for result in report.results)
            or len(report.workload_sha256) != 64
        ):
            raise RuntimeError(
                "refusing to publish incomplete or unprovenanced tau-bench report"
            )
        out_dir = Path(self.config.output_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "report.json").write_text(
            json.dumps(report.to_dict(), indent=2, default=str), encoding="utf-8"
        )
        # Detailed trajectories
        trajectories = [
            {
                "domain": r.domain,
                "task_id": r.task_id,
                "trial": r.trial,
                "scenario_id": r.scenario_id,
                "scenario_note": r.scenario_note,
                "reward": r.reward,
                "success": r.success,
                "messages": r.messages,
            }
            for r in report.results
        ]
        (out_dir / "trajectories.json").write_text(
            json.dumps(trajectories, indent=2, default=str), encoding="utf-8"
        )


__all__ = ["TauBenchRunner"]
