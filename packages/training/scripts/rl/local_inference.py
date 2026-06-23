from __future__ import annotations

import gc
import inspect
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

BackendName = Literal["mlx", "cuda", "cpu"]
CacheImplementation = Literal["dynamic", "turboquant"]
ROLE_ARTIFACT_PATTERN = re.compile(
    r"(?m)(<\|im_start\|>|<\|endoftext\|>|^(?:System|User|Human|Assistant):)"
)
THINK_TAG_PATTERN = re.compile(r"<think>([\s\S]*?)</think>", re.I)
THOUGHT_TAG_PATTERN = re.compile(r"<thought>([\s\S]*?)</thought>", re.I)

if TYPE_CHECKING:
    from .turboquant import TurboQuantSettings


def format_messages_as_text(
    tokenizer: Any,
    messages: list[dict[str, str]],
    *,
    add_generation_prompt: bool = False,
    assistant_prefix: str | None = None,
) -> str:
    if not messages:
        return ""

    chat_template = getattr(tokenizer, "chat_template", None)
    if chat_template:
        try:
            if assistant_prefix is not None:
                template_messages = [
                    *messages,
                    {"role": "assistant", "content": assistant_prefix},
                ]
                kwargs: dict[str, Any] = {
                    "tokenize": False,
                    "add_generation_prompt": False,
                }
                parameters = inspect.signature(tokenizer.apply_chat_template).parameters
                if "continue_final_message" in parameters:
                    kwargs["continue_final_message"] = True
                return tokenizer.apply_chat_template(template_messages, **kwargs)

            return tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=add_generation_prompt,
            )
        except Exception:
            pass

    role_prefix = {
        "system": "System",
        "user": "User",
        "assistant": "Assistant",
    }
    rendered = [
        f"{role_prefix.get(str(message.get('role', 'user')).lower(), 'User')}: "
        f"{str(message.get('content', '')).strip()}"
        for message in messages
        if message.get("content")
    ]
    if assistant_prefix is not None:
        rendered.append(f"Assistant: {assistant_prefix}")
    elif add_generation_prompt:
        rendered.append("Assistant:")
    return "\n\n".join(rendered)


def clean_generated_text(text: str) -> str:
    cleaned = str(text or "").replace("<end_of_turn>", "").strip()
    if not cleaned:
        return ""

    match = ROLE_ARTIFACT_PATTERN.search(cleaned)
    if match and match.start() > 0:
        cleaned = cleaned[: match.start()].rstrip()

    cleaned = THINK_TAG_PATTERN.sub("", cleaned)
    cleaned = THOUGHT_TAG_PATTERN.sub("", cleaned)
    return cleaned.strip()


def restore_assistant_prefix(generated: str, assistant_prefix: str | None) -> str:
    cleaned = str(generated or "").strip()
    if assistant_prefix is None:
        return cleaned
    if cleaned.lower().startswith(assistant_prefix.lower()):
        return cleaned
    if not cleaned:
        return assistant_prefix.strip()
    return f"{assistant_prefix}{cleaned.lstrip()}"


def extract_reasoning_trace(text: str) -> str | None:
    matches: list[str] = []
    for pattern in (THINK_TAG_PATTERN, THOUGHT_TAG_PATTERN):
        matches.extend(match.group(1).strip() for match in pattern.finditer(text))
    joined = " ".join(fragment for fragment in matches if fragment)
    normalized = " ".join(joined.split())
    return normalized or None


@dataclass
class GenerationResult:
    text: str
    raw_text: str
    reasoning_trace: str | None = None

    @property
    def reasoning_available(self) -> bool:
        return bool(self.reasoning_trace)


