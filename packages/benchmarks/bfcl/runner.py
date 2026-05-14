"""
BFCL Benchmark Runner

Main runner that orchestrates BFCL benchmark execution.

Routes each test case to the appropriate evaluation path:
  * Single-turn (simple/multiple/parallel/parallel_multiple/relevance/...):
    AST evaluator scores the predicted vs. expected calls.
  * Multi-turn (multi_turn_*):
    Per-turn loop that feeds tool results back into the agent, then executes
    both the model and ground-truth trajectories against fresh upstream tool
    instances and compares state via ``ExecutionEvaluator.evaluate_multi_turn``.
  * Agentic / network-gated (web_search_*, REST):
    Marked ``SKIPPED_NO_CREDENTIALS`` unless ``BFCLConfig.enable_network`` is
    True. When skipped, they're excluded from the accuracy denominator with
    a logged warning, and reported in the ``skipped_by_reason`` bucket.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Optional

from benchmarks.bfcl.agent import BFCLAgent, MockBFCLAgent
from benchmarks.bfcl.dataset import BFCLDataset
from benchmarks.bfcl.evaluators import ASTEvaluator, ExecutionEvaluator, RelevanceEvaluator
from benchmarks.bfcl.executable_runtime import (
    MEMORY_PREREQ_CONVERSATION_PATH,
    RuntimeNetworkRequired,
    decode_python_calls,
)
from benchmarks.bfcl.metrics import MetricsCalculator
from benchmarks.bfcl.reporting import BFCLReporter
from benchmarks.bfcl.types import (
    BFCLBenchmarkResults,
    BFCLCategory,
    BFCLConfig,
    BFCLResult,
    BFCLTestCase,
    MEMORY_CATEGORIES,
    MULTI_TURN_CATEGORIES,
    NETWORK_REQUIRED_CATEGORIES,
    TestStatus,
)

logger = logging.getLogger(__name__)


class BFCLRunner:
    """Main benchmark runner for BFCL.

    Orchestrates:
      - Dataset loading
      - Agent initialization
      - Test execution (single-turn, multi-turn, agentic — with proper gating)
      - Evaluation (AST, executable runtime, relevance detection)
      - Metrics calculation
      - Report generation

    Default model: Groq openai/gpt-oss-120b. Override with provider/model
    args or BFCL_PROVIDER/BFCL_MODEL env vars.
    """

    def __init__(
        self,
        config: BFCLConfig,
        agent: Optional[BFCLAgent] = None,
        use_mock_agent: bool = False,
        provider: Optional[str] = None,
        model: Optional[str] = None,
    ):
        self.config = config
        self.dataset = BFCLDataset(config)
        self.ast_evaluator = ASTEvaluator()
        self.exec_evaluator = ExecutionEvaluator(enable_network=config.enable_network)
        self.relevance_evaluator = RelevanceEvaluator()
        self.metrics_calculator = MetricsCalculator()
        self.reporter = BFCLReporter(config)

        harness = (
            os.environ.get("BENCHMARK_HARNESS")
            or os.environ.get("BENCHMARK_AGENT")
            or ""
        ).strip().lower()
        effective_provider = (
            harness
            if harness in {"hermes", "openclaw"} and provider == "eliza"
            else provider
        )

        if use_mock_agent:
            self.agent: BFCLAgent | MockBFCLAgent = MockBFCLAgent(config)
            self._model_name: Optional[str] = "mock"
        elif agent:
            self.agent = agent
            self._model_name = getattr(agent, "model_name", None)
        elif effective_provider == "hermes":
            import sys
            from pathlib import Path

            adapter_path = Path(__file__).resolve().parents[1] / "hermes-adapter"
            if adapter_path.exists() and str(adapter_path) not in sys.path:
                sys.path.insert(0, str(adapter_path))
            from hermes_adapter.bfcl import HermesBFCLAgent

            self.agent = HermesBFCLAgent(model_name=model)
            self._model_name = model or self.agent.model_name
        elif effective_provider == "openclaw":
            import sys
            from pathlib import Path

            adapter_path = Path(__file__).resolve().parents[1] / "openclaw-adapter"
            if adapter_path.exists() and str(adapter_path) not in sys.path:
                sys.path.insert(0, str(adapter_path))
            from openclaw_adapter.bfcl import OpenClawBFCLAgent

            self.agent = OpenClawBFCLAgent(model_name=model)
            self._model_name = model or self.agent.model_name
        elif effective_provider == "eliza":
            import sys
            from pathlib import Path

            adapter_path = Path(__file__).resolve().parents[1] / "eliza-adapter"
            if adapter_path.exists() and str(adapter_path) not in sys.path:
                sys.path.insert(0, str(adapter_path))
            from eliza_adapter.bfcl import ElizaBFCLAgent
            from eliza_adapter.client import ElizaClient
            self.agent = ElizaBFCLAgent(client=ElizaClient(), model_name=model or "eliza-ts-bridge")
            self._model_name = model or "eliza-ts-bridge"
        else:
            self.agent = BFCLAgent(config, provider=provider, model=model)
            self._model_name = None

        self._results: list[BFCLResult] = []
        self._provider = effective_provider
        self._model = model

    async def run(self) -> BFCLBenchmarkResults:
        """Run the full BFCL benchmark."""
        start_time = time.time()
        logger.info("Starting BFCL benchmark...")

        try:
            await self._initialize()

            await self.dataset.load()
            logger.info(f"Loaded {len(self.dataset)} test cases")

            stats = self.dataset.get_statistics()
            logger.info(f"Dataset statistics: {stats}")

            self._results = await self._run_all_tests()

            metrics = self.metrics_calculator.calculate(self._results)
            baseline_comparison = self.metrics_calculator.compare_to_baselines(metrics)
            summary = self._generate_summary(metrics, baseline_comparison)

            if hasattr(self.agent, "model_name"):
                self._model_name = self.agent.model_name

            duration_ms = (time.time() - start_time) * 1000
            results = BFCLBenchmarkResults(
                metadata={
                    "benchmark": "BFCL",
                    "version": self.config.version,
                    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "duration_ms": duration_ms,
                    "total_tests": len(self._results),
                    "model": self._model_name or "unknown",
                    "enable_network": self.config.enable_network,
                },
                config=self.config,
                metrics=metrics,
                results=self._results,
                baseline_comparison=baseline_comparison,
                summary=summary,
                model_name=self._model_name,
                provider=self._provider,
            )

            if self.config.generate_report:
                await self.reporter.generate_report(results)

            logger.info(
                f"BFCL benchmark completed in {duration_ms:.2f}ms. "
                f"Overall score: {metrics.overall_score:.2%}"
            )

            return results

        finally:
            await self._cleanup()

    async def _initialize(self) -> None:
        """Initialize runner components."""
        await self.agent.initialize()

        if hasattr(self.agent, "model_name") and self.agent.model_name:
            self._model_name = self.agent.model_name

        # NOTE: The previous runner called `exec_evaluator.setup_standard_mocks()`
        # which auto-registered always-success handlers. That behaviour has been
        # removed. The exec evaluator now drives the real upstream runtime for
        # multi-turn categories, and other categories report a skipped status.

    async def _cleanup(self) -> None:
        """Clean up resources and export trajectories."""
        if hasattr(self.agent, "export_trajectories") and hasattr(self.agent, "get_trajectories"):
            trajectories = self.agent.get_trajectories()
            logger.debug(f"Trajectories available for export: {len(trajectories) if trajectories else 0}")
            if trajectories:
                output_dir = self.config.output_dir or "benchmark_results/bfcl"
                os.makedirs(output_dir, exist_ok=True)

                timestamp = time.strftime("%Y%m%d_%H%M%S")
                model_suffix = (self._model_name or "unknown").replace("/", "_").replace(".", "-")
                traj_dir = os.path.join(output_dir, "trajectories")
                os.makedirs(traj_dir, exist_ok=True)

                art_path = os.path.join(traj_dir, f"bfcl_art_{model_suffix}_{timestamp}.jsonl")
                grpo_path = os.path.join(traj_dir, f"bfcl_grpo_{model_suffix}_{timestamp}.json")
                jsonl_path = os.path.join(traj_dir, f"bfcl_raw_{model_suffix}_{timestamp}.jsonl")

                exported_any = False
                try:
                    export_path = self.agent.export_trajectories(art_path, format="art")
                    if export_path:
                        exported_any = True
                        logger.info(f"Exported BFCL ART trajectories to {export_path}")
                except Exception:
                    pass
                try:
                    export_path = self.agent.export_trajectories(grpo_path, format="grpo")
                    if export_path:
                        exported_any = True
                        logger.info(f"Exported BFCL GRPO trajectories to {export_path}")
                except Exception:
                    pass

                if not exported_any:
                    export_path = self.agent.export_trajectories(jsonl_path, format="jsonl")
                    if export_path:
                        logger.info(f"Exported {len(trajectories)} raw trajectories to {export_path}")
                    else:
                        logger.warning("Trajectory export returned None")
            else:
                logger.debug("No trajectories to export")
        else:
            logger.debug("Agent does not support trajectory export")

        await self.agent.close()

    async def _run_all_tests(self) -> list[BFCLResult]:
        """Run all test cases."""
        results: list[BFCLResult] = []
        total = len(self.dataset)

        for i, test_case in enumerate(self.dataset):
            logger.debug(f"Running test {i + 1}/{total}: {test_case.id}")

            try:
                result = await self._run_single_test(test_case)
                results.append(result)

                if (i + 1) % 10 == 0:
                    logger.info(f"Progress: {i + 1}/{total} tests completed")

            except Exception as e:
                logger.error(f"Test {test_case.id} failed with error: {e}")
                results.append(BFCLResult(
                    test_case_id=test_case.id,
                    category=test_case.category,
                    predicted_calls=[],
                    expected_calls=test_case.expected_calls,
                    ast_match=False,
                    exec_success=False,
                    relevance_correct=False,
                    latency_ms=0,
                    error=str(e),
                    status=TestStatus.ERROR,
                ))

        return results

    # ------------------------------------------------------------------
    # Per-test dispatch
    # ------------------------------------------------------------------
    async def _run_single_test(self, test_case: BFCLTestCase) -> BFCLResult:
        """Dispatch a test to the correct evaluation path."""
        cat = test_case.category

        # 1) Network-gated categories (without enable_network)
        if cat in NETWORK_REQUIRED_CATEGORIES and not self.config.enable_network:
            return self._skip(
                test_case,
                TestStatus.SKIPPED_NO_CREDENTIALS,
                f"Category {cat.value} requires --enable-network",
            )

        # 2) Memory categories — drive the snapshot-backed runtime and
        # agentic_checker. Vector + rec_sum need optional deps; missing
        # deps surface as SKIPPED_UNSUPPORTED via the eval path.
        if cat in MEMORY_CATEGORIES:
            return await self._run_memory_test(test_case)

        # 3) REST API with enable_network — actually hit the endpoint.
        if cat == BFCLCategory.REST_API and self.config.enable_network:
            return await self._run_rest_test(test_case)

        # 4) Multi-turn
        if cat in MULTI_TURN_CATEGORIES:
            return await self._run_multi_turn(test_case)

        # 5) Single-turn (incl. web_search if --enable-network was set,
        # though in practice the model just sees the question text).
        return await self._run_single_turn(test_case)

    def _skip(
        self,
        test_case: BFCLTestCase,
        status: TestStatus,
        reason: str,
    ) -> BFCLResult:
        logger.info("SKIP %s: %s", test_case.id, reason)
        return BFCLResult(
            test_case_id=test_case.id,
            category=test_case.category,
            predicted_calls=[],
            expected_calls=test_case.expected_calls,
            ast_match=False,
            exec_success=False,
            relevance_correct=False,
            latency_ms=0,
            error=reason,
            status=status,
            details={"skip_reason": reason},
        )

    # ------------------------------------------------------------------
    # Single-turn evaluation
    # ------------------------------------------------------------------
    async def _run_single_turn(self, test_case: BFCLTestCase) -> BFCLResult:
        """Run a single-turn test case."""
        predicted_calls, raw_response, latency_ms = await self.agent.query(test_case)

        # Tests without ground truth → SKIPPED_NO_GROUND_TRUTH (not silently
        # passed/failed). This includes REST_API entries with no expected calls.
        if not test_case.has_ground_truth:
            return self._skip(
                test_case,
                TestStatus.SKIPPED_NO_GROUND_TRUTH,
                "No ground truth available for this test case",
            )

        ast_match = False
        if self.config.run_ast_eval:
            ast_match = self.ast_evaluator.evaluate(
                predicted_calls,
                test_case.expected_calls,
                function_defs=test_case.functions,
            )

        # Single-turn categories aren't executable-evaluated in upstream BFCL
        # either — AST equality is the canonical signal. We keep exec_success
        # equal to ast_match for back-compat with reporting, since the model
        # made the call.
        exec_success = ast_match

        relevance_correct = True
        if self.config.run_relevance_eval:
            relevance_correct = self.relevance_evaluator.evaluate(
                predicted_calls,
                test_case.is_relevant,
                raw_response,
            )

        details = self.ast_evaluator.get_match_details(
            predicted_calls,
            test_case.expected_calls,
        )

        if hasattr(self.agent, "update_trajectory_reward"):
            reward = 0.0
            if ast_match:
                reward += 0.5
            if exec_success:
                reward += 0.3
            if relevance_correct:
                reward += 0.2
            self.agent.update_trajectory_reward(
                test_case.id,
                reward=reward,
                ast_match=ast_match,
                exec_match=exec_success,
            )

        return BFCLResult(
            test_case_id=test_case.id,
            category=test_case.category,
            predicted_calls=predicted_calls,
            expected_calls=test_case.expected_calls,
            ast_match=ast_match,
            exec_success=exec_success,
            relevance_correct=relevance_correct,
            latency_ms=latency_ms,
            raw_response=raw_response if self.config.save_raw_responses else None,
            details=details,
            status=TestStatus.PASSED if ast_match else TestStatus.FAILED,
        )

    # ------------------------------------------------------------------
    # Multi-turn evaluation
    # ------------------------------------------------------------------
    async def _run_multi_turn(self, test_case: BFCLTestCase) -> BFCLResult:
        """Run a multi-turn test by looping per-turn, feeding tool results
        back into the agent, then score by executing both trajectories
        against fresh upstream tool instances and comparing state.
        """
        if not test_case.turns:
            return self._skip(
                test_case,
                TestStatus.SKIPPED_NO_GROUND_TRUTH,
                "Multi-turn entry has no turns",
            )
        if not test_case.multi_turn_ground_truth:
            return self._skip(
                test_case,
                TestStatus.SKIPPED_NO_GROUND_TRUTH,
                "Multi-turn entry has no ground truth trajectory",
            )
        if not test_case.involved_classes or test_case.initial_config is None:
            return self._skip(
                test_case,
                TestStatus.SKIPPED_UNSUPPORTED,
                "Multi-turn entry missing involved_classes/initial_config",
            )

        # Drive the agent turn-by-turn. We synthesize a single-turn-shaped
        # BFCLTestCase per turn so the existing agent.query interface works.
        from benchmarks.bfcl.types import BFCLTestCase as _TC

        long_context = test_case.category == BFCLCategory.MULTI_TURN_LONG_CONTEXT

        predicted_per_turn: list[list[str]] = []
        total_latency_ms = 0.0
        raw_responses: list[str] = []

        for turn_idx, turn_messages in enumerate(test_case.turns):
            user_msgs = [m["content"] for m in turn_messages if m.get("role") == "user"]
            turn_prompt = "\n".join(user_msgs) if user_msgs else ""

            # Inject a step-budget hint so models know they may emit a list
            # of python calls. We keep the prompt close to upstream's
            # serialized-list convention.
            per_turn_tc = _TC(
                id=f"{test_case.id}::turn{turn_idx}",
                category=test_case.category,
                question=turn_prompt,
                functions=test_case.functions,
                expected_calls=[],
                language=test_case.language,
                has_ground_truth=False,
                turns=None,
                involved_classes=test_case.involved_classes,
                initial_config=test_case.initial_config,
            )

            _calls, raw_response, latency_ms = await self.agent.query(per_turn_tc)
            total_latency_ms += latency_ms
            raw_responses.append(raw_response)

            turn_calls: list[str] = []
            # Models may produce a python-list-of-calls (BFCL canonical),
            # JSON tool calls, or just text — try the python-list form first
            # since multi-turn is upstream-canonical that way.
            python_calls = decode_python_calls(raw_response)
            if python_calls:
                turn_calls = python_calls
            else:
                # Fall back to JSON-style: produce "ClassName.method(...)"
                # invocations from FunctionCall objects.
                for fc in _calls:
                    args_repr = ", ".join(f"{k}={v!r}" for k, v in fc.arguments.items())
                    turn_calls.append(f"{fc.name}({args_repr})")

            # Cap per-turn step count (defense against runaway loops).
            turn_calls = turn_calls[: max(1, self.config.max_multi_turn_steps)]
            predicted_per_turn.append(turn_calls)

        # Score by executing both trajectories against fresh runtimes.
        try:
            exec_success, exec_details = self.exec_evaluator.evaluate_multi_turn(
                predicted_per_turn=predicted_per_turn,
                ground_truth_per_turn=test_case.multi_turn_ground_truth,
                involved_classes=test_case.involved_classes,
                initial_config=test_case.initial_config,
                long_context=long_context,
            )
        except RuntimeNetworkRequired as e:
            return self._skip(
                test_case,
                TestStatus.SKIPPED_NO_CREDENTIALS,
                f"Multi-turn entry requires network: {e}",
            )
        except Exception as e:
            logger.error("Multi-turn exec failed for %s: %s", test_case.id, e)
            return BFCLResult(
                test_case_id=test_case.id,
                category=test_case.category,
                predicted_calls=[],
                expected_calls=test_case.expected_calls,
                ast_match=False,
                exec_success=False,
                relevance_correct=False,
                latency_ms=total_latency_ms,
                raw_response="\n---\n".join(raw_responses) if self.config.save_raw_responses else None,
                details={"exec_error": str(e)},
                error=str(e),
                status=TestStatus.ERROR,
            )

        details: dict[str, object] = {
            "predicted_turns": [list(t) for t in predicted_per_turn],
            "ground_truth_turns": [list(t) for t in test_case.multi_turn_ground_truth],
        }
        details.update(exec_details)

        return BFCLResult(
            test_case_id=test_case.id,
            category=test_case.category,
            predicted_calls=test_case.expected_calls,  # not used for MT
            expected_calls=test_case.expected_calls,
            ast_match=exec_success,
            exec_success=exec_success,
            relevance_correct=True,
            latency_ms=total_latency_ms,
            raw_response="\n---\n".join(raw_responses) if self.config.save_raw_responses else None,
            details=details,  # type: ignore[arg-type]
            status=TestStatus.PASSED if exec_success else TestStatus.FAILED,
        )

    # ------------------------------------------------------------------
    # Memory evaluation
    # ------------------------------------------------------------------
    async def _run_memory_test(self, test_case: BFCLTestCase) -> BFCLResult:
        """Drive a memory test against the snapshot-backed runtime.

        Strategy:
          * Load the matching prereq fixture (memory_<scenario>.json) and
            extract the user-content strings as ``prereq_messages`` — these
            seed the memory backend with realistic state.
          * Ask the agent the test question (single user turn).
          * Pull out python-list-of-calls from the response (if any) and
            execute them against the runtime.
          * Score the response with agentic_checker against the
            ``possible_answers`` extracted from the test case metadata or
            ground truth.
        """
        from benchmarks.bfcl.executable_runtime import extract_memory_backend_type

        cat_name = test_case.category.value
        try:
            backend = extract_memory_backend_type(cat_name)
        except ValueError:
            return self._skip(
                test_case,
                TestStatus.SKIPPED_UNSUPPORTED,
                f"Cannot extract memory backend from {cat_name}",
            )

        possible_answers = self._extract_memory_possible_answers(test_case)
        if not possible_answers:
            return self._skip(
                test_case,
                TestStatus.SKIPPED_NO_GROUND_TRUTH,
                "Memory test has no possible_answer ground truth",
            )

        scenario = self._extract_memory_scenario(test_case)
        prereq_msgs = self._load_memory_prereq_messages(scenario)

        predicted_calls, raw_response, latency_ms = await self.agent.query(test_case)

        tool_calls = decode_python_calls(raw_response)
        if not tool_calls:
            for fc in predicted_calls:
                args_repr = ", ".join(f"{k}={v!r}" for k, v in fc.arguments.items())
                tool_calls.append(f"{fc.name}({args_repr})")

        try:
            passed, details = self.exec_evaluator.evaluate_memory(
                backend=backend,
                scenario=scenario or "scenario",
                test_id=test_case.id,
                prereq_messages=prereq_msgs,
                agent_tool_calls=tool_calls,
                agent_final_response=raw_response,
                possible_answers=possible_answers,
            )
        except Exception as e:
            logger.error("Memory eval failed for %s: %s", test_case.id, e)
            return BFCLResult(
                test_case_id=test_case.id,
                category=test_case.category,
                predicted_calls=predicted_calls,
                expected_calls=test_case.expected_calls,
                ast_match=False,
                exec_success=False,
                relevance_correct=False,
                latency_ms=latency_ms,
                error=str(e),
                status=TestStatus.ERROR,
            )

        # If the runtime init failed because of missing optional deps,
        # bucket as SKIPPED_UNSUPPORTED instead of FAILED.
        err = str(details.get("error") or "")
        if "optional ML deps" in err or "requires optional" in err:
            return self._skip(
                test_case,
                TestStatus.SKIPPED_UNSUPPORTED,
                err,
            )

        return BFCLResult(
            test_case_id=test_case.id,
            category=test_case.category,
            predicted_calls=predicted_calls,
            expected_calls=test_case.expected_calls,
            ast_match=passed,
            exec_success=passed,
            relevance_correct=True,
            latency_ms=latency_ms,
            raw_response=raw_response if self.config.save_raw_responses else None,
            details=details,  # type: ignore[arg-type]
            status=TestStatus.PASSED if passed else TestStatus.FAILED,
        )

    def _extract_memory_possible_answers(
        self, test_case: BFCLTestCase
    ) -> list[str]:
        """Pull possible answers out of the dataset's ground-truth payload.

        Upstream memory ground truth is a flat list of acceptable
        substrings stored in ``possible_answer/<file>.json`` under
        ``ground_truth``. The dataset loader keeps the raw payload on
        ``_ground_truth[test_id]`` — we handle the common shapes here.
        """
        gt = self.dataset._ground_truth.get(test_case.id)
        if gt is None:
            md = test_case.metadata or {}
            gt = md.get("possible_answer") or md.get("ground_truth")
        if gt is None:
            return []
        if isinstance(gt, str):
            return [gt]
        if isinstance(gt, list):
            flat: list[str] = []
            for x in gt:
                if isinstance(x, str):
                    flat.append(x)
                elif isinstance(x, list):
                    flat.extend(str(y) for y in x)
            return flat
        return []

    def _extract_memory_scenario(self, test_case: BFCLTestCase) -> str:
        """Memory test ids look like ``memory_kv_0-finance-2`` — the
        middle segment is the scenario name. Fall back to a metadata
        ``scenario`` field if the id doesn't parse."""
        md_scenario = (test_case.metadata or {}).get("scenario")
        if isinstance(md_scenario, str) and md_scenario:
            return md_scenario
        parts = test_case.id.split("-")
        if len(parts) >= 2:
            return parts[1]
        return ""

    def _load_memory_prereq_messages(self, scenario: str) -> list[str]:
        """Read the prereq conversation fixture for ``scenario`` and flatten
        its user-content strings into a single list. Returns an empty list
        if the fixture isn't present."""
        if not scenario:
            return []
        path = MEMORY_PREREQ_CONVERSATION_PATH / f"memory_{scenario}.json"
        if not path.exists():
            return []

        messages: list[str] = []
        with path.open("r", encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                entry = json.loads(line)
                for turn in entry.get("question", []):
                    for message in turn:
                        if message.get("role") == "user":
                            content = message.get("content")
                            if isinstance(content, str):
                                messages.append(content)
        return messages
