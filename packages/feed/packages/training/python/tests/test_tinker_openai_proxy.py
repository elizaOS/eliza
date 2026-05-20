from __future__ import annotations

import importlib.util
from pathlib import Path
from unittest import TestCase

import pytest

MODULE_PATH = Path(__file__).resolve().parent.parent / "scripts" / "tinker_openai_proxy.py"
if not MODULE_PATH.exists():
    pytest.skip(
        f"Required script not found: {MODULE_PATH}",
        allow_module_level=True,
    )
SPEC = importlib.util.spec_from_file_location("tinker_openai_proxy", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class TinkerOpenAIProxyTests(TestCase):
    def test_infers_json_prefix_for_json_only_prompts(self) -> None:
        prefix = MODULE._infer_assistant_prefix(
            [
                {
                    "role": "system",
                    "content": (
                        'Output valid JSON only. The first character of your reply must be "{".'
                    ),
                },
                {"role": "user", "content": "Take one action."},
            ]
        )

        self.assertEqual(prefix, "{")

    def test_infers_xml_prefix_for_xml_only_prompts(self) -> None:
        prefix = MODULE._infer_assistant_prefix(
            [
                {
                    "role": "system",
                    "content": "Respond only with valid XML and start immediately with <",
                }
            ]
        )

        self.assertEqual(prefix, "<")

    def test_leaves_free_form_prompts_unprefixed(self) -> None:
        prefix = MODULE._infer_assistant_prefix(
            [{"role": "user", "content": "Tell me what you think about markets."}]
        )

        self.assertIsNone(prefix)
