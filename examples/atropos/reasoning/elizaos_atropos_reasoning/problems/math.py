"""
Math problem generators.
"""

from __future__ import annotations

import random
import uuid
from typing import TYPE_CHECKING

from elizaos_atropos_reasoning.types import Problem, TaskType, Difficulty

if TYPE_CHECKING:
    pass


class MathProblemGenerator:
    """Generator for math reasoning problems."""

    def __init__(self, seed: int | None = None) -> None:
        """Initialize the generator."""
        self._rng = random.Random(seed)

    def generate(self, difficulty: Difficulty = Difficulty.MEDIUM) -> Problem:
        """Generate a math problem."""
        generators = {
            Difficulty.EASY: self._generate_easy,
            Difficulty.MEDIUM: self._generate_medium,
            Difficulty.HARD: self._generate_hard,
        }
        return generators[difficulty]()

    def _generate_easy(self) -> Problem:
        """Generate an easy math problem."""
        problem_types = [
            self._arithmetic,
            self._percentage_easy,
            self._simple_word,
        ]
        return self._rng.choice(problem_types)()

    def _generate_medium(self) -> Problem:
        """Generate a medium math problem."""
        problem_types = [
            self._multi_step,
            self._percentage_medium,
            self._rate_problem,
        ]
        return self._rng.choice(problem_types)()

    def _generate_hard(self) -> Problem:
        """Generate a hard math problem."""
        problem_types = [
            self._complex_word,
            self._algebra,
            self._probability,
        ]
        return self._rng.choice(problem_types)()

    def _arithmetic(self) -> Problem:
        """Generate basic arithmetic problem."""
        ops = [
            ("+", lambda a, b: a + b),
            ("-", lambda a, b: a - b),
            ("×", lambda a, b: a * b),
        ]
        op_sym, op_fn = self._rng.choice(ops)

        a = self._rng.randint(1, 50)
        b = self._rng.randint(1, 50)
        answer = op_fn(a, b)

        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.MATH,
            difficulty=Difficulty.EASY,
            question=f"What is {a} {op_sym} {b}?",
            expected_answer=answer,
            explanation=f"{a} {op_sym} {b} = {answer}",
            hints=[f"This is a basic {op_sym} operation."],
        )

    def _percentage_easy(self) -> Problem:
        """Generate easy percentage problem."""
        percent = self._rng.choice([10, 20, 25, 50])
        base = self._rng.randint(2, 20) * 10
        answer = base * percent // 100

        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.MATH,
            difficulty=Difficulty.EASY,
            question=f"What is {percent}% of {base}?",
            expected_answer=answer,
            explanation=f"{percent}% of {base} = {base} × {percent/100} = {answer}",
            hints=[f"To find {percent}%, multiply by {percent/100}."],
        )

    def _simple_word(self) -> Problem:
        """Generate simple word problem."""
        items = ["apples", "books", "cookies", "pencils", "toys"]
        item = self._rng.choice(items)

        start = self._rng.randint(5, 20)
        change = self._rng.randint(1, min(10, start - 1))

        if self._rng.random() < 0.5:
            answer = start + change
            action = "gets"
            direction = "more"
        else:
            answer = start - change
            action = "gives away"
            direction = ""

        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.MATH,
            difficulty=Difficulty.EASY,
            question=f"Sarah has {start} {item}. She {action} {change} {direction}. How many {item} does she have now?",
            expected_answer=answer,
            explanation=f"{start} {'+' if 'gets' in action else '-'} {change} = {answer}",
            hints=["Think about whether the number goes up or down."],
        )

    def _multi_step(self) -> Problem:
        """Generate multi-step math problem."""
        price = self._rng.randint(5, 20)
        quantity = self._rng.randint(2, 5)
        paid = (price * quantity // 5 + 2) * 5 + self._rng.randint(1, 3) * 5

        total = price * quantity
        change = paid - total

        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.MATH,
            difficulty=Difficulty.MEDIUM,
            question=f"You buy {quantity} items at ${price} each. If you pay with ${paid}, how much change do you get?",
            expected_answer=change,
            explanation=f"Total = {quantity} × ${price} = ${total}. Change = ${paid} - ${total} = ${change}",
            hints=[
                "First calculate the total cost.",
                "Then subtract from the amount paid.",
            ],
        )

    def _percentage_medium(self) -> Problem:
        """Generate medium percentage problem."""
        original = self._rng.randint(5, 25) * 10
        discount = self._rng.choice([15, 20, 25, 30])

        savings = original * discount // 100
        final = original - savings

        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.MATH,
            difficulty=Difficulty.MEDIUM,
            question=f"A shirt costs ${original}. It's on sale for {discount}% off. What is the sale price?",
            expected_answer=final,
            explanation=f"Discount = ${original} × {discount}% = ${savings}. Sale price = ${original} - ${savings} = ${final}",
            hints=[
                f"Calculate {discount}% of ${original} first.",
                "Subtract the discount from the original price.",
            ],
        )

    def _rate_problem(self) -> Problem:
        """Generate rate/distance/time problem."""
        speed = self._rng.randint(3, 8) * 10
        time = self._rng.randint(2, 5)
        distance = speed * time

        problem_type = self._rng.randint(0, 2)

        if problem_type == 0:
            # Find distance
            return Problem(
                id=str(uuid.uuid4())[:8],
                task_type=TaskType.MATH,
                difficulty=Difficulty.MEDIUM,
                question=f"A car travels at {speed} mph for {time} hours. How far does it travel?",
                expected_answer=distance,
                explanation=f"Distance = Speed × Time = {speed} × {time} = {distance} miles",
                hints=["Use the formula: Distance = Speed × Time"],
            )
        elif problem_type == 1:
            # Find time
            return Problem(
                id=str(uuid.uuid4())[:8],
                task_type=TaskType.MATH,
                difficulty=Difficulty.MEDIUM,
                question=f"A car needs to travel {distance} miles at {speed} mph. How long will it take?",
                expected_answer=time,
                explanation=f"Time = Distance ÷ Speed = {distance} ÷ {speed} = {time} hours",
                hints=["Use the formula: Time = Distance ÷ Speed"],
            )
        else:
            # Find speed
            return Problem(
                id=str(uuid.uuid4())[:8],
                task_type=TaskType.MATH,
                difficulty=Difficulty.MEDIUM,
                question=f"A car travels {distance} miles in {time} hours. What is its speed?",
                expected_answer=speed,
                explanation=f"Speed = Distance ÷ Time = {distance} ÷ {time} = {speed} mph",
                hints=["Use the formula: Speed = Distance ÷ Time"],
            )

    def _complex_word(self) -> Problem:
        """Generate complex word problem."""
        adult_price = self._rng.randint(10, 20)
        child_price = self._rng.randint(5, adult_price - 2)
        num_adults = self._rng.randint(2, 4)
        num_children = self._rng.randint(1, 3)
        discount = self._rng.choice([10, 15, 20])

        subtotal = adult_price * num_adults + child_price * num_children
        discount_amount = subtotal * discount // 100
        total = subtotal - discount_amount

        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.MATH,
            difficulty=Difficulty.HARD,
            question=(
                f"Movie tickets cost ${adult_price} for adults and ${child_price} for children. "
                f"A family buys {num_adults} adult and {num_children} child ticket(s). "
                f"They have a {discount}% off coupon. What is the total cost?"
            ),
            expected_answer=total,
            explanation=(
                f"Adult tickets: {num_adults} × ${adult_price} = ${adult_price * num_adults}\n"
                f"Child tickets: {num_children} × ${child_price} = ${child_price * num_children}\n"
                f"Subtotal: ${subtotal}\n"
                f"Discount: ${discount_amount}\n"
                f"Total: ${total}"
            ),
            hints=[
                "Calculate the cost for adults and children separately.",
                "Add them to get the subtotal.",
                "Apply the discount to the subtotal.",
            ],
        )

    def _algebra(self) -> Problem:
        """Generate algebra problem."""
        x = self._rng.randint(2, 10)
        a = self._rng.randint(2, 5)
        b = self._rng.randint(1, 20)
        result = a * x + b

        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.MATH,
            difficulty=Difficulty.HARD,
            question=f"Solve for x: {a}x + {b} = {result}",
            expected_answer=x,
            explanation=f"{a}x + {b} = {result}\n{a}x = {result - b}\nx = {(result - b) // a}",
            hints=[
                "Subtract the constant from both sides.",
                "Divide both sides by the coefficient of x.",
            ],
        )

    def _probability(self) -> Problem:
        """Generate probability problem."""
        total = self._rng.choice([6, 8, 10, 12, 20])
        favorable = self._rng.randint(1, total - 1)

        from math import gcd
        g = gcd(favorable, total)
        num, den = favorable // g, total // g

        return Problem(
            id=str(uuid.uuid4())[:8],
            task_type=TaskType.MATH,
            difficulty=Difficulty.HARD,
            question=(
                f"A bag contains {total} marbles. {favorable} are red and the rest are blue. "
                f"What is the probability of drawing a red marble? (Express as a fraction)"
            ),
            expected_answer=f"{num}/{den}",
            explanation=f"P(red) = favorable/total = {favorable}/{total} = {num}/{den}",
            hints=[
                "Probability = favorable outcomes / total outcomes",
                "Simplify the fraction if possible.",
            ],
        )
