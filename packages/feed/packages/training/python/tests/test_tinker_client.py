"""
Tests for the Babylon Tinker client wrapper.
"""

from __future__ import annotations

import asyncio
import os
import sys
import types
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.training import tinker_client as tinker_client_module
from src.training.tinker_client import (
    DEFAULT_TINKER_BASE_MODEL,
    TINKER_AVAILABLE,
    BabylonTinkerClient,
    TinkerConfig,
    resolve_tinker_base_model,
)

_skip_no_tinker = pytest.mark.skipif(
    not TINKER_AVAILABLE, reason="tinker package not installed"
)


class _Future:
    def __init__(self, value):
        self._value = value

    def result(self):
        return self._value


class _FakeSamplingClient:
    def __init__(self, model_path: str):
        self.model_path = model_path


class _StubTokenizer:
    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=True):
        del tokenize, add_generation_prompt
        return "|".join(message["content"] for message in messages)

    def encode(self, text, add_special_tokens=True):
        del add_special_tokens
        return [ord(char) for char in text]


class _AsyncFuture:
    def __init__(self, value):
        self._value = value

    async def result_async(self):
        return self._value


class _FakeTrainingClient:
    def __init__(self):
        self.saved_states: list[str] = []

    def get_tokenizer(self):
        return object()

    def save_weights_for_sampler(self, name: str):
        return _Future(types.SimpleNamespace(path=f"tinker://sampler/{name}"))

    def save_state(self, name: str):
        self.saved_states.append(name)
        return _Future(types.SimpleNamespace(path=f"tinker://state/{name}"))


class _FakeServiceClient:
    def __init__(self):
        self.loaded_state_path: str | None = None
        self.created_base_model: str | None = None

    def get_server_capabilities(self):
        return types.SimpleNamespace(
            supported_models=[
                types.SimpleNamespace(model_name="Qwen/Qwen3.5-4B"),
                types.SimpleNamespace(model_name="Qwen/Qwen3-30B-A3B-Instruct-2507"),
            ]
        )

    def create_lora_training_client(self, *, base_model: str, rank: int, **_kwargs):
        self.created_base_model = f"{base_model}:{rank}"
        return _FakeTrainingClient()

    def create_training_client_from_state(self, path: str, user_metadata=None):
        del user_metadata
        self.loaded_state_path = path
        return _FakeTrainingClient()

    def create_sampling_client(self, *, model_path: str):
        return _FakeSamplingClient(model_path)


@pytest.fixture
def fake_tinker(monkeypatch: pytest.MonkeyPatch):
    service_client = _FakeServiceClient()
    fake_module = types.SimpleNamespace(ServiceClient=lambda: service_client)
    monkeypatch.setenv("TINKER_API_KEY", "test-key")
    monkeypatch.setattr(tinker_client_module, "TINKER_AVAILABLE", True)
    monkeypatch.setattr(tinker_client_module, "tinker", fake_module)
    return service_client


def test_setup_can_resume_from_state(fake_tinker):
    client = BabylonTinkerClient(
        TinkerConfig(
            base_model="Qwen/Qwen3.5-4B",
            resume_from_state="tinker://state/prev",
        )
    )

    client.setup()

    assert fake_tinker.loaded_state_path == "tinker://state/prev"
    assert client.initial_state_path == "tinker://state/prev"
    assert client.current_state_path == "tinker://state/prev"
    assert client.initial_sampler_path == "tinker://sampler/babylon-initial"


def test_save_state_updates_current_state_ref(fake_tinker):
    client = BabylonTinkerClient(TinkerConfig(base_model="Qwen/Qwen3.5-4B"))
    client.setup()

    state_path = client.save_state("final-state")

    assert state_path == "tinker://state/final-state"
    assert client.current_state_path == "tinker://state/final-state"


def test_load_state_replaces_training_client(fake_tinker):
    client = BabylonTinkerClient(TinkerConfig(base_model="Qwen/Qwen3.5-4B"))
    client.setup()

    client.load_state("tinker://state/resume")

    assert fake_tinker.loaded_state_path == "tinker://state/resume"
    assert client.current_state_path == "tinker://state/resume"
    assert client.current_sampler_path == "tinker://sampler/babylon-loaded"


