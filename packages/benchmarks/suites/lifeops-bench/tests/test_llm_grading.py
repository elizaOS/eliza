"""LLM-driven grading surfaces: structured judge verdicts, the STATIC wording
rubric, per-scenario soft kwargs, and deterministic RRULE equivalence.

The judge is deterministic-stubbed throughout (fixed-content mock clients), so
the PerfectAgent=1.0 / WrongAgent=0.0 invariants stay checkable without model
traffic while the real judge path (prompt → parse → enforce → trace → score)
is exercised end to end.
"""

from __future__ import annotations

import asyncio
import hashlib
from typing import Any

import pytest

from eliza_lifeops_bench import evaluator as evaluator_module
from eliza_lifeops_bench.clients.base import (
    BaseClient,
    ClientCall,
    ClientResponse,
    Usage,
)
from eliza_lifeops_bench.evaluator import (
    JudgeCriterionVerdict,
    JudgeVerdict,
    LifeOpsEvaluator,
    _enforce_criterion_citations,
    _parse_judge_verdict,
)
from eliza_lifeops_bench.scorer import (
    _kwargs_match,
    _parse_rrule,
    _values_equivalent,
    compare_actions,
    score_scenario,
)
from eliza_lifeops_bench.types import (
    Action,
    Domain,
    EvaluatorTraceEntry,
    MessageTurn,
    Persona,
    Scenario,
    ScenarioMode,
    ScenarioResult,
    TrustedActionPolicy,
    TrustedEvidenceRequirement,
    TurnResult,
)


_PERSONA = Persona(
    id="t",
    name="Tester",
    traits=["scripted"],
    background="fixture",
    communication_style="terse",
)


class _StubClient(BaseClient):
    """Returns fixed content for every call; counts calls for ledger checks."""

    def __init__(self, model_name: str, content: str) -> None:
        self.model_name = model_name
        self.content = content
        self.last_call: ClientCall | None = None

    async def complete(self, call: ClientCall) -> ClientResponse:
        self.last_call = call
        return ClientResponse(
            content=self.content,
            tool_calls=[],
            finish_reason="stop",
            usage=Usage(prompt_tokens=5, completion_tokens=5, total_tokens=10),
            latency_ms=1,
            cost_usd=0.003,
            raw_provider_response={},
        )


def _evaluator_with_judge(judge_content: str) -> LifeOpsEvaluator:
    return LifeOpsEvaluator(
        simulated_user_client=_StubClient("stub-sim", "ok"),
        judge_client=_StubClient("stub-judge", judge_content),
    )


def _scenario(
    *,
    mode: ScenarioMode = ScenarioMode.STATIC,
    ground_truth_actions: list[Action] | None = None,
    required_outputs: list[str] | None = None,
    static_rubric: list[str] | None = None,
    soft_kwargs: list[str] | None = None,
    success_criteria: list[str] | None = None,
    world_assertions: list[str] | None = None,
    trusted_evidence_requirement: TrustedEvidenceRequirement | None = None,
) -> Scenario:
    return Scenario(
        id="t_llm_grading",
        name="t",
        domain=Domain.CALENDAR,
        mode=mode,
        persona=_PERSONA,
        instruction="draft a friendly reply and schedule the recurring sync",
        ground_truth_actions=ground_truth_actions or [],
        required_outputs=required_outputs or [],
        first_question_fallback=None,
        world_seed=0,
        max_turns=4,
        success_criteria=success_criteria or [],
        world_assertions=world_assertions or [],
        trusted_evidence_requirement=trusted_evidence_requirement,
        static_rubric=static_rubric or [],
        soft_kwargs=soft_kwargs or [],
    )


def _result(
    *,
    state_hash_match: bool,
    agent_actions: list[Action],
    output_substring_matches: list[bool] | None = None,
    evaluator_trace: list[EvaluatorTraceEntry] | None = None,
    static_grading_mode: str = "semantic",
) -> ScenarioResult:
    return ScenarioResult(
        scenario_id="t_llm_grading",
        seed=0,
        static_grading_mode=static_grading_mode,  # type: ignore[arg-type]
        turns=[
            TurnResult(
                turn_number=1,
                agent_message="",
                agent_actions=agent_actions,
                user_response="",
                latency_ms=0,
                input_tokens=0,
                output_tokens=0,
                cost_usd=0.0,
            )
        ],
        state_hash_match=state_hash_match,
        output_substring_matches=output_substring_matches or [],
        total_score=0.0,
        max_score=1.0,
        terminated_reason="respond",
        total_cost_usd=0.0,
        total_latency_ms=0,
        evaluator_trace=evaluator_trace or [],
    )


