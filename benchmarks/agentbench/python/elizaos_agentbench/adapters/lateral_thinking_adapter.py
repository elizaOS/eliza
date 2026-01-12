"""
Lateral Thinking Puzzle environment adapter for AgentBench.

This adapter supports classic "lateral thinking" puzzles where the agent can:
- ask yes/no questions
- request hints (penalized)
- submit a final guess
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from typing import TypedDict

from elizaos_agentbench.adapters.base import EnvironmentAdapter
from elizaos_agentbench.types import (
    AgentBenchEnvironment,
    AgentBenchTask,
    AgentRuntimeProtocol,
    EnvironmentConfig,
    ObservationType,
)

logger = logging.getLogger(__name__)

StepInfoType = dict[str, str | int | float | bool | None]


class PuzzleType(TypedDict):
    id: str
    scenario: str
    answer: str
    hints: list[str]
    keywords: list[str]


class ParsedAction(TypedDict):
    type: str
    params: dict[str, str]


SAMPLE_PUZZLES: list[PuzzleType] = [
    {
        "id": "ltp001",
        "scenario": "A man walks into a bar and asks for a glass of water. The bartender pulls out a gun and points it at him. The man says 'Thank you' and walks out. Why?",
        "answer": "hiccups",
        "hints": [
            "The man had a physical condition.",
            "The gun wasn't meant to harm him.",
            "Fear can cure certain conditions.",
        ],
        "keywords": ["hiccups", "scared", "fright", "cure"],
    },
    {
        "id": "ltp002",
        "scenario": "A man is found dead in a field with an unopened package next to him. There are no other people, animals, or vehicles nearby. How did he die?",
        "answer": "parachute",
        "hints": [
            "The package is related to his death.",
            "He fell from somewhere.",
            "The package should have opened before he landed.",
        ],
        "keywords": ["parachute", "skydiving", "failed", "open", "fall"],
    },
    {
        "id": "ltp003",
        "scenario": "A woman shoots her husband, holds him under water for five minutes, and then hangs him. Ten minutes later, they go out to dinner. How is this possible?",
        "answer": "photograph",
        "hints": [
            "She didn't actually kill him.",
            "The words have different meanings.",
            "It's related to a hobby.",
        ],
        "keywords": ["photograph", "camera", "picture", "photo", "develop", "darkroom"],
    },
]


class LateralThinkingAdapter(EnvironmentAdapter):
    """
    Adapter for Lateral Thinking Puzzle environment.

    This implementation is intentionally lightweight but strongly validated and
    suitable as an end-to-end benchmark harness component.
    """

    environment = AgentBenchEnvironment.LATERAL_THINKING

    def __init__(
        self,
        runtime: AgentRuntimeProtocol | None = None,
        config: EnvironmentConfig | None = None,
    ) -> None:
        super().__init__(runtime, config)
        self._puzzles: list[PuzzleType] = []
        self._current_puzzle: PuzzleType | None = None
        self._hints_revealed: int = 0
        self._guesses: list[str] = []
        self._questions_asked: list[str] = []

    async def initialize(self) -> None:
        if self._initialized:
            return
        self._puzzles = list(SAMPLE_PUZZLES)
        self._initialized = True

    def _coerce_str_list(self, value: object) -> list[str]:
        if not isinstance(value, list):
            return []
        return [x for x in value if isinstance(x, str)]

    async def reset(self, task: AgentBenchTask) -> ObservationType:
        self._hints_revealed = 0
        self._guesses = []
        self._questions_asked = []

        puzzle_id_val = task.initial_state.get("puzzle_id")
        puzzle_id = puzzle_id_val if isinstance(puzzle_id_val, str) else ""

        selected: PuzzleType | None = None
        if puzzle_id:
            for p in self._puzzles:
                if p["id"] == puzzle_id:
                    selected = p
                    break

        if selected is None:
            keywords_val = task.metadata.get("keywords", [])
            keywords = self._coerce_str_list(keywords_val)
            selected = {
                "id": task.id,
                "scenario": task.description,
                "answer": task.ground_truth or "",
                "hints": list(task.hints),
                "keywords": keywords,
            }

        self._current_puzzle = selected

        return {
            "scenario": selected["scenario"],
            "hints_available": len(selected["hints"]),
            "hints_revealed": 0,
            "task_description": task.description,
            "goal": task.goal,
            "message": "Read the scenario and figure out what happened. You can ask yes/no questions, request hints, or submit your answer.",
        }

    async def step(self, action: str) -> tuple[ObservationType, float, bool, StepInfoType]:
        parsed = self._parse_action(action)
        action_type = parsed["type"]
        params = parsed["params"]

        reward = 0.0
        done = False

        puzzle = self._current_puzzle
        if puzzle is None:
            return {"error": "No puzzle loaded"}, -0.5, True, {"action_type": "error"}

        if action_type == "ask":
            question = params.get("question", "").strip()
            if not question:
                return {"error": "Question cannot be empty"}, -0.1, False, {"action_type": "ask"}
            self._questions_asked.append(question)

            answer = self._answer_question(question, puzzle)
            reward = 0.05
            observation: ObservationType = {
                "question": question,
                "answer": answer,
                "questions_asked": len(self._questions_asked),
                "message": f"Q: {question}\nA: {answer}",
            }

        elif action_type == "hint":
            if self._hints_revealed < len(puzzle["hints"]):
                hint = puzzle["hints"][self._hints_revealed]
                self._hints_revealed += 1
                reward = -0.1
                observation = {
                    "hint": hint,
                    "hints_revealed": self._hints_revealed,
                    "hints_remaining": len(puzzle["hints"]) - self._hints_revealed,
                    "message": f"Hint {self._hints_revealed}: {hint}",
                }
            else:
                observation = {
                    "message": "No more hints available.",
                    "hints_revealed": self._hints_revealed,
                    "hints_remaining": 0,
                }

        elif action_type == "guess":
            guess = params.get("answer", "").strip().lower()
            if not guess:
                return {"error": "Answer cannot be empty"}, -0.1, False, {"action_type": "guess"}

            self._guesses.append(guess)

            correct = self._is_correct_guess(guess, puzzle)
            if correct:
                reward = 1.0 - (0.1 * self._hints_revealed)
                done = True
                observation = {
                    "correct": True,
                    "answer": puzzle["answer"],
                    "guesses_made": len(self._guesses),
                    "hints_used": self._hints_revealed,
                    "message": f"Correct! The answer was: {puzzle['answer']}",
                }
            else:
                reward = -0.15
                observation = {
                    "correct": False,
                    "guess": guess,
                    "guesses_made": len(self._guesses),
                    "message": "That's not quite right. Try again or ask more questions.",
                }

        elif action_type == "think":
            observation = {
                "message": "Thinking...",
                "scenario": puzzle["scenario"],
                "questions_asked": len(self._questions_asked),
                "guesses_made": len(self._guesses),
            }

        else:
            observation = {"error": f"Unknown action: {action_type}", "message": "Valid actions: ask[question], hint, guess[answer], think"}
            reward = -0.1

        return observation, reward, done, {"action_type": action_type, "params": str(params)}

    def _is_correct_guess(self, guess: str, puzzle: PuzzleType) -> bool:
        correct_answer = puzzle["answer"].lower().strip()
        keywords = [k.lower() for k in puzzle.get("keywords", [])]
        if not correct_answer:
            return False
        return guess == correct_answer or correct_answer in guess or any(kw in guess for kw in keywords)

    def _answer_question(self, question: str, puzzle: PuzzleType) -> str:
        q = question.lower()
        keywords = [k.lower() for k in puzzle.get("keywords", [])]
        ans = puzzle["answer"].lower()
        scenario = puzzle["scenario"].lower()

        if any(kw in q for kw in keywords):
            return "Yes, that's relevant."
        if ans and ans in q:
            return "Yes, you're on the right track!"

        # A few heuristic responses
        if "murder" in q or "kill" in q:
            return "No."
        if "die" in q or "death" in q:
            return "Yes." if "dead" in scenario else "No."

        return "Not exactly."

    def _parse_action(self, action: str) -> ParsedAction:
        text = action.strip()

        patterns: list[tuple[str, str, Callable[[re.Match[str]], dict[str, str]]]] = [
            (r"ask\[([^\]]+)\]", "ask", lambda m: {"question": m.group(1).strip()}),
            (r"question:\s*(.+)", "ask", lambda m: {"question": m.group(1).strip()}),
            (r"guess\[([^\]]+)\]", "guess", lambda m: {"answer": m.group(1).strip()}),
            (r"answer:\s*(.+)", "guess", lambda m: {"answer": m.group(1).strip()}),
            (r"^hint$", "hint", lambda _m: {}),
            (r"request[_\s]?hint", "hint", lambda _m: {}),
            (r"^think$", "think", lambda _m: {}),
        ]

        for pat, action_type, extractor in patterns:
            m = re.search(pat, text, re.IGNORECASE)
            if m:
                return {"type": action_type, "params": extractor(m)}

        if "?" in text:
            # Treat as question
            return {"type": "ask", "params": {"question": text}}

        return {"type": "invalid", "params": {}}

    async def evaluate(self, task: AgentBenchTask, trajectory: list[str]) -> bool:
        puzzle = self._current_puzzle
        if puzzle is None:
            return False
        for action in trajectory:
            parsed = self._parse_action(action)
            if parsed["type"] == "guess":
                guess = parsed["params"].get("answer", "").lower()
                if guess and self._is_correct_guess(guess, puzzle):
                    return True
        return False

    async def cleanup(self) -> None:
        self._current_puzzle = None
        self._initialized = False

    def get_action_space(self) -> list[str]:
        return ["ask[yes/no question]", "hint", "guess[your answer]", "think"]

    def format_prompt(self, task: AgentBenchTask, observation: ObservationType) -> str:
        scenario_val = observation.get("scenario", task.description)
        scenario = scenario_val if isinstance(scenario_val, str) else task.description

        msg_val = observation.get("message", "")
        message = msg_val if isinstance(msg_val, str) else ""

        hints_revealed_val = observation.get("hints_revealed", 0)
        hints_available_val = observation.get("hints_available", 0)
        questions_asked_val = observation.get("questions_asked", 0)
        guesses_made_val = observation.get("guesses_made", 0)

        hints_revealed = int(hints_revealed_val) if isinstance(hints_revealed_val, int) else 0
        hints_available = int(hints_available_val) if isinstance(hints_available_val, int) else 0
        questions_asked = int(questions_asked_val) if isinstance(questions_asked_val, int) else 0
        guesses_made = int(guesses_made_val) if isinstance(guesses_made_val, int) else 0

        history_section = f"\n**Last Action Result:**\n{message}\n" if message else ""

        return f"""You are solving a lateral thinking puzzle. These puzzles have unexpected answers that require creative thinking.

