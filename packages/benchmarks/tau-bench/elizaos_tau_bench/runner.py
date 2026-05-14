"""Benchmark runner.

Wires the vendored upstream ``Env`` (which already contains the LLM-driven
user simulator) to an ElizaOS agent, runs each task ``num_trials`` times,
applies the LLM judge to gate ``task.outputs``, and computes pass^k.

This replaces the previous handwritten environments + executor pipeline.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Optional

from elizaos_tau_bench.dataset import iter_sample_tasks, iter_tasks
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
    RESPOND_ACTION_NAME,
    Task,
    TaskRunResult,
    TauBenchConfig,
)
from elizaos_tau_bench.upstream.envs import get_env
from elizaos_tau_bench.upstream.envs.base import Env

logger = logging.getLogger(__name__)


class TauBenchRunner:
    """Orchestrates evaluation of a set of tasks across trials."""

    def __init__(self, config: TauBenchConfig) -> None:
        self.config = config

    # --- Env construction -------------------------------------------------

    def _make_env(self, domain: DomainName, task_index: int) -> Env:
        return get_env(
            env_name=domain,
            user_strategy=self.config.user_strategy,
            user_model=self.config.user_model,
            user_provider=self.config.user_provider,
            task_split=self.config.task_split,
            task_index=task_index,
        )

    def _make_agent(self) -> BaseTauAgent:
        if self.config.use_mock:
            return MockTauAgent()
        return LiteLLMToolCallingAgent(
            model=self.config.agent_model,
            provider=self.config.agent_provider,
            temperature=self.config.agent_temperature,
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
    ) -> TaskRunResult:
        try:
            env = self._make_env(domain, task_index)
        except Exception as e:
            logger.exception("Failed to construct env for %s task %d", domain, task_index)
            return TaskRunResult(
                task_id=task_index,
                trial=trial,
                domain=domain,
                reward=0.0,
                success=False,
                error=f"env_init: {e}",
            )

        run: AgentRunResult = agent.solve(
            env=env, task_index=task_index, max_num_steps=self.config.agent_max_turns
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

        # LLM judge — only consulted when outputs are required.
        judge_passed: Optional[bool] = None
        judge_expl = ""
        outputs_required = list(task.outputs or [])
        if outputs_required:
            agent_messages = self._extract_agent_messages(run.messages)
            judge = judge_outputs_satisfied(
                outputs=outputs_required,
                agent_messages=agent_messages,
                model=self.config.judge_model,
                provider=self.config.judge_provider,
                use_llm=self.config.use_llm_judge,
            )
            judge_passed = judge.satisfied
            judge_expl = judge.explanation

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
            judge_passed=judge_passed,
            judge_explanation=judge_expl,
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
        if self.config.use_sample_tasks:
            task_iter = iter_sample_tasks(self.config.domains, self.config.task_split)
        else:
            task_iter = iter_tasks(
                domains=self.config.domains,
                split=self.config.task_split,
                task_ids=self.config.task_ids,
                start_index=self.config.start_index,
                end_index=self.config.end_index,
                max_per_domain=self.config.max_tasks_per_domain,
            )
        task_list = list(task_iter)
        if not task_list:
            raise ValueError("No tasks selected — check --domains / --task-ids / --split")

        agent = self._make_agent()

        results: list[TaskRunResult] = []
        domain_results: dict[str, list[TaskRunResult]] = {}
        start_ts = time.time()
        total = len(task_list) * self.config.num_trials
        logger.info(
            "Running tau-bench: %d tasks × %d trials = %d rollouts",
            len(task_list),
            self.config.num_trials,
            total,
        )

        done = 0
        for domain, task_index, task in task_list:
            for trial in range(self.config.num_trials):
                r = self._run_trial(domain, task_index, task, trial, agent)
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

        # Pass^k aggregation
        pass_k: dict[int, PassKResult] = {}
        for k in self.config.pass_k_values:
            pk, num_tasks = calculate_pass_hat_k(results, k)
            pass_k[k] = PassKResult(k=k, num_tasks=num_tasks, pass_hat_k=pk)

        avg_reward = sum(r.reward for r in results) / len(results) if results else 0.0

        report = BenchmarkReport(
            config=self.config,
            results=results,
            pass_k=pass_k,
            avg_reward=avg_reward,
            num_tasks=len(task_list),
            num_trials_per_task=self.config.num_trials,
            domain_results=domain_results,
        )

        # Persist
        self._save_report(report)
        elapsed = time.time() - start_ts
        logger.info("Done in %.1fs. Avg reward=%.3f", elapsed, avg_reward)
        return report

    def _save_report(self, report: BenchmarkReport) -> None:
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
