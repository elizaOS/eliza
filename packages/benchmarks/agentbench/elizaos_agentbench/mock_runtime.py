"""
Deterministic mock runtime for AgentBench harness validation.

This runtime is intentionally *not* a capable model. It exists to:
- exercise the full benchmark loop end-to-end
- emit syntactically valid actions for each adapter
- deterministically solve the bundled sample tasks

It should never be used for publishing benchmark scores.
"""

from __future__ import annotations

from dataclasses import dataclass
import re

from elizaos_agentbench.types import GenerateTextResult


@dataclass(frozen=True)
class MockGenerateTextResult:
    text: str


class SmartMockRuntime:
    """
    A small heuristic runtime that returns valid actions for our sample tasks.

    Implements the minimal interface expected by the benchmark (`generate_text` returning
    an object with `.text`).
    """

    def __init__(self) -> None:
        self._turn: int = 0

    async def generate_text(self, prompt: str) -> GenerateTextResult:
        self._turn += 1

        if not isinstance(prompt, str) or not prompt.strip():
            return MockGenerateTextResult(text="think")

        p = prompt
        pl = prompt.lower()

        # OS environment (bash)
        if "operating a linux terminal" in pl or "```bash" in p:
            return MockGenerateTextResult(text=self._handle_os(pl))

        # Database environment (SQL)
        if "writes sql queries" in pl or "database schema" in pl or "```sql" in p:
            return MockGenerateTextResult(text=self._handle_db(pl))

        # Knowledge Graph environment
        if "knowledge graph" in pl and "available operations" in pl:
            return MockGenerateTextResult(text=self._handle_kg(pl))

        # WebShop environment
        if "shopping assistant" in pl and "available actions" in pl:
            return MockGenerateTextResult(text=self._handle_webshop(p, pl))

        # Lateral thinking puzzles
        if "lateral thinking puzzle" in pl and "scenario" in pl:
            return MockGenerateTextResult(text=self._handle_lateral(pl))

        return MockGenerateTextResult(text="think")

    def _handle_os(self, pl: str) -> str:
        if "hello.txt" in pl and "test_dir" in pl:
            cmd = "mkdir -p test_dir && echo 'Hello, World!' > test_dir/hello.txt && echo TASK_COMPLETE"
        elif ".txt files" in pl and "count" in pl:
            cmd = "find . -maxdepth 1 -name \"*.txt\" | wc -l && echo TASK_COMPLETE"
        elif "largest file" in pl and "logs" in pl:
            cmd = "ls -S logs | head -1 && echo TASK_COMPLETE"
        else:
            cmd = "echo TASK_COMPLETE"
        return f"```bash\n{cmd}\n```"

    def _handle_db(self, pl: str) -> str:
        if "earn more than" in pl and "50000" in pl:
            query = "SELECT * FROM employees WHERE salary > 50000"
        elif "average salary" in pl and "department" in pl:
            query = "SELECT department, AVG(salary) as avg_salary FROM employees GROUP BY department"
        else:
            query = "SELECT 1"
        return f"```sql\n{query}\n```"

    def _handle_kg(self, pl: str) -> str:
        if "albert einstein" in pl and "born" in pl:
            return "answer[Germany]"
        if "nobel prize in physics" in pl and "people" in pl:
            return "answer[Albert Einstein, Marie Curie]"
        if "marie curie" in pl and "continent" in pl:
            return "answer[Europe]"
        return "answer[unknown]"

    def _handle_lateral(self, pl: str) -> str:
        if "asks for a glass of water" in pl and "bartender" in pl and "gun" in pl:
            return "guess[hiccups]"
        if "unopened package" in pl and "field" in pl and "dead" in pl:
            return "guess[parachute]"
        if "shoots her husband" in pl and "holds him under water" in pl:
            return "guess[photograph]"
        return "think"

    def _extract_page(self, prompt: str) -> str:
        m = re.search(r"\*\*Current Page:\*\*\s*([^\n]+)", prompt)
        if not m:
            return "home"
        return m.group(1).strip().lower()

    def _handle_webshop(self, prompt: str, pl: str) -> str:
        page = self._extract_page(prompt)

        wants_headphones = "wireless headphones" in pl and "black" in pl
        wants_highest_sports = "highest-rated" in pl and "sports" in pl

        if page == "home":
            if wants_headphones:
                return "search[headphones]"
            if wants_highest_sports:
                return "search[sports]"
            return "search[electronics]"

        if page == "search_results":
            if wants_headphones:
                return "click[P001]"
            if wants_highest_sports:
                return "click[P004]"
            return "click[P001]"

        if page == "product_detail":
            # If cart already shown, checkout
            if "\n**cart:**" in pl:
                return "checkout"

            if wants_headphones:
                if "color:" in pl and "selected: black" not in pl:
                    return "select_option[color, black]"
                return "add_to_cart"

            if wants_highest_sports:
                if "size:" in pl and "selected: 500ml" not in pl:
                    return "select_option[size, 500ml]"
                if "color:" in pl and "selected: blue" not in pl:
                    return "select_option[color, blue]"
                return "add_to_cart"

            return "add_to_cart"

        if page == "checkout_complete":
            return "think"

        return "think"

