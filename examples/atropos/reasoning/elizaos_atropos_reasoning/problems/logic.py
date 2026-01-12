"""
Logic problem generators.
"""

from __future__ import annotations

import random
import uuid
from typing import TYPE_CHECKING

from elizaos_atropos_reasoning.types import Problem, TaskType, Difficulty

if TYPE_CHECKING:
    pass


class LogicProblemGenerator:
    """Generator for logic reasoning problems."""

    def __init__(self, seed: int | None = None) -> None:
        """Initialize the generator."""
        self._rng = random.Random(seed)

    def generate(self, difficulty: Difficulty = Difficulty.MEDIUM) -> Problem:
        """Generate a logic problem."""
        generators = {
            Difficulty.EASY: self._generate_easy,
            Difficulty.MEDIUM: self._generate_medium,
            Difficulty.HARD: self._generate_hard,
        }
        return generators[difficulty]()

    def _generate_easy(self) -> Problem:
        """Generate easy logic problem."""
        problem_types = [
            self._simple_conditional,
            self._boolean,
            self._sequence,
        ]
        return self._rng.choice(problem_types)()

    def _generate_medium(self) -> Problem:
        """Generate medium logic problem."""
        problem_types = [
            self._syllogism,
            self._negation,
            self._ordering,
        ]
        return self._rng.choice(problem_types)()

    def _generate_hard(self) -> Problem:
        """Generate hard logic problem."""
        problem_types = [
            self._fallacy_detection,
            self._complex_conditional,
            self._truth_teller,
        ]
        return self._rng.choice(problem_types)()

    def _simple_conditional(self) -> Problem:
        """Generate simple conditional problem."""
        templates = [
            {
                "premise1": "If it rains, the ground gets wet",
                "premise2": "It is raining",
                "question": "Is the ground wet?",
                "answer": "Yes",
                "explanation": "Modus ponens: If P then Q, P is true, therefore Q is true.",
            },
            {
                "premise1": "If it rains, the ground gets wet",
                "premise2": "The ground is dry",
                "question": "Is it raining?",
                "answer": "No",
                "explanation": "Modus tollens: If P then Q, Q is false, therefore P is false.",
            },
            {
                "premise1": "All cats are mammals",
                "premise2": "Whiskers is a cat",
                "question": "Is Whiskers a mammal?",
                "answer": "Yes",
                "explanation": "Universal affirmative: All A are B, X is A, therefore X is B.",
            },
        ]

        template = self._rng.choice(templates)

        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.LOGIC,
            difficulty=Difficulty.EASY,
            question=f"Given:\n1. {template['premise1']}\n2. {template['premise2']}\n\n{template['question']}",
            expected_answer=template["answer"],
            explanation=template["explanation"],
            hints=["Apply basic logical rules."],
        )

    def _boolean(self) -> Problem:
        """Generate boolean logic problem."""
        a = self._rng.choice([True, False])
        b = self._rng.choice([True, False])

        operations = [
            ("AND", a and b),
            ("OR", a or b),
        ]
        op_name, result = self._rng.choice(operations)

        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.LOGIC,
            difficulty=Difficulty.EASY,
            question=f"If A is {a} and B is {b}, what is A {op_name} B?",
            expected_answer=result,
            explanation=f"{a} {op_name} {b} = {result}",
            hints=[f"Remember: {op_name} returns True only when {'both are True' if op_name == 'AND' else 'at least one is True'}."],
        )

    def _sequence(self) -> Problem:
        """Generate sequence pattern problem."""
        patterns = [
            ([2, 4, 6, 8], 10, "Add 2 each time"),
            ([1, 2, 4, 8], 16, "Double each time"),
            ([1, 4, 9, 16], 25, "Square numbers: 1², 2², 3², 4², 5²"),
            ([1, 1, 2, 3, 5], 8, "Fibonacci: each number is sum of two before"),
        ]

        seq, answer, explanation = self._rng.choice(patterns)

        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.LOGIC,
            difficulty=Difficulty.EASY,
            question=f"What is the next number in the sequence: {', '.join(map(str, seq))}, ?",
            expected_answer=answer,
            explanation=explanation,
            hints=["Look for a pattern between consecutive numbers."],
        )

    def _syllogism(self) -> Problem:
        """Generate syllogism problem."""
        templates = [
            {
                "major": "All humans are mortal",
                "minor": "Socrates is a human",
                "conclusion": "Socrates is mortal",
                "valid": True,
            },
            {
                "major": "All birds can fly",
                "minor": "Penguins are birds",
                "conclusion": "Penguins can fly",
                "valid": True,  # Valid but unsound
                "note": "The argument is valid (conclusion follows from premises) but unsound (the major premise is false).",
            },
            {
                "major": "Some flowers are red",
                "minor": "Some red things are roses",
                "conclusion": "Some flowers are roses",
                "valid": False,
            },
        ]

        template = self._rng.choice(templates)

        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.LOGIC,
            difficulty=Difficulty.MEDIUM,
            question=(
                f"Is this argument valid?\n\n"
                f"Premise 1: {template['major']}\n"
                f"Premise 2: {template['minor']}\n"
                f"Conclusion: {template['conclusion']}\n\n"
                f"Answer Yes or No."
            ),
            expected_answer="Yes" if template["valid"] else "No",
            explanation=template.get("note", "Check if the conclusion necessarily follows from the premises."),
            hints=["Consider whether the conclusion must be true if the premises are true."],
        )

    def _negation(self) -> Problem:
        """Generate negation problem."""
        statements = [
            ("All cats are black", "Some cats are not black", "NOT All = Some are not"),
            ("Some dogs are friendly", "No dogs are friendly", "NOT Some = None"),
            ("No birds can swim", "Some birds can swim", "NOT None = Some"),
        ]

        original, negation, explanation = self._rng.choice(statements)

        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.LOGIC,
            difficulty=Difficulty.MEDIUM,
            question=f"What is the negation of: '{original}'?",
            expected_answer=negation,
            explanation=explanation,
            hints=["The negation contradicts the original statement."],
        )

    def _ordering(self) -> Problem:
        """Generate ordering/ranking problem."""
        names = ["Alice", "Bob", "Carol", "David"]
        self._rng.shuffle(names)

        order = names[:3]

        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.LOGIC,
            difficulty=Difficulty.MEDIUM,
            question=(
                f"In a race:\n"
                f"- {order[0]} finished before {order[1]}\n"
                f"- {order[1]} finished before {order[2]}\n\n"
                f"Who finished first?"
            ),
            expected_answer=order[0],
            explanation=f"Order: {order[0]} > {order[1]} > {order[2]}",
            hints=["Create a chain from the clues."],
        )

    def _fallacy_detection(self) -> Problem:
        """Generate fallacy detection problem."""
        fallacies = [
            {
                "argument": "If it rains, the ground is wet. The ground is wet. Therefore, it rained.",
                "name": "Affirming the consequent",
                "valid": False,
                "explanation": "The ground could be wet for other reasons (sprinklers, spilled water).",
            },
            {
                "argument": "All dogs are mammals. All mammals are animals. Therefore, all dogs are animals.",
                "name": "Valid syllogism",
                "valid": True,
                "explanation": "This is a valid transitive argument.",
            },
            {
                "argument": "Either we ban all cars or pollution will destroy the planet. We shouldn't ban all cars. Therefore, pollution will destroy the planet.",
                "name": "False dilemma",
                "valid": False,
                "explanation": "There are more options than the two presented.",
            },
        ]

        fallacy = self._rng.choice(fallacies)

        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.LOGIC,
            difficulty=Difficulty.HARD,
            question=f"Is this argument logically valid?\n\n{fallacy['argument']}\n\nAnswer Yes or No.",
            expected_answer="Yes" if fallacy["valid"] else "No",
            explanation=f"{fallacy['name']}: {fallacy['explanation']}",
            hints=["Check if the conclusion must follow from the premises."],
        )

    def _complex_conditional(self) -> Problem:
        """Generate complex conditional problem."""
        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.LOGIC,
            difficulty=Difficulty.HARD,
            question=(
                "Given:\n"
                "1. If A then B\n"
                "2. If B then C\n"
                "3. If C then D\n"
                "4. A is true\n\n"
                "What can we conclude about D? (True, False, or Unknown)"
            ),
            expected_answer="True",
            explanation="By chained modus ponens: A→B→C→D, and A is true, so D must be true.",
            hints=[
                "Apply modus ponens step by step.",
                "A implies B, B implies C, C implies D.",
            ],
        )

    def _truth_teller(self) -> Problem:
        """Generate truth-teller/liar problem."""
        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.LOGIC,
            difficulty=Difficulty.HARD,
            question=(
                "On an island, people are either Knights (always tell truth) or Knaves (always lie).\n\n"
                "You meet two people, A and B.\n"
                "A says: 'We are both Knaves.'\n\n"
                "What is A? (Knight or Knave)"
            ),
            expected_answer="Knave",
            explanation=(
                "If A is a Knight, the statement 'We are both Knaves' must be true. "
                "But that would make A a Knave, contradiction. "
                "So A must be a Knave."
            ),
            hints=[
                "Consider: What if A is a Knight?",
                "What contradiction arises?",
            ],
        )