def _semantic_trace_entry(
    criterion_verdicts: list[dict[str, Any]] | None,
    *,
    invalid: bool = False,
) -> EvaluatorTraceEntry:
    return EvaluatorTraceEntry(
        turn_number=1,
        role="judge",
        provider=None,
        model_name="stub-judge",
        input_messages=[],
        output_text="",
        finish_reason="stop",
        prompt_tokens=0,
        completion_tokens=0,
        total_tokens=0,
        latency_ms=0,
        cost_usd=None,
        raw_provider_response={},
        judge_kind="static_semantic",
        criterion_verdicts=criterion_verdicts,
        verdict_invalid=invalid,
    )


# ---------------------------------------------------------------------------
# Structured verdict parsing — malformed output is typed invalid, never a
# guessed boolean.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "content",
    [
        None,
        "",
        "the executor did great work",
        "YES: executor handled the request.",
        "[1, 2, 3]",
        '{"reason": "no satisfied key"}',
        '{"satisfied": true, "criteria": "not-a-list"}',
        '{"satisfied": true, "criteria": ["not-an-object"]}',
        '{"satisfied": true, "criteria": [{"met": true, "evidence": "x"}]}',
        '{"satisfied": true, "criteria": [{"id": "c1", "evidence": "x"}]}',
        '```json\n{"satisfied": true, "criteria": []}\n```',
        '{"verdict": true, "criteria": []}',
        '{"satisfied": "yes", "criteria": []}',
        '{"satisfied": false, "criteria": [{"id": "c1", "met": "no"}]}',
    ],
    ids=[
        "none",
        "empty",
        "prose",
        "legacy-yes-line",
        "json-array",
        "missing-satisfied",
        "criteria-not-list",
        "criterion-not-object",
        "criterion-missing-id",
        "criterion-missing-met",
        "fenced-json",
        "legacy-verdict-key",
        "string-satisfied",
        "string-met",
    ],
)
def test_parse_judge_verdict_malformed_is_typed_invalid(content: str | None) -> None:
    verdict = _parse_judge_verdict(content)
    assert isinstance(verdict, JudgeVerdict)
    assert verdict.invalid is True
    assert verdict.satisfied is False
    assert verdict.criteria == ()


def test_parse_judge_verdict_valid_structured_shape() -> None:
    verdict = _parse_judge_verdict(
        '{"criteria": [{"id": "c1", "met": true,'
        ' "evidence_line_id": "executor-1", "evidence": "done"},'
        ' {"id": "c2", "met": false, "evidence_line_id": "", "evidence": ""}],'
        ' "satisfied": false, "reason": "c2 unaddressed"}'
    )
    assert verdict.invalid is False
    assert verdict.satisfied is False
    assert verdict.reason == "c2 unaddressed"
    assert verdict.criteria == (
        JudgeCriterionVerdict(
            id="c1",
            met=True,
            evidence_line_id="executor-1",
            evidence="done",
        ),
        JudgeCriterionVerdict(
            id="c2",
            met=False,
            evidence_line_id="",
            evidence="",
        ),
    )


def test_enforce_criterion_citations_rejects_nonexact_id_multiset() -> None:
    parsed = _parse_judge_verdict(
        '{"criteria": ['
        '{"id": "c1", "met": true, "evidence_line_id": "executor-1",'
        ' "evidence": "sent it"},'
        '{"id": "c2", "met": true, "evidence_line_id": "user-1",'
        ' "evidence": "please do it"},'
        '{"id": "zz", "met": true, "evidence_line_id": "executor-1",'
        ' "evidence": "unknown id is dropped"}],'
        ' "satisfied": true, "reason": "all good"}'
    )
    enforced = _enforce_criterion_citations(
        parsed,
        [("c1", "one"), ("c2", "two"), ("c3", "three")],
        {"executor-1": "I sent it successfully."},
    )
    assert enforced.satisfied is False
    assert enforced.invalid is True
    assert enforced.criteria == ()
    assert "missing=['c3']" in enforced.reason
    assert "unexpected_or_duplicate=['zz']" in enforced.reason


