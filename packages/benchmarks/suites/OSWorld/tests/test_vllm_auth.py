"""Exercise the actual vLLM connector without provider SDKs or network calls."""

import importlib.util
import os
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch


class VllmAuthTest(unittest.TestCase):
    def setUp(self):
        completion = SimpleNamespace(
            usage=None, choices=[SimpleNamespace(message=SimpleNamespace(content="ok"))]
        )
        self.create = Mock(return_value=completion)
        self.client = Mock(
            return_value=SimpleNamespace(
                chat=SimpleNamespace(completions=SimpleNamespace(create=self.create))
            )
        )
        openai = ModuleType("openai")
        openai.OpenAI = self.client
        openai.AzureOpenAI = Mock()
        for name in ("APIConnectionError", "APIError", "RateLimitError"):
            setattr(openai, name, type(name, (Exception,), {}))
        anthropic = ModuleType("anthropic")
        anthropic.Anthropic = Mock()
        backoff = ModuleType("backoff")
        backoff.expo = object()
        backoff.on_exception = lambda *args, **kwargs: lambda fn: fn
        source = (
            Path(__file__).resolve().parents[1]
            / "mm_agents/os_symphony/core/engine.py"
        )
        spec = importlib.util.spec_from_file_location("osworld_vllm_auth_test", source)
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {
            "openai": openai, "anthropic": anthropic, "backoff": backoff
        }):
            spec.loader.exec_module(module)
        self.engine = module.LMMEnginevLLM

    def test_explicit_credentials_are_not_replaced_by_bundled_auth(self):
        with patch.dict(os.environ, {
            "vLLM_API_KEY": "environment-fixture",
            "vLLM_ENDPOINT_URL": "https://environment.example.invalid/v1",
        }, clear=True):
            engine = self.engine(
                api_key="explicit-fixture",
                base_url="https://explicit.example.invalid/v1",
                model="fixture-model",
            )
            self.assertEqual(engine.generate([]), ("ok", None))
            engine.generate([])
        self.client.assert_called_once_with(
            base_url="https://explicit.example.invalid/v1", api_key="explicit-fixture"
        )
        self.assertEqual(self.create.call_count, 2)

    def test_environment_credentials_are_forwarded_without_header_override(self):
        with patch.dict(os.environ, {
            "vLLM_API_KEY": "environment-fixture",
            "vLLM_ENDPOINT_URL": "https://environment.example.invalid/v1",
        }, clear=True):
            self.engine(model="fixture-model").generate([])
        self.client.assert_called_once_with(
            base_url="https://environment.example.invalid/v1",
            api_key="environment-fixture",
        )

    def test_missing_configuration_never_constructs_a_client(self):
        for env in ({}, {"vLLM_API_KEY": "environment-fixture"}):
            with self.subTest(env_names=list(env)), patch.dict(os.environ, env, clear=True):
                with self.assertRaises(ValueError):
                    self.engine(model="fixture-model").generate([])
        self.client.assert_not_called()


if __name__ == "__main__":
    unittest.main()
