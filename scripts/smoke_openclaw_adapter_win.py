"""Windows smoke-test for openclaw-adapter (no benchmark harness).

Verifies two things on Windows:
  1. CLI path: ``openclaw --version`` is reachable via the .cmd wrapper.
  2. Direct OpenAI-compatible path: a tiny tool call against Cerebras
     gpt-oss-120b round-trips cleanly.
"""
import os
from openclaw_adapter.client import OpenClawClient


def main() -> int:
    client_cli = OpenClawClient(provider="cerebras", model="gpt-oss-120b")
    health = client_cli.health()
    print("CLI health:", health)

    client_direct = OpenClawClient(
        provider="cerebras",
        model="gpt-oss-120b",
        direct_openai_compatible=True,
    )
    ctx = {
        "messages": [
            {
                "role": "user",
                "content": "Use the add tool to compute 2 + 3. Reply with only the tool call.",
            }
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "add",
                    "description": "Add two integers",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "a": {"type": "integer"},
                            "b": {"type": "integer"},
                        },
                        "required": ["a", "b"],
                    },
                },
            }
        ],
        "tool_choice": "auto",
    }
    resp = client_direct.send_message("", context=ctx)
    print("Direct text:", repr(resp.text[:160]))
    print("Direct tool_calls:", resp.params.get("tool_calls"))
    ok = health.get("status") == "ready" and bool(resp.params.get("tool_calls"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