@pytest.mark.parametrize(
    "criterion_ids",
    [
        ["c1", "c1"],
        ["c1", "unexpected"],
        [],
    ],
)
def test_enforce_criterion_citations_rejects_duplicate_extra_or_missing_ids(
    criterion_ids: list[str],
) -> None:
    criteria = ",".join(
        '{"id": "' + criterion_id + '", "met": false, "evidence": ""}'
        for criterion_id in criterion_ids
    )
    parsed = _parse_judge_verdict(
        '{"criteria": [' + criteria + '], "satisfied": false, "reason": "no"}'
    )
    enforced = _enforce_criterion_citations(
        parsed,
        [("c1", "one")],
        {"executor-1": "The operation is complete."},
    )
    assert enforced.invalid is True
    assert enforced.satisfied is False


def test_enforce_criterion_citations_passes_fully_cited_verdict() -> None:
    parsed = _parse_judge_verdict(
        '{"criteria": [{"id": "c1", "met": true,'
        ' "evidence_line_id": "tool-1", "evidence": "status is ok"}],'
        ' "satisfied": true, "reason": "done"}'
    )
    enforced = _enforce_criterion_citations(
        parsed,
        [("c1", "one")],
        {"tool-1": '{"status": "status is ok"}'},
    )
    assert enforced.satisfied is True
    assert enforced.reason == "done"


@pytest.mark.parametrize(
    ("line_id", "quote", "reason_fragment"),
    [
        ("user-1", "please send it", "unknown or ineligible evidence line"),
        ("executor-404", "sent it", "unknown or ineligible evidence line"),
        ("executor-1", "a result that was never said", "quote is absent"),
        ("executor-1", "the", "empty or too short"),
    ],
)
def test_enforce_criterion_citations_rejects_user_unknown_and_fabricated_quotes(
    line_id: str,
    quote: str,
    reason_fragment: str,
) -> None:
    parsed = _parse_judge_verdict(
        '{"criteria": [{"id": "c1", "met": true, '
        f'"evidence_line_id": "{line_id}", "evidence": "{quote}"}}], '
        '"satisfied": true, "reason": "claimed complete"}'
    )
    enforced = _enforce_criterion_citations(
        parsed,
        [("c1", "send it")],
        {"executor-1": "I sent it to the requested contact."},
    )
    assert enforced.satisfied is False
    assert enforced.criteria[0].met is False
    assert reason_fragment in enforced.reason


def test_enforce_criterion_citations_accepts_exact_terse_whole_line() -> None:
    parsed = _parse_judge_verdict(
        '{"criteria": [{"id": "c1", "met": true, '
        '"evidence_line_id": "executor-1", "evidence": "Done"}], '
        '"satisfied": true, "reason": "complete"}'
    )
    enforced = _enforce_criterion_citations(
        parsed,
        [("c1", "complete it")],
        {"executor-1": "Done"},
    )
    assert enforced.invalid is False
    assert enforced.satisfied is True


def test_transcript_line_ids_are_stable_and_user_lines_are_ineligible() -> None:
    evaluator = _evaluator_with_judge("{}")
    scenario = _scenario()
    history = [
        MessageTurn(role="user", content="please send it"),
        MessageTurn(role="assistant", content="I sent it"),
        MessageTurn(role="tool", name="MESSAGE", content='{"ok":true}'),
        MessageTurn(role="assistant", content="It is delivered"),
    ]

    rendered = evaluator._render_judge_transcript(scenario, history)
    evidence = evaluator._judge_evidence_lines(scenario, history)

    assert '"line_id": "user-1"' in rendered
    assert '"line_id": "executor-1"' in rendered
    assert '"line_id": "tool-1"' in rendered
    assert '"line_id": "executor-2"' in rendered
    assert "user-1" not in evidence
    assert evidence == {
        "executor-1": "I sent it",
        "tool-1": '{"ok":true}',
        "executor-2": "It is delivered",
    }


def test_untrusted_tool_payload_is_not_citable_for_evidence_gated_scenario() -> None:
    evaluator = _evaluator_with_judge("{}")
    scenario = _scenario(
        mode=ScenarioMode.LIVE,
        trusted_evidence_requirement=_requirement(),
    )
    history = [
        MessageTurn(role="assistant", content="I requested the source list."),
        MessageTurn(
            role="tool",
            name="CALENDAR_SOURCES",
            content='{"fabricated":"everything is connected"}',
        ),
    ]

    evidence = evaluator._judge_evidence_lines(scenario, history)
    assert evidence == {"executor-1": "I requested the source list."}


