"""
RLM client adapter that wraps your AgentRLM usage.

This module imports and re-uses the RLM() usage pattern from your AgentRLM repo:
- creates a singleton RLM instance and system prompt
- exposes an async-friendly `infer(prompt_or_messages, opts)` method

Assumptions:
- The AgentRLM package is importable (i.e. repo installed or on PYTHONPATH)
- AgentRLM exposes `RLM` and `load_character_prompt` as in your snippet
"""

from typing import Any, Dict, List, Optional, Union
import asyncio
import os
import logging

log = logging.getLogger(__name__)

# Try to import the AgentRLM bindings (these names come from your snippet)
try:
    # These imports match your AgentRLM snippet:
    # from rlm import RLM
    # from prompt_builder import load_character_prompt
    from rlm import RLM  # type: ignore
    from prompt_builder import load_character_prompt  # type: ignore
except Exception as e:
    RLM = None  # fallback; infer will return stub if import missing
    load_character_prompt = None  # type: ignore
    log.debug("AgentRLM imports unavailable: %s", e)


# Module-level singletons (mirrors the get_rlm pattern)
_rlm_instance: Optional[Any] = None
_SYSTEM_PROMPT: Optional[str] = None


def _init_rlm_if_needed(config: Optional[Dict[str, Any]] = None):
    """
    Initialize the RLM singleton and system prompt lazily.
    config can override model/backend/etc. (optional).
    Returns tuple (rlm_instance_or_None, system_prompt_str)
    """
    global _rlm_instance, _SYSTEM_PROMPT

    if _SYSTEM_PROMPT is None:
        if load_character_prompt:
            try:
                _SYSTEM_PROMPT = load_character_prompt()
            except Exception as e:
                log.exception("load_character_prompt failed: %s", e)
                _SYSTEM_PROMPT = "You are a helpful assistant."
        else:
            _SYSTEM_PROMPT = "You are a helpful assistant."

    if _rlm_instance is None:
        if RLM is None:
            # No real RLM available; keep None and let callers get a stub response
            return None, _SYSTEM_PROMPT

        cfg = config or {}
        backend = cfg.get("backend", os.getenv("ELIZA_RLM_BACKEND", "gemini"))
        backend_kwargs = cfg.get("backend_kwargs", {})
        environment = cfg.get("environment", os.getenv("ELIZA_RLM_ENV", "local"))
        try:
            max_iterations = int(cfg.get("max_iterations", os.getenv("ELIZA_RLM_MAX_ITERATIONS", "4")))
        except Exception:
            max_iterations = 4
        try:
            max_depth = int(cfg.get("max_depth", os.getenv("ELIZA_RLM_MAX_DEPTH", "1")))
        except Exception:
            max_depth = 1
        verbose = cfg.get("verbose", os.getenv("ELIZA_RLM_VERBOSE", "false")).lower() in ("1", "true", "yes")

        try:
            _rlm_instance = RLM(
                backend=backend,
                backend_kwargs=backend_kwargs,
                environment=environment,
                max_iterations=max_iterations,
                max_depth=max_depth,
                verbose=verbose,
            )
        except Exception as e:
            log.exception("Failed to construct RLM instance: %s", e)
            _rlm_instance = None

    return _rlm_instance, _SYSTEM_PROMPT


async def _call_completion_in_thread(rlm_obj, messages: List[Dict[str, str]]):
    """
    Call rlm.completion synchronously in a thread, return the result.
    AgentRLM's .completion may be sync; run it in a thread so this function is async-friendly.
    """
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: rlm_obj.completion(messages))


class RLMClient:
    """
    Thin adapter exposing `infer(prompt_or_messages, opts)`.

    opts can include:
      - model, max_tokens, temperature, top_p, stop_sequences, user, stream, history, etc.
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {}

    async def infer(
        self,
        prompt_or_messages: Union[str, List[Dict[str, str]]],
        opts: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        opts = opts or {}

        # ensure RLM is initialized and get system prompt
        rlm, system_prompt = _init_rlm_if_needed(self.config)

        # If RLM import failed, return a safe stub
        if rlm is None:
            stub_text = f"[RLM STUB] {prompt_or_messages if isinstance(prompt_or_messages, str) else prompt_or_messages[:1]}"
            return {"text": stub_text, "metadata": {"stub": True}}

        # Build messages: if caller passed a list of role/content dicts, use it.
        if isinstance(prompt_or_messages, list):
            messages = prompt_or_messages
        else:
            # prompt_or_messages is a single prompt string, combine with system prompt
            messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": prompt_or_messages}]

        # Optionally extend messages with history provided in opts (list of role/content dicts)
        history = opts.get("history")
        if isinstance(history, list) and history:
            # Ensure we don't duplicate system prompt if already present
            if not (messages and messages[0].get("role") == "system"):
                messages = [{"role": "system", "content": system_prompt}] + history + messages
            else:
                messages = [messages[0]] + history + messages[1:]

        # Map other options for future use; AgentRLM may accept additional kwargs in completion
        # For now we call completion with messages only (keeping adapter narrow)
        try:
            result = await _call_completion_in_thread(rlm, messages)
        except Exception as e:
            log.exception("RLM completion failed: %s", e)
            return {"text": "[RLM ERROR] Failed to generate response", "metadata": {"error": str(e)}}

        # AgentRLM result shape: many RLM implementations offer .response or string conversion
        text = ""
        if hasattr(result, "response"):
            try:
                text = getattr(result, "response") or ""
            except Exception:
                text = ""
        else:
            try:
                text = str(result)
            except Exception:
                text = ""

        return {"text": text.strip(), "metadata": {"stub": False}}