"""
RLM client adapter for Eliza Python core.

This module wraps an optional RLM backend and exposes a minimal async-friendly
`infer(messages, opts)` interface.

Design principles:
- Eliza owns conversation state and message construction
- RLM only receives messages and returns a response
- No global state, no system prompt injection
- Safe stub behavior when RLM is not installed
"""

from typing import Any, Dict, List, Optional, Union
import asyncio
import os
import logging

log = logging.getLogger(__name__)

# Optional dependency: AgentRLM
try:
    from rlm import RLM  # type: ignore
except Exception as e:
    RLM = None
    log.debug("AgentRLM not available: %s", e)


class RLMClient:
    """
    Thin adapter exposing `infer(messages, opts)`.

    One RLM instance per client.
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {}
        self._rlm = None

        if RLM is not None:
            try:
                self._rlm = RLM(
                    backend=self.config.get(
                        "backend", os.getenv("ELIZA_RLM_BACKEND", "gemini")
                    ),
                    backend_kwargs=self.config.get("backend_kwargs", {}),
                    environment=self.config.get(
                        "environment", os.getenv("ELIZA_RLM_ENV", "local")
                    ),
                    max_iterations=int(
                        self.config.get(
                            "max_iterations",
                            os.getenv("ELIZA_RLM_MAX_ITERATIONS", "4"),
                        )
                    ),
                    max_depth=int(
                        self.config.get(
                            "max_depth",
                            os.getenv("ELIZA_RLM_MAX_DEPTH", "1"),
                        )
                    ),
                    verbose=str(
                        self.config.get(
                            "verbose",
                            os.getenv("ELIZA_RLM_VERBOSE", "false"),
                        )
                    ).lower()
                    in ("1", "true", "yes"),
                )
            except Exception as e:
                log.exception("Failed to initialize RLM: %s", e)
                self._rlm = None

    async def _completion(self, messages: List[Dict[str, str]]):
        """
        Run synchronous RLM completion in a thread to avoid blocking.
        """
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None, lambda: self._rlm.completion(messages)
        )

    async def infer(
        self,
        messages: Union[str, List[Dict[str, str]]],
        opts: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Perform inference using RLM.

        Parameters:
        - messages: list of {"role","content"} dicts OR a single prompt string
        - opts: optional generation parameters (currently unused by RLM)

        Returns:
        - dict with at least {"text": str}
        """

        if self._rlm is None:
            return {
                "text": "[RLM STUB] RLM backend not available",
                "metadata": {"stub": True},
            }

        # Normalize input
        if isinstance(messages, str):
            messages = [{"role": "user", "content": messages}]

        try:
            result = await self._completion(messages)
        except Exception as e:
            log.exception("RLM completion failed: %s", e)
            return {
                "text": "[RLM ERROR] Failed to generate response",
                "metadata": {"error": str(e)},
            }

        # Normalize output
        if hasattr(result, "response"):
            text = result.response or ""
        else:
            text = str(result)

        return {
            "text": text.strip(),
            "metadata": {"stub": False},
        }