def test_simulated_user_never_receives_judge_only_expectations_or_earns_credit() -> (
    None
):
    from eliza_lifeops_bench.lifeworld import LifeWorld

    criterion = "SENTINEL_CRITERION executor preserves the consent boundary"
    assertion = "SENTINEL_ASSERTION no outbound provider mutation exists"
    required_output = "SENTINEL_OUTPUT explain the unresolved consent state"
    rubric = "SENTINEL_RUBRIC use policy-neutral language"
    sim = _StubClient("sim-model", criterion)
    judge = _StubClient(
        "judge-model",
        (
            '{"criteria": [{"id": "c1", "met": true, '
            '"evidence_line_id": "user-1", '
            f'"evidence": "{criterion}"}}], '
            '"satisfied": true, "reason": "the user repeated the criterion"}'
        ),
    )
    evaluator = LifeOpsEvaluator(sim, judge)
    scenario = _scenario(
        mode=ScenarioMode.LIVE,
        success_criteria=[criterion],
        world_assertions=[assertion],
        required_outputs=[required_output],
        static_rubric=[rubric],
    )
    world = LifeWorld(seed=1, now_iso="2026-05-10T12:00:00Z")

    opening = asyncio.run(evaluator.simulate_user_turn(scenario, [], world))
    assert sim.last_call is not None
    simulated_user_prompt = sim.last_call.messages[0]["content"]
    for judge_only_text in (criterion, assertion, required_output, rubric):
        assert judge_only_text not in simulated_user_prompt

    satisfied, reason = asyncio.run(
        evaluator.judge_satisfaction(scenario, [opening], world)
    )
    assert satisfied is False
    assert "unknown or ineligible evidence line" in reason
    assert evaluator.trace[-1].criterion_verdicts == [
        {
            "id": "c1",
            "met": False,
            "evidence_line_id": "user-1",
            "evidence": criterion,
        }
    ]


def test_substantive_evidence_heuristic_is_gone() -> None:
    """The phrase-blocklist/length heuristic is replaced by citation enforcement."""
    assert not hasattr(evaluator_module, "_executor_has_substantive_evidence")


# ---------------------------------------------------------------------------
# Judge prompt shape — evidence-gated scenarios drop the world clause.
# ---------------------------------------------------------------------------


def _requirement() -> TrustedEvidenceRequirement:
    return TrustedEvidenceRequirement(
        contract_id="G1",
        contract_version=1,
        contract_sha256=hashlib.sha256(b"contract").hexdigest(),
        required_assertion_ids=("G1.world.1",),
        allowed_actions=(
            TrustedActionPolicy(
                name="CALENDAR_SOURCES",
                discriminator_field="operation",
                allowed_discriminators=("list",),
                risk="read",
            ),
        ),
    )


def test_judge_prompt_keeps_world_clause_without_evidence_contract() -> None:
    from eliza_lifeops_bench.lifeworld import LifeWorld

    evaluator = _evaluator_with_judge("{}")
    scenario = _scenario(
        mode=ScenarioMode.LIVE,
        success_criteria=["replies kindly"],
        world_assertions=["the event exists"],
    )
    prompt = evaluator._build_judge_prompt(
        scenario, [], LifeWorld(seed=1, now_iso="2026-05-10T12:00:00Z")
    )
    assert "Required world-state assertions" in prompt
    assert "the event exists" in prompt
    assert "[c1] replies kindly" in prompt


def test_judge_prompt_drops_world_clause_for_evidence_gated_scenarios() -> None:
    from eliza_lifeops_bench.lifeworld import LifeWorld

    evaluator = _evaluator_with_judge("{}")
    scenario = _scenario(
        mode=ScenarioMode.LIVE,
        success_criteria=["replies kindly"],
        world_assertions=["the event exists"],
        trusted_evidence_requirement=_requirement(),
    )
    prompt = evaluator._build_judge_prompt(
        scenario, [], LifeWorld(seed=1, now_iso="2026-05-10T12:00:00Z")
    )
    # World truth is attested by required_assertion_ids receipts; tool text
    # is redacted for the judge, so asking it to verify world state would be
    # structurally impossible.
    assert "Required world-state assertions" not in prompt
    assert "the event exists" not in prompt
    assert "[c1] replies kindly" in prompt


