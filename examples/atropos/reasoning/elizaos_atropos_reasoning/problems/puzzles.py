"""
Puzzle problem generators.
"""

from __future__ import annotations

import random
import uuid
from typing import TYPE_CHECKING

from elizaos_atropos_reasoning.types import Problem, TaskType, Difficulty

if TYPE_CHECKING:
    pass


class PuzzleProblemGenerator:
    """Generator for puzzle problems."""

    def __init__(self, seed: int | None = None) -> None:
        """Initialize the generator."""
        self._rng = random.Random(seed)

    def generate(self, difficulty: Difficulty = Difficulty.MEDIUM) -> Problem:
        """Generate a puzzle problem."""
        generators = {
            Difficulty.EASY: self._generate_easy,
            Difficulty.MEDIUM: self._generate_medium,
            Difficulty.HARD: self._generate_hard,
        }
        return generators[difficulty]()

    def _generate_easy(self) -> Problem:
        """Generate easy puzzle."""
        puzzles = [
            self._simple_riddle,
            self._pattern_match,
            self._analogy,
        ]
        return self._rng.choice(puzzles)()

    def _generate_medium(self) -> Problem:
        """Generate medium puzzle."""
        puzzles = [
            self._constraint_simple,
            self._word_puzzle,
            self._number_puzzle,
        ]
        return self._rng.choice(puzzles)()

    def _generate_hard(self) -> Problem:
        """Generate hard puzzle."""
        puzzles = [
            self._constraint_complex,
            self._river_crossing,
            self._balance_puzzle,
        ]
        return self._rng.choice(puzzles)()

    def _simple_riddle(self) -> Problem:
        """Generate simple riddle."""
        riddles = [
            {
                "riddle": "I have hands but cannot clap. What am I?",
                "answer": "clock",
                "explanation": "A clock has hands (hour hand, minute hand) but cannot clap.",
            },
            {
                "riddle": "The more you take, the more you leave behind. What am I?",
                "answer": "footsteps",
                "explanation": "When you walk, each step you take leaves a footprint behind.",
            },
            {
                "riddle": "I have keys but no locks. I have space but no room. What am I?",
                "answer": "keyboard",
                "explanation": "A keyboard has keys and a space bar, but no physical locks or rooms.",
            },
        ]

        riddle = self._rng.choice(riddles)

        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.PUZZLE,
            difficulty=Difficulty.EASY,
            question=riddle["riddle"],
            expected_answer=riddle["answer"],
            explanation=riddle["explanation"],
            hints=["Think about the wordplay."],
        )

    def _pattern_match(self) -> Problem:
        """Generate pattern matching puzzle."""
        patterns = [
            {
                "pattern": "AB, CD, EF, ?",
                "answer": "GH",
                "explanation": "Consecutive letter pairs from the alphabet.",
            },
            {
                "pattern": "A1, B2, C3, ?",
                "answer": "D4",
                "explanation": "Letters paired with their position in the alphabet.",
            },
        ]

        pattern = self._rng.choice(patterns)

        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.PUZZLE,
            difficulty=Difficulty.EASY,
            question=f"Complete the pattern: {pattern['pattern']}",
            expected_answer=pattern["answer"],
            explanation=pattern["explanation"],
            hints=["Look at how each element relates to the next."],
        )

    def _analogy(self) -> Problem:
        """Generate analogy puzzle."""
        analogies = [
            ("Cat", "Kitten", "Dog", "Puppy", "baby animals"),
            ("Hot", "Cold", "Fast", "Slow", "opposites"),
            ("Page", "Book", "Key", "Keyboard", "part of whole"),
        ]

        a, b, c, d, relationship = self._rng.choice(analogies)

        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.PUZZLE,
            difficulty=Difficulty.EASY,
            question=f"{a} is to {b} as {c} is to ?",
            expected_answer=d,
            explanation=f"Relationship: {relationship}",
            hints=["Find the relationship between the first pair."],
        )

    def _constraint_simple(self) -> Problem:
        """Generate simple constraint puzzle."""
        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.PUZZLE,
            difficulty=Difficulty.MEDIUM,
            question=(
                "Three friends (Amy, Ben, Cal) each have a different favorite color (Red, Green, Blue).\n\n"
                "Clues:\n"
                "1. Amy doesn't like Red\n"
                "2. Ben likes Green\n\n"
                "What color does Amy like? (Red, Green, or Blue)"
            ),
            expected_answer="Blue",
            explanation="Ben has Green, Amy can't have Red, so Amy has Blue (and Cal has Red).",
            hints=[
                "Start with what you know for certain.",
                "Process of elimination helps.",
            ],
        )

    def _word_puzzle(self) -> Problem:
        """Generate word puzzle."""
        puzzles = [
            {
                "question": "Rearrange the letters in 'LISTEN' to form another word.",
                "answer": "SILENT",
                "explanation": "LISTEN and SILENT are anagrams.",
            },
            {
                "question": "What word becomes shorter when you add two letters to it?",
                "answer": "short",
                "explanation": "'Short' + 'er' = 'Shorter' (which ironically is a longer word).",
            },
        ]

        puzzle = self._rng.choice(puzzles)

        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.PUZZLE,
            difficulty=Difficulty.MEDIUM,
            question=puzzle["question"],
            expected_answer=puzzle["answer"],
            explanation=puzzle["explanation"],
            hints=["Think about wordplay."],
        )

    def _number_puzzle(self) -> Problem:
        """Generate number puzzle."""
        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.PUZZLE,
            difficulty=Difficulty.MEDIUM,
            question=(
                "Using the digits 1, 2, 3, and 4 exactly once each, "
                "what is the largest 4-digit number you can make?"
            ),
            expected_answer=4321,
            explanation="Place largest digits in most significant positions: 4321",
            hints=["Put larger digits in higher place values."],
        )

    def _constraint_complex(self) -> Problem:
        """Generate complex constraint puzzle."""
        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.PUZZLE,
            difficulty=Difficulty.HARD,
            question=(
                "Four people (Alice, Bob, Carol, Dave) live in a row of houses.\n\n"
                "Clues:\n"
                "1. Alice lives next to Bob\n"
                "2. Carol doesn't live at either end\n"
                "3. Dave lives at the left end\n"
                "4. Bob doesn't live next to Dave\n\n"
                "What is the order of houses from left to right? (Format: Name, Name, Name, Name)"
            ),
            expected_answer="Dave, Carol, Alice, Bob",
            explanation=(
                "Dave is at left end. Carol is not at ends, so she's 2nd or 3rd. "
                "Bob can't be next to Dave, so Bob isn't 2nd. "
                "Alice is next to Bob, so if Bob is 4th, Alice is 3rd. "
                "That makes Carol 2nd."
            ),
            hints=[
                "Start with what's certain (Dave's position).",
                "Use Carol's constraint to narrow down.",
                "Apply Bob and Alice's constraints last.",
            ],
        )

    def _river_crossing(self) -> Problem:
        """Generate river crossing puzzle."""
        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.PUZZLE,
            difficulty=Difficulty.HARD,
            question=(
                "A farmer needs to cross a river with a fox, a chicken, and corn. "
                "The boat can only hold the farmer and one item. "
                "If left alone, the fox will eat the chicken, and the chicken will eat the corn.\n\n"
                "What is the minimum number of river crossings needed?"
            ),
            expected_answer=7,
            explanation=(
                "Solution:\n"
                "1. Take chicken across\n"
                "2. Return alone\n"
                "3. Take fox across\n"
                "4. Return with chicken\n"
                "5. Take corn across\n"
                "6. Return alone\n"
                "7. Take chicken across"
            ),
            hints=[
                "The chicken is the key - it can't be left with either.",
                "You may need to bring something back.",
            ],
        )

    def _balance_puzzle(self) -> Problem:
        """Generate balance/weight puzzle."""
        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.PUZZLE,
            difficulty=Difficulty.HARD,
            question=(
                "You have 9 coins that look identical. 8 weigh the same, but 1 is heavier. "
                "Using a balance scale, what is the minimum number of weighings needed "
                "to guarantee finding the heavy coin?"
            ),
            expected_answer=2,
            explanation=(
                "Split into 3 groups of 3. Weigh two groups.\n"
                "If equal, heavy coin is in third group. If not, it's in the heavier group.\n"
                "From the group of 3, weigh 2 coins. If equal, it's the third. If not, it's the heavier."
            ),
            hints=[
                "Think about dividing into groups of 3.",
                "Each weighing can eliminate 2/3 of possibilities.",
            ],
        )