@_skip_no_tinker
@pytest.mark.asyncio
async def test_load_state_async_replaces_training_client_without_sync_sdk_calls():
    class AsyncTrainingClient(_FakeTrainingClient):
        async def save_weights_for_sampler_async(self, name: str):
            return _AsyncFuture(types.SimpleNamespace(path=f"tinker://sampler/{name}"))

    class AsyncServiceClient:
        def __init__(self):
            self.loaded_state_path: str | None = None

        async def create_training_client_from_state_async(self, path: str):
            self.loaded_state_path = path
            return AsyncTrainingClient()

        async def create_sampling_client_async(self, *, model_path: str):
            return _FakeSamplingClient(model_path)

    client = BabylonTinkerClient(TinkerConfig(base_model="Qwen/Qwen3.5-4B"))
    client._service_client = AsyncServiceClient()
    client._initialized = True

    await client.load_state_async("tinker://state/resume-async")

    assert client.service_client.loaded_state_path == "tinker://state/resume-async"
    assert client.current_state_path == "tinker://state/resume-async"
    assert client.current_sampler_path == "tinker://sampler/babylon-loaded"


def test_setup_accepts_tm_api_key_alias(monkeypatch: pytest.MonkeyPatch):
    service_client = _FakeServiceClient()
    fake_module = types.SimpleNamespace(ServiceClient=lambda: service_client)
    monkeypatch.delenv("TINKER_API_KEY", raising=False)
    monkeypatch.setenv("TM_API_KEY", "tml-test-key")
    monkeypatch.setattr(tinker_client_module, "TINKER_AVAILABLE", True)
    monkeypatch.setattr(tinker_client_module, "tinker", fake_module)

    client = BabylonTinkerClient(TinkerConfig(base_model="Qwen/Qwen3.5-4B"))
    client.setup()

    assert os.environ["TINKER_API_KEY"] == "tml-test-key"
    assert client.initial_sampler_path == "tinker://sampler/babylon-initial"


def test_default_tinker_model_is_live_qwen35():
    assert DEFAULT_TINKER_BASE_MODEL == "Qwen/Qwen3.5-4B"
    assert TinkerConfig().base_model == "Qwen/Qwen3.5-4B"


def test_resolve_tinker_base_model_normalizes_stale_alias():
    available_models = [
        "Qwen/Qwen3-30B-A3B-Instruct-2507",
        "Qwen/Qwen3.5-4B",
    ]

    resolved = resolve_tinker_base_model(
        "Qwen/Qwen3-30B-A3B-Instruct",
        available_models,
    )

    assert resolved == "Qwen/Qwen3-30B-A3B-Instruct-2507"


def test_setup_normalizes_stale_model_before_client_creation(fake_tinker):
    client = BabylonTinkerClient(TinkerConfig(base_model="Qwen/Qwen3-30B-A3B-Instruct"))

    client.setup()

    assert fake_tinker.created_base_model == "Qwen/Qwen3-30B-A3B-Instruct-2507:32"
    assert client.config.base_model == "Qwen/Qwen3-30B-A3B-Instruct-2507"


def test_setup_surfaces_billing_block(monkeypatch: pytest.MonkeyPatch, fake_tinker):
    class BillingBlockedServiceClient(_FakeServiceClient):
        def get_server_capabilities(self):
            raise RuntimeError(
                "Error code: 402 - {'detail': 'Access is blocked due to billing status. "
                "Please add payment at https://tinker-console.thinkingmachines.ai/billing/balance.'}"
            )

    fake_module = types.SimpleNamespace(ServiceClient=lambda: BillingBlockedServiceClient())
    monkeypatch.setattr(tinker_client_module, "tinker", fake_module)

    client = BabylonTinkerClient(TinkerConfig(base_model="Qwen/Qwen3.5-4B"))

    with pytest.raises(RuntimeError, match="billing status"):
        client.setup()