# ---------------------------------------------------------------------------
# STATIC semantic judging — LifeOpsEvaluator.judge_static_semantics.
# ---------------------------------------------------------------------------


def test_judge_static_semantics_records_all_output_and_rubric_criteria() -> None:
    evaluator = _evaluator_with_judge(
        '{"criteria": ['
        '{"id": "output_1", "met": true, "evidence_line_id": "executor-1",'
        ' "evidence": "Booked it — happy to help"},'
        '{"id": "rubric_1", "met": true, "evidence_line_id": "executor-1",'
        ' "evidence": "Booked it — happy to help"},'
        '{"id": "rubric_2", "met": false, "evidence": ""}],'
        ' "satisfied": false, "reason": "tone ok, apology missing"}'
    )
    scenario = _scenario(
        required_outputs=["scheduled"],
        static_rubric=["reply is friendly", "reply apologizes for the delay"],
    )
    verdict = asyncio.run(
        evaluator.judge_static_semantics(
            scenario,
            [MessageTurn(role="assistant", content="Booked it — happy to help!")],
        )
    )
    assert verdict.satisfied is False
    assert [c.met for c in verdict.criteria] == [True, True, False]

    entry = evaluator.trace[-1]
    assert entry.role == "judge"
    assert entry.judge_kind == "static_semantic"
    assert entry.verdict_invalid is False
    assert entry.criterion_verdicts == [
        {
            "id": "output_1",
            "met": True,
            "evidence_line_id": "executor-1",
            "evidence": "Booked it — happy to help",
        },
        {
            "id": "rubric_1",
            "met": True,
            "evidence_line_id": "executor-1",
            "evidence": "Booked it — happy to help",
        },
        {
            "id": "rubric_2",
            "met": False,
            "evidence_line_id": "",
            "evidence": "",
        },
    ]
    assert evaluator.judge_cost_usd == pytest.approx(0.003)

    judge_client = evaluator.judge_client
    assert isinstance(judge_client, _StubClient)
    assert judge_client.last_call is not None
    prompt = judge_client.last_call.messages[0]["content"]
    assert "[output_1]" in prompt
    assert "expected outcome or fact" in prompt
    assert "scheduled" in prompt
    assert "[rubric_1] reply is friendly" in prompt
    assert "[rubric_2] reply apologizes for the delay" in prompt
    assert scenario.instruction in prompt


def test_judge_static_semantics_unparseable_records_invalid() -> None:
    evaluator = _evaluator_with_judge("I think it went well overall.")
    scenario = _scenario(static_rubric=["reply is friendly"])
    verdict = asyncio.run(
        evaluator.judge_static_semantics(
            scenario, [MessageTurn(role="assistant", content="Hi.")]
        )
    )
    assert verdict.invalid is True
    assert verdict.satisfied is False
    entry = evaluator.trace[-1]
    assert entry.verdict_invalid is True
    assert entry.criterion_verdicts is None


def test_judge_static_semantics_rejects_scenario_without_expectations() -> None:
    evaluator = _evaluator_with_judge("{}")
    with pytest.raises(ValueError, match="no natural-language STATIC expectations"):
        asyncio.run(evaluator.judge_static_semantics(_scenario(), []))


# ---------------------------------------------------------------------------
# STATIC rubric scoring — deterministic consumption of the recorded verdict.
# ---------------------------------------------------------------------------


_GT_WRITE = [
    Action(
        name="CALENDAR",
        kwargs={
            "subaction": "create_event",
            "event_id": "ev_1",
            "start": "2026-05-11T10:00:00Z",
        },
    )
]


def test_static_semantic_paraphrase_scores_without_literal_match() -> None:
    scenario = _scenario(
        ground_truth_actions=_GT_WRITE,
        required_outputs=["scheduled"],
        static_rubric=["confirmation is friendly"],
    )
    result = _result(
        state_hash_match=True,
        agent_actions=list(_GT_WRITE),
        # Poisoned legacy value proves semantic scoring never consumes it.
        output_substring_matches=[False],
        evaluator_trace=[
            _semantic_trace_entry(
                [
                    {
                        "id": "output_1",
                        "met": True,
                        "evidence": "Executor: I put it on your calendar.",
                    },
                    {
                        "id": "rubric_1",
                        "met": True,
                        "evidence": "Executor: Gladly!",
                    },
                ]
            )
        ],
    )
    assert score_scenario(result, scenario) == pytest.approx(1.0)


