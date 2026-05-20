from hermes_adapter.swe_env_smoke import _extract_python


def test_extract_python_preserves_prompt_imports_for_fenced_function_response() -> None:
    prompt = (
        "Complete the function.\n\n"
        "from typing import List\n\n"
        "def has_close_elements(numbers: List[float], threshold: float) -> bool:\n"
    )
    response = (
        "```python\n"
        "def has_close_elements(numbers: List[float], threshold: float) -> bool:\n"
        "    return False\n"
        "```"
    )

    code = _extract_python(response, prompt=prompt)

    assert code.startswith("from typing import List\n")
    assert "def has_close_elements" in code


def test_extract_python_strips_unterminated_opening_fence() -> None:
    code = _extract_python("```python\ndef answer():\n    return 1")

    assert code == "def answer():\n    return 1\n"
