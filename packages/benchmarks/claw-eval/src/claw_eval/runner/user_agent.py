"""Simulated user agent — LLM-driven user for multi-turn dialogue evaluation."""

from __future__ import annotations

import random
import time

from openai import OpenAI

from ..models.message import Message


_SYSTEM_PROMPT = """\
你是一个模拟用户。你的任务是根据以下人设与AI助手进行对话。

## 你的人设
{persona}

## 规则
1. 始终保持人设角色，用自然口语回复，不要暴露你是AI
2. 根据助手的提问如实回答（基于你的人设信息）
3. 如果助手问了你人设中没有的信息，说"不太清楚具体数字"或类似自然回复
4. 如果助手已经给出了完整的计算结果和建议，且你没有更多问题，输出 [DONE]
5. 如果你对回答满意或助手已充分回答了你的问题，输出 [DONE]
6. 回复要简短自然，像真实用户一样（1-3句话）
"""


def _format_transcript(messages: list[Message]) -> str:
    """Format conversation messages into a readable transcript."""
    lines = []
    for msg in messages:
        if msg.role == "system":
            continue
        text = msg.text
        if not text:
            continue
        if msg.role == "user":
            if text.startswith("[user_agent]"):
                text = text[len("[user_agent]"):].strip()
            lines.append(f"[用户]: {text}")
        elif msg.role == "assistant":
            lines.append(f"[助手]: {text}")
    return "\n".join(lines)


class UserAgent:
    """Simulated user that generates responses via an LLM."""

    def __init__(
        self,
        model_id: str,
        api_key: str,
        base_url: str = "https://openrouter.ai/api/v1",
    ) -> None:
        self.client = OpenAI(api_key=api_key, base_url=base_url)
        self.model_id = model_id

    def generate_response(
        self,
        persona: str,
        conversation_messages: list[Message],
    ) -> str | None:
        """Generate a simulated user reply.

        Returns the reply text, or None if the user is satisfied ([DONE]).
        """
        system = _SYSTEM_PROMPT.format(persona=persona)
        transcript = _format_transcript(conversation_messages)
        user_msg = (
            f"以下是到目前为止的对话：\n\n{transcript}\n\n"
            "请根据你的人设回复助手的最新消息。如果你满意了就输出 [DONE]。"
        )

        max_retries = 30
        for attempt in range(max_retries):
            try:
                resp = self.client.chat.completions.create(
                    model=self.model_id,
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": user_msg},
                    ],
                    temperature=0.7,
                    max_tokens=65536,
                )
                text = (resp.choices[0].message.content or "").strip()
                if "[DONE]" in text:
                    return None
                if text:
                    return text
                return None
            except Exception as exc:
                delay = min(2 ** (attempt + 1), 16) + random.uniform(0, 1)
                print(
                    f"[user-agent-retry] {type(exc).__name__}, "
                    f"attempt {attempt + 1}/{max_retries}, waiting {delay:.1f}s ..."
                )
                time.sleep(delay)

        # All retries exhausted — gracefully end the conversation
        return None