def test_static_semantic_wrong_fact_or_unmet_rubric_lowers_output_component() -> None:
    scenario = _scenario(
        ground_truth_actions=_GT_WRITE,
        required_outputs=["scheduled"],
        static_rubric=["confirmation is friendly"],
    )
    result = _result(
        state_hash_match=True,
        agent_actions=list(_GT_WRITE),
        output_substring_matches=[True],
        evaluator_trace=[
            _semantic_trace_entry(
                [
                    {"id": "output_1", "met": False, "evidence": ""},
                    {"id": "rubric_1", "met": False, "evidence": ""},
                ]
            )
        ],
    )
    # The exact token in output_substring_matches is ignored in semantic mode.
    assert score_scenario(result, scenario) == pytest.approx(0.9)


def test_static_semantic_missing_judge_verdict_fails_loudly() -> None:
    scenario = _scenario(
        ground_truth_actions=_GT_WRITE,
        static_rubric=["confirmation is friendly"],
    )
    result = _result(state_hash_match=True, agent_actions=list(_GT_WRITE))
    with pytest.raises(ValueError, match="exactly one static_semantic judge verdict"):
        score_scenario(result, scenario)


def test_static_semantic_trace_rejects_duplicate_or_unexpected_ids() -> None:
    scenario = _scenario(
        ground_truth_actions=_GT_WRITE,
        required_outputs=["scheduled"],
        static_rubric=["friendly"],
    )
    result = _result(
        state_hash_match=True,
        agent_actions=list(_GT_WRITE),
        evaluator_trace=[
            _semantic_trace_entry(
                [
                    {"id": "output_1", "met": True, "evidence": "complete"},
                    {"id": "output_1", "met": True, "evidence": "duplicate"},
                    {"id": "extra", "met": True, "evidence": "unexpected"},
                ]
            )
        ],
    )
    with pytest.raises(ValueError, match="invalid semantic criterion coverage"):
        score_scenario(result, scenario)


def test_static_semantic_invalid_verdict_counts_all_criteria_unmet() -> None:
    scenario = _scenario(
        ground_truth_actions=_GT_WRITE,
        static_rubric=["friendly", "apologetic"],
    )
    result = _result(
        state_hash_match=True,
        agent_actions=list(_GT_WRITE),
        evaluator_trace=[_semantic_trace_entry(None, invalid=True)],
    )
    # 0.5 state + 0.4 action + 0.1 * mean([False, False]).
    assert score_scenario(result, scenario) == pytest.approx(0.9)


def test_static_semantics_cannot_rescue_wrong_agent() -> None:
    """Triviality guard zeroes rubric credit when no GT action overlaps."""
    scenario = _scenario(
        ground_truth_actions=_GT_WRITE,
        static_rubric=["confirmation is friendly"],
    )
    result = _result(
        state_hash_match=False,
        agent_actions=[Action(name="MESSAGE", kwargs={"operation": "send"})],
        evaluator_trace=[
            _semantic_trace_entry(
                [
                    {
                        "id": "rubric_1",
                        "met": True,
                        "evidence": "Executor: gladly!",
                    }
                ]
            )
        ],
    )
    assert score_scenario(result, scenario) == pytest.approx(0.0)


def test_static_semantic_only_safety_scenario_multiplies_state() -> None:
    """No-action contracts may hang entirely on rubric criteria."""
    scenario = _scenario(static_rubric=["explains why it will not act"])
    met = _semantic_trace_entry(
        [
            {
                "id": "rubric_1",
                "met": True,
                "evidence": "Executor: I won't do that because…",
            }
        ]
    )
    unmet = _semantic_trace_entry([{"id": "rubric_1", "met": False, "evidence": ""}])

    satisfied = _result(state_hash_match=True, agent_actions=[], evaluator_trace=[met])
    refused_badly = _result(
        state_hash_match=True, agent_actions=[], evaluator_trace=[unmet]
    )
    mutated = _result(state_hash_match=False, agent_actions=[], evaluator_trace=[met])
    assert score_scenario(satisfied, scenario) == pytest.approx(1.0)
    assert score_scenario(refused_badly, scenario) == pytest.approx(0.0)
    assert score_scenario(mutated, scenario) == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# Free-text kwargs — global soft set + per-scenario soft_kwargs.
# ---------------------------------------------------------------------------


