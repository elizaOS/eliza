
import asyncio
from typing import Any

from sweagent.agent.models import AbstractModel, GenericAPIModelConfig, InstanceStats
from sweagent.tools.tools import ToolConfig
from sweagent.types import History


class OrchestratorModelConfig(GenericAPIModelConfig):
    name: str = "orchestrator"

class OrchestratorModel(AbstractModel):
    def __init__(self, config: OrchestratorModelConfig, tools: ToolConfig, orchestrator_runtime: Any):
        # We pass GenericAPIModelConfig to super, though really we just need to satisfy the type.
        super().__init__(config, tools)
        self.config = config
        self.orchestrator_runtime = orchestrator_runtime
        self.tools = tools
        self.stats = InstanceStats()
        self._loop = asyncio.new_event_loop()
        # We might need a thread to run the loop if we are called from a sync context 
        # that doesn't have a loop, or if we need to block.
        # But `sweagent` is running in the main thread usually.
        # If `providers.py` runs `agent.step()` in a thread, we can use `asyncio.run`.
        # If `providers.py` runs `agent.step()` in the main async loop, we are in trouble because `query` is blocking.
        
        # Assumption: `SWEAgentProvider` will run `agent.step()` in a strictly synchronous manner 
        # (potentially in a `run_in_executor`).
        
    def query(self, history: History, action_prompt: str = "> ") -> dict[str, Any]:
        """Synchronous query method that bridges to async runtime."""
        messages = self._history_to_messages(history)
        
        # We need to run the async use_model. 
        # If there is a running loop, we can't use run_until_complete easily unless we are in a separate thread.
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
            
        if loop and loop.is_running():
            # We are inside an async loop. This is bad for a sync method called from that loop.
            # We must fail or assume we are wrapped.
            # However, we can try to use a future if we can yield? No, `query` returns dict.
            raise RuntimeError("OrchestratorModel.query called from running event loop. Use executor.")
        
        return asyncio.run(self._async_query(messages))

    async def _async_query(self, messages: list[dict[str, str]]) -> dict[str, Any]:
        # Construct parameters for runtime.use_model
        params = {
            "messages": messages,
            "model": self.config.name,
            # Tools?
        }
        if self.tools and self.tools.tools:
            params["tools"] = self.tools.tools
            
        # Call the runtime
        # We assume `use_model` returns the generic LLM response format.
        response = await self.orchestrator_runtime.use_model(params)
        
        # Convert response to what sweagent expects
        # sweagent expects a dict with "message" and optional "tool_calls".
        
        return {
            "message": response.get("content", ""),
            "tool_calls": response.get("tool_calls", []),
            "thinking_blocks": response.get("thinking_blocks", [])
        }

    def _history_to_messages(self, history: History) -> list[dict[str, str]]:
        # helper to convert sweagent history to standard messages
        messages = []
        for item in history:
            role = item.get("role", "user")
            content = item.get("content", "")
            # Handle tool calls / outputs if necessary
            msg = {"role": role, "content": content}
            if "tool_calls" in item:
                msg["tool_calls"] = item["tool_calls"]
            if "tool_call_ids" in item:
                msg["tool_call_ids"] = item["tool_call_ids"]
            messages.append(msg)
        return messages
