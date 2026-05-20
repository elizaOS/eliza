#!/usr/bin/env python3
"""Feed-owned Hermes JSONL bridge used by ScamBench and training harnesses."""

from __future__ import annotations

import argparse
import contextlib
import json
import sys
import traceback
from pathlib import Path
from typing import Any


def workspace_root() -> Path:
    return Path(__file__).resolve().parents[3]


def hermes_root() -> Path:
    candidates = (
        workspace_root() / "external-sources" / "hermes-agent",
        workspace_root() / "hermes-agent",
    )
    return next((candidate for candidate in candidates if candidate.exists()), candidates[0])


HERMES_ROOT = hermes_root()
sys.path.insert(0, str(HERMES_ROOT))

from run_agent import AIAgent


NO_TOOLS_TOOLSET = "__hermes_benchmark_no_tools__"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run Hermes as a JSONL benchmark bridge over stdin/stdout.",
    )
    parser.add_argument("--model", required=True, help="Model id to use.")
    parser.add_argument("--base-url", required=True, help="OpenAI-compatible base URL.")
    parser.add_argument("--api-key", default="benchmark-local", help="API key for the model endpoint.")
    parser.add_argument("--max-iterations", type=int, default=4, help="Maximum Hermes loop iterations per request.")
    parser.add_argument(
        "--skip-memory",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Disable Hermes memory during benchmark runs.",
    )
    parser.add_argument(
        "--no-tools",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Disable Hermes tools during benchmark runs.",
    )
    parser.add_argument(
        "--rebuild-agent-per-request",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Recreate the Hermes agent for each benchmark request.",
    )
    return parser


def build_agent(args: argparse.Namespace) -> AIAgent:
    enabled_toolsets = [NO_TOOLS_TOOLSET] if args.no_tools else None
    with contextlib.redirect_stdout(sys.stderr):
        agent = AIAgent(
            base_url=args.base_url,
            api_key=args.api_key,
            provider="custom",
            model=args.model,
            max_iterations=args.max_iterations,
            enabled_toolsets=enabled_toolsets,
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=args.skip_memory,
            save_trajectories=False,
        )
    if args.no_tools:
        agent.valid_tool_names = set()
        agent.tools = [] if agent.api_mode == "codex_responses" else None
    return agent


def _coerce_history(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    history: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = item.get("content")
        if not isinstance(role, str) or not isinstance(content, str):
            continue
        normalized = {"role": role, "content": content}
        for key in ("name", "tool_call_id", "tool_calls", "reasoning", "reasoning_details"):
            candidate = item.get(key)
            if candidate is not None:
                normalized[key] = candidate
        history.append(normalized)
    return history


def handle_request(agent: AIAgent, payload: dict[str, Any], *, no_tools: bool) -> dict[str, Any]:
    user_message = payload.get("userMessage") or payload.get("user_message")
    if not isinstance(user_message, str) or not user_message.strip():
        raise ValueError("Request is missing userMessage")

    system_message = payload.get("systemMessage") or payload.get("system_message")
    if system_message is not None and not isinstance(system_message, str):
        raise ValueError("systemMessage must be a string when provided")

    conversation_history = _coerce_history(
        payload.get("conversationHistory") or payload.get("conversation_history")
    )

    system_text = system_message.strip() if isinstance(system_message, str) else ""
    messages = list(conversation_history)
    messages.append({"role": "user", "content": user_message})

    api_messages = []
    for message in messages:
        api_messages.append(
            {
                key: value
                for key, value in message.items()
                if key in {"role", "content", "name", "tool_call_id", "tool_calls"}
            }
        )
    if system_text:
        api_messages = [{"role": "system", "content": system_text}] + api_messages

    api_kwargs = agent._build_api_kwargs(api_messages)
    if no_tools and agent.api_mode == "codex_responses":
        api_kwargs["tools"] = []

    with contextlib.redirect_stdout(sys.stderr):
        response = agent._interruptible_api_call(api_kwargs)

    final_response = ""
    if agent.api_mode == "chat_completions":
        choices = getattr(response, "choices", None) or []
        if choices:
            final_response = str(getattr(choices[0].message, "content", "") or "")
    elif agent.api_mode == "anthropic_messages":
        content_blocks = getattr(response, "content", None) or []
        final_response = "".join(
            getattr(block, "text", "")
            for block in content_blocks
            if getattr(block, "type", "") == "text"
        )
    elif agent.api_mode == "codex_responses":
        assistant_message, _finish_reason = agent._normalize_codex_response(response)
        final_response = str(getattr(assistant_message, "content", "") or "")

    return {
        "ok": True,
        "finalResponse": final_response,
        "completed": bool(final_response.strip()),
        "apiCalls": 1,
    }


def serve(args: argparse.Namespace, agent: AIAgent | None = None) -> int:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            payload = json.loads(line)
            if not isinstance(payload, dict):
                raise ValueError("Request payload must be a JSON object")

            request_type = payload.get("type", "complete")
            if request_type == "close":
                print(json.dumps({"ok": True, "closed": True}), flush=True)
                return 0
            if request_type != "complete":
                raise ValueError(f"Unsupported request type: {request_type}")

            request_agent = build_agent(args) if args.rebuild_agent_per_request else agent
            if request_agent is None:
                raise ValueError("Hermes benchmark bridge agent is not initialized")
            response = handle_request(request_agent, payload, no_tools=args.no_tools)
        except Exception as exc:  # noqa: BLE001
            response = {
                "ok": False,
                "error": str(exc),
                "traceback": traceback.format_exc(limit=6),
            }

        print(json.dumps(response, ensure_ascii=False), flush=True)

    return 0


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    agent = None if args.rebuild_agent_per_request else build_agent(args)
    return serve(args, agent)


if __name__ == "__main__":
    raise SystemExit(main())