**Scenario:**
{scenario}

**Goal:** Figure out the explanation for this scenario.

**Progress:**
- Questions asked: {questions_asked}
- Guesses made: {guesses_made}
- Hints used: {hints_revealed}/{hints_available}

{history_section}

**Available Actions:**
- ask[your yes/no question]
- hint
- guess[your answer]
- think

**Rules / strategy:**
- Your output MUST be exactly one action line (one of the four above).
- Ask short, direct yes/no questions about concrete hypotheses (avoid meta commentary).
- If you get 3+ replies like "Not exactly" in a row, request a `hint`.
- If you have asked 10 questions already and still haven't guessed, you MUST make a `guess[...]` (1-3 words).

What's your next action?"""

    def parse_action(self, response: str) -> str:
        fenced = re.search(r"```\n?(.+?)\n?```", response, re.DOTALL)
        if fenced:
            return fenced.group(1).strip().split("\n")[0]

        for prefix in ("action:", "question:", "answer:"):
            m = re.search(rf"{prefix}\\s*(.+)", response, re.IGNORECASE)
            if m:
                return m.group(1).strip().split("\n")[0]

        for pat in (r"(ask\[[^\]]+\])", r"(guess\[[^\]]+\])", r"(^hint$)", r"(^think$)"):
            m = re.search(pat, response, re.IGNORECASE | re.MULTILINE)
            if m:
                return m.group(1).strip()

        # If the response contains a question, treat it as ask[]
        if "?" in response:
            qm = re.search(r"[^.!?]*\\?", response)
            if qm:
                return f"ask[{qm.group(0).strip()}]"

        return response.strip().split("\n")[0]