@dataclass
class LocalTextGenerator:
    backend: BackendName
    model_ref: str
    adapter_path: str | None = None
    cache_implementation: CacheImplementation = "dynamic"
    turboquant_settings: TurboQuantSettings | None = None

    def __post_init__(self) -> None:
        self.model: Any | None = None
        self.tokenizer: Any | None = None
        self.device: str = "cpu"
        self._generate = None
        self._sampler = None
        self._load()

    def _load(self) -> None:
        if self.backend == "mlx":
            from mlx_lm import generate, load  # type: ignore

            self.model, self.tokenizer = load(
                self.model_ref,
                adapter_path=self.adapter_path,
            )
            self._generate = generate
            try:
                from mlx_lm.sample_utils import make_sampler  # type: ignore

                self._sampler = make_sampler(temp=0.0)
            except Exception:
                self._sampler = None
            return

        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self.tokenizer = AutoTokenizer.from_pretrained(
            self.model_ref,
            trust_remote_code=True,
        )
        if self.tokenizer.pad_token is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token

        model_kwargs: dict[str, Any] = {
            "trust_remote_code": True,
        }
        if self.backend == "cuda":
            model_kwargs["torch_dtype"] = torch.float16
            model_kwargs["device_map"] = "auto"
            self.device = "cuda"
        else:
            model_kwargs["torch_dtype"] = torch.float32
            model_kwargs["low_cpu_mem_usage"] = True
            self.device = "cpu"

        self.model = AutoModelForCausalLM.from_pretrained(
            self.model_ref,
            **model_kwargs,
        )
        if self.backend == "cpu":
            self.model.to("cpu")
        self.model.eval()

    def generate_messages(
        self,
        messages: list[dict[str, str]],
        *,
        max_new_tokens: int = 120,
        assistant_prefix: str | None = None,
        return_details: bool = False,
    ) -> str | GenerationResult:
        if self.backend == "mlx":
            assert self.tokenizer is not None
            assert self._generate is not None
            rendered = format_messages_as_text(
                self.tokenizer,
                messages,
                add_generation_prompt=assistant_prefix is None,
                assistant_prefix=assistant_prefix,
            )
            kwargs: dict[str, Any] = {
                "prompt": rendered,
                "max_tokens": max_new_tokens,
                "verbose": False,
            }
            if self._sampler is not None:
                kwargs["sampler"] = self._sampler
            raw_generated = str(self._generate(self.model, self.tokenizer, **kwargs)).strip()
            generated = clean_generated_text(raw_generated)
            restored = restore_assistant_prefix(generated, assistant_prefix)
            if return_details:
                return GenerationResult(
                    text=restored,
                    raw_text=raw_generated,
                    reasoning_trace=extract_reasoning_trace(raw_generated),
                )
            return restored

        import torch

        assert self.tokenizer is not None
        assert self.model is not None
        rendered = format_messages_as_text(
            self.tokenizer,
            messages,
            add_generation_prompt=assistant_prefix is None,
            assistant_prefix=assistant_prefix,
        )
        inputs = self.tokenizer(rendered, return_tensors="pt")
        if self.device == "cuda":
            inputs = {key: value.cuda() for key, value in inputs.items()}

        with torch.inference_mode():
            generation_kwargs: dict[str, Any] = {
                **inputs,
                "max_new_tokens": max_new_tokens,
                "do_sample": False,
                "pad_token_id": self.tokenizer.eos_token_id,
            }
            cache_implementation = getattr(self, "cache_implementation", "dynamic")
            turboquant_settings = getattr(self, "turboquant_settings", None)
            if cache_implementation != "dynamic":
                from turboquant import build_generation_cache

                cache = build_generation_cache(
                    self.model.config,
                    cache_implementation=cache_implementation,
                    turboquant_settings=turboquant_settings,
                )
                if cache is not None:
                    generation_kwargs["past_key_values"] = cache
            outputs = self.model.generate(**generation_kwargs)
        prompt_tokens = inputs["input_ids"].shape[1]
        raw_generated = self.tokenizer.decode(
            outputs[0][prompt_tokens:],
            skip_special_tokens=True,
        ).strip()
        generated = clean_generated_text(raw_generated)
        restored = restore_assistant_prefix(generated, assistant_prefix)
        if return_details:
            return GenerationResult(
                text=restored,
                raw_text=raw_generated,
                reasoning_trace=extract_reasoning_trace(raw_generated),
            )
        return restored

    def close(self) -> None:
        model = self.model
        tokenizer = self.tokenizer
        self.model = None
        self.tokenizer = None
        self._generate = None
        self._sampler = None
        del model
        del tokenizer
        gc.collect()
        if self.backend == "cuda":
            try:
                import torch

                torch.cuda.empty_cache()
            except Exception:
                pass