@_skip_no_tinker
@pytest.mark.asyncio
async def test_train_step_async_preserves_tensor_data_weights():
    class AsyncTrainingClient:
        async def forward_backward_async(self, data, loss_fn):
            assert loss_fn == "cross_entropy"
            assert data
            weights = data[0].loss_fn_inputs["weights"]
            assert hasattr(weights, "data")
            assert weights.data == [0.5, 0.5]
            return _AsyncFuture(
                types.SimpleNamespace(
                    loss_fn_outputs=[{"logprobs": np.array([-0.2, -0.4], dtype=np.float32)}]
                )
            )

        async def optim_step_async(self, _params):
            return _AsyncFuture(types.SimpleNamespace())

    client = BabylonTinkerClient(TinkerConfig(base_model="Qwen/Qwen3.5-4B"))
    client._training_client = AsyncTrainingClient()

    datum = tinker_client_module.TinkerDatum(
        input_tokens=[1, 2, 3],
        target_tokens=[2, 3],
        weights=[1.0, 1.0],
    )

    result = await client.train_step_async([datum], [0.5])

    assert result.num_samples == 1
    assert result.loss > 0.0


@pytest.mark.asyncio
async def test_setup_async_times_out_capability_lookup(monkeypatch: pytest.MonkeyPatch):
    class HangingServiceClient:
        async def get_server_capabilities_async(self):
            await asyncio.sleep(10)

    fake_module = types.SimpleNamespace(ServiceClient=lambda: HangingServiceClient())
    monkeypatch.setenv("TINKER_API_KEY", "test-key")
    monkeypatch.setattr(tinker_client_module, "TINKER_AVAILABLE", True)
    monkeypatch.setattr(tinker_client_module, "tinker", fake_module)

    client = BabylonTinkerClient(
        TinkerConfig(
            base_model="Qwen/Qwen3.5-4B",
            capabilities_timeout_seconds=1,
        )
    )

    with pytest.raises(RuntimeError, match="capability lookup timed out"):
        await client.setup_async()


@_skip_no_tinker
@pytest.mark.asyncio
async def test_sample_async_times_out_when_tinker_sampler_hangs():
    class HangingSamplingClient:
        async def sample_async(self, **_kwargs):
            await asyncio.sleep(10)

    client = BabylonTinkerClient(
        TinkerConfig(
            base_model="Qwen/Qwen3.5-4B",
            sampling_timeout_seconds=1,
        )
    )
    client._sampling_client = HangingSamplingClient()
    client._tokenizer = _StubTokenizer()

    with pytest.raises(RuntimeError, match="sampling request timed out"):
        await client.sample_async(
            [{"role": "user", "content": "hello"}],
            max_tokens=8,
        )


@_skip_no_tinker
def test_prepare_datum_truncates_prompt_to_max_sequence_length():
    client = BabylonTinkerClient(TinkerConfig(base_model="Qwen/Qwen3.5-4B"))
    client._tokenizer = _StubTokenizer()

    datum = client.prepare_datum(
        messages=[
            {"role": "system", "content": "system"},
            {"role": "user", "content": "x" * 20},
        ],
        completion="done",
        max_sequence_length=10,
    )

    assert len(datum.input_tokens) == 9
    assert len(datum.target_tokens) == 9
    assert len(datum.weights) == 9
    assert datum.target_tokens[-4:] == [ord("d"), ord("o"), ord("n"), ord("e")]


@_skip_no_tinker
def test_prepare_datum_from_tokens_truncates_to_tail_window():
    client = BabylonTinkerClient(TinkerConfig(base_model="Qwen/Qwen3.5-4B"))

    datum = client.prepare_datum_from_tokens(
        tokens=list(range(12)),
        masks=[-100] * 8 + [1, 1, 1, 1],
        max_sequence_length=6,
    )

    assert datum.input_tokens == [6, 7, 8, 9, 10]
    assert datum.target_tokens == [7, 8, 9, 10, 11]
    assert datum.weights == [0.0, 1.0, 1.0, 1.0, 1.0]