def test_message_body_wording_is_not_deterministically_matched() -> None:
    gt = [
        Action(
            name="MESSAGE",
            kwargs={
                "operation": "send",
                "target": "Hannah Hill",
                "message": "on my way, be there in five",
            },
        )
    ]
    predicted = [
        Action(
            name="MESSAGE",
            kwargs={
                "operation": "send",
                "target": "Hannah Hill",
                "message": "heading over now — five minutes out",
            },
        )
    ]
    assert compare_actions(predicted, gt) == pytest.approx(1.0)


def test_structural_kwargs_stay_deterministic() -> None:
    gt = [
        Action(
            name="MESSAGE",
            kwargs={"operation": "send", "target": "Hannah Hill", "message": "hi"},
        )
    ]
    wrong_target = [
        Action(
            name="MESSAGE",
            kwargs={"operation": "send", "target": "Someone Else", "message": "hi"},
        )
    ]
    assert compare_actions(wrong_target, gt) == pytest.approx(0.25)


def test_scenario_soft_kwargs_thread_through_score_scenario() -> None:
    gt = [
        Action(
            name="CALENDAR",
            kwargs={
                "subaction": "create_event",
                "event_id": "ev_1",
                "summary_line": "Quarterly sync with the design team",
            },
        )
    ]
    predicted = [
        Action(
            name="CALENDAR",
            kwargs={
                "subaction": "create_event",
                "event_id": "ev_1",
                "summary_line": "Design-team quarterly sync",
            },
        )
    ]
    strict = _scenario(ground_truth_actions=gt)
    softened = _scenario(ground_truth_actions=gt, soft_kwargs=["summary_line"])
    result = _result(state_hash_match=False, agent_actions=predicted)

    # Write weights, no state match: 0.4 * action_component + 0.1 * 1.0.
    assert score_scenario(result, strict) == pytest.approx(0.3)
    assert score_scenario(result, softened) == pytest.approx(0.5)
    assert compare_actions(predicted, gt) == pytest.approx(0.5)
    assert compare_actions(
        predicted, gt, soft_kwargs=frozenset({"summary_line"})
    ) == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# RRULE-aware kwarg equivalence — purely deterministic.
# ---------------------------------------------------------------------------


def test_rrule_equivalence_ignores_part_order_and_defaults() -> None:
    assert _values_equivalent(
        "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR",
        "BYDAY=FR,WE,MO;FREQ=WEEKLY;WKST=MO;INTERVAL=1",
    )
    assert _values_equivalent(
        "freq=monthly;bymonthday=15",
        "RRULE:BYMONTHDAY=15;FREQ=MONTHLY",
    )


def test_rrule_semantic_differences_still_mismatch() -> None:
    assert not _values_equivalent(
        "RRULE:FREQ=WEEKLY;BYDAY=MO", "RRULE:FREQ=WEEKLY;BYDAY=TU"
    )
    assert not _values_equivalent("RRULE:FREQ=WEEKLY;INTERVAL=2", "RRULE:FREQ=WEEKLY")
    assert not _values_equivalent("RRULE:FREQ=WEEKLY;WKST=SU", "RRULE:FREQ=WEEKLY")
    assert not _values_equivalent("RRULE:FREQ=DAILY", "RRULE:FREQ=WEEKLY")


def test_rrule_parser_rejects_non_recur_strings() -> None:
    assert _parse_rrule("every other friday") is None
    assert _parse_rrule("FREQ=SOMETIMES") is None
    assert _parse_rrule("FREQ=WEEKLY;FREQ=DAILY") is None
    assert _parse_rrule("FREQ=WEEKLY;BYDAY=") is None
    # Non-RRULE strings keep normalized string comparison semantics.
    assert _values_equivalent("every other friday", "Every other Friday")
    assert not _values_equivalent("RRULE:FREQ=WEEKLY", "every week")


def test_rrule_equivalence_applies_inside_kwargs() -> None:
    assert _kwargs_match(
        {"event_id": "ev_1", "recurrence": "BYDAY=WE,MO;FREQ=WEEKLY"},
        {"event_id": "ev_1", "recurrence": "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;WKST=MO"},
    )
    assert not _kwargs_match(
        {"event_id": "ev_1", "recurrence": "RRULE:FREQ=DAILY"},
        {"event_id": "ev_1", "recurrence": "RRULE:FREQ=WEEKLY;BYDAY=MO,WE"},
    )
