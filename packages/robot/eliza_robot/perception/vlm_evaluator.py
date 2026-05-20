"""VLM-as-judge evaluator for robot sim/real rollouts.

Reference impl. Promotion target: `eliza_robot/perception/vlm_evaluator.py`.

Given a curriculum `TaskSpec` and a MuJoCo sim render (and optionally an
onboard camera frame), this module asks Claude to grade each success
criterion from `tasks.yaml`, produce pass/fail + confidence, and emit a
short critique + actionable suggestions. See `DESIGN.md` next door.

No defensive code: missing API key, network failure, schema violation
all raise. The script layer is the only place that swallows per-prompt
failures so a multi-prompt sweep can continue. See `AGENTS.md`.
"""

from __future__ import annotations

import base64
import io
import os
from typing import Any, Protocol

import numpy as np
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field

# Promotion target: `from eliza_robot.curriculum.loader import TaskSpec`.
try:
    from eliza_robot.curriculum.loader import TaskSpec
except Exception:
    TaskSpec = Any  # type: ignore[misc,assignment]


# ---- Pydantic schemas (see DESIGN.md §2, §5) -------------------------

class CriterionResult(BaseModel):
    model_config = ConfigDict(frozen=True)
    name: str
    target: str
    observation: str
    satisfied: bool
    confidence: float = Field(ge=0.0, le=1.0)


class EvalResult(BaseModel):
    model_config = ConfigDict(frozen=True)
    task_id: str
    passed: bool
    confidence: float = Field(ge=0.0, le=1.0)
    critique: str
    suggestions: list[str]
    criteria: list[CriterionResult]
    model: str
    raw_response: dict


# ---- Tool schema — what we ask Claude to call -----------------------

_RECORD_EVALUATION_TOOL: dict = {
    "name": "record_evaluation",
    "description": "Record the structured evaluation of the robot's attempt.",
    "input_schema": {
        "type": "object",
        "required": ["passed", "confidence", "critique", "suggestions", "criteria"],
        "properties": {
            "passed": {"type": "boolean"},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "critique": {"type": "string"},
            "suggestions": {
                "type": "array",
                "items": {"type": "string"},
                "maxItems": 5,
            },
            "criteria": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": [
                        "name", "target", "observation", "satisfied", "confidence",
                    ],
                    "properties": {
                        "name": {"type": "string"},
                        "target": {"type": "string"},
                        "observation": {"type": "string"},
                        "satisfied": {"type": "boolean"},
                        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    },
                },
            },
        },
    },
}


# ---- Backend protocol + Anthropic implementation --------------------

class VLMBackend(Protocol):
    model_name: str

    async def judge(
        self,
        system_prompt: str,
        user_text: str,
        images: list[bytes],
        tool_schema: dict,
    ) -> dict: ...


class MockBackend:
    """Deterministic backend that produces a plausible structured eval
    without calling any API. Used when ANTHROPIC_API_KEY is not set so
    the e2e architecture can be exercised end-to-end in CI / smoke runs.

    Strategy: parse `user_text` for the task-id line ("**Task id:** ..."),
    look up the curriculum's `success:` block, claim the criteria are
    satisfied with a fixed confidence, and stitch a critique that
    references the actual criterion names so it's recognizably "about"
    the right task.
    """

    model_name: str = "mock"

    async def judge(
        self,
        system_prompt: str,
        user_text: str,
        images: list[bytes],
        tool_schema: dict,
    ) -> dict:
        import re

        task_id = "unknown"
        match = re.search(r"\*\*Task id:\*\*\s*([a-zA-Z0-9_-]+)", user_text)
        if match:
            task_id = match.group(1)

        # Extract the bulleted success-criteria names so the critique
        # mentions them by name (verifies the prompt is well-formed).
        crit_names = re.findall(r"^  - \*\*([^*]+)\*\*", user_text, flags=re.MULTILINE)
        if not crit_names:
            crit_names = ["task_completion"]

        criteria = [
            {
                "name": n,
                "target": "per spec",
                "observation": f"appears consistent with target for {n}",
                "satisfied": True,
                "confidence": 0.70,
            }
            for n in crit_names[:5]
        ]
        n_imgs = len(images)
        critique = (
            f"Mock VLM eval for task `{task_id}`. {n_imgs} frame(s) inspected. "
            f"Each criterion ({', '.join(crit_names[:3])}) checked. "
            "Replace MockBackend with AnthropicBackend by setting "
            "ANTHROPIC_API_KEY to get a real critique."
        )
        return {
            "passed": True,
            "confidence": 0.65,
            "critique": critique,
            "suggestions": [
                "set ANTHROPIC_API_KEY to enable real VLM grading",
                "increase episode duration so the agent reaches steady state",
            ],
            "criteria": criteria,
        }


class AnthropicBackend:
    """Anthropic Claude backend. The only backend shipped today."""

    def __init__(self, model: str = "claude-opus-4-7") -> None:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError(
                "ANTHROPIC_API_KEY not set; required for VLMEvaluator(AnthropicBackend)"
            )
        # Lazy import so test envs without the SDK can still read schemas.
        from anthropic import AsyncAnthropic

        self._client = AsyncAnthropic(api_key=api_key)
        self.model_name = model

    async def judge(
        self,
        system_prompt: str,
        user_text: str,
        images: list[bytes],
        tool_schema: dict,
    ) -> dict:
        content: list[dict] = []
        for png_bytes in images:
            b64 = base64.standard_b64encode(png_bytes).decode("ascii")
            content.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": b64,
                },
            })
        content.append({"type": "text", "text": user_text})

        resp = await self._client.messages.create(
            model=self.model_name,
            max_tokens=1024,
            temperature=0.0,
            system=system_prompt,
            tools=[tool_schema],
            tool_choice={"type": "tool", "name": tool_schema["name"]},
            messages=[{"role": "user", "content": content}],
        )

        # Forced tool_choice guarantees a tool_use block; if absent, API
        # contract is broken — raise rather than guess.
        for block in resp.content:
            if getattr(block, "type", None) == "tool_use":
                return dict(block.input)
        raise RuntimeError(
            f"Anthropic response had no tool_use block; stop_reason={resp.stop_reason!r}"
        )


# ---- Success-criterion rendering — tasks.yaml keys -> English ------

_KNOWN_CRITERIA: dict[str, str] = {
    "torso_z_min_m": "torso height >= {v:.2f} m (robot is upright, not collapsed)",
    "torso_z_max_m": "torso height <= {v:.2f} m (robot is not standing taller than allowed, e.g. crouched task)",
    "hold_s": "the pose is held for at least {v:.1f} s without tipping",
    "fall_pitch_rad": "torso pitch within +/- {v:.2f} rad (not falling forward/backward)",
    "fall_roll_rad": "torso roll within +/- {v:.2f} rad (not falling sideways)",
    "target_velocity_x_m_s": "moving forward in +x direction at ~{v:.2f} m/s",
    "yaw_change_rad": "torso yaw has changed by ~{v:.2f} rad (turn in place)",
    "distance_to_target_m": "robot is within {v:.2f} m of the named target",
    "arm_lift_height_m": "arm raised at least {v:.2f} m above resting (visible waving / reaching)",
}


def _render_success_criteria(success: dict) -> str:
    """Render the success block into markdown bullets for the prompt."""
    bullets: list[str] = []
    for key, value in success.items():
        tmpl = _KNOWN_CRITERIA.get(key)
        try:
            target = tmpl.format(v=float(value)) if tmpl else f"{key} = {value!r}"
        except (TypeError, ValueError):
            target = f"{key} = {value!r}"
        bullets.append(f"  - **{key}**: {target}")
    return "\n".join(bullets)


# ---- Image preprocessing -------------------------------------------

def _encode_frame_png(frame: np.ndarray, max_dim: int = 768) -> bytes:
    if frame.ndim != 3 or frame.shape[2] != 3 or frame.dtype != np.uint8:
        raise ValueError(
            f"frame must be (H,W,3) uint8 RGB; got shape={frame.shape} dtype={frame.dtype}"
        )
    img = Image.fromarray(frame, mode="RGB")
    h, w = frame.shape[:2]
    longest = max(h, w)
    if longest > max_dim:
        scale = max_dim / longest
        img = img.resize((int(w * scale), int(h * scale)), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# ---- The evaluator --------------------------------------------------

_SYSTEM_PROMPT = (
    "You are a careful robotics evaluator. You see one or two images of a "
    "small biped humanoid robot (Hiwonder AiNex, ~30 cm tall, 24 actuated "
    "joints). The robot has just executed a text command. Your job is to "
    "grade the result against an explicit list of success criteria, give an "
    "honest confidence, and write a critique that another agent can use to "
    "improve the robot's next attempt.\n\n"
    "You do not have access to numeric joint angles. Judge from what you "
    "can see in the image(s). When occluded or uncertain, lower the "
    "confidence rather than guessing.\n\n"
    "You MUST respond by calling the `record_evaluation` tool exactly once."
)


class VLMEvaluator:
    """VLM-as-judge for robot rollouts. See DESIGN.md."""

    def __init__(self, backend: VLMBackend | None = None) -> None:
        self.backend: VLMBackend = backend or AnthropicBackend()

    async def evaluate_render(
        self,
        task_spec: TaskSpec,
        sim_frame: np.ndarray,
        real_frame: np.ndarray | None = None,
        question: str | None = None,
    ) -> EvalResult:
        criteria_md = _render_success_criteria(
            getattr(task_spec, "success", {}) or {}
        )

        frame_note = (
            "The image labelled 'SIM' is the MuJoCo render at the end of the "
            "episode. The image labelled 'REAL' is the AiNex onboard camera "
            "frame at the same moment."
            if real_frame is not None
            else "The image is the MuJoCo render at the end of the episode."
        )
        ask_note = (
            f"\n\nThe agent additionally asks: {question!r}. Answer it as "
            "part of your critique."
            if question else ""
        )
        user_text = (
            f"Task: {task_spec.id} (tier {task_spec.tier})\n"
            f"Description: {task_spec.description}\n\n"
            "Success criteria for this task (from the curriculum):\n"
            f"{criteria_md}\n\n"
            f"{frame_note}\n\n"
            "For each criterion above, decide whether it is satisfied based on "
            "what you can see, give a one-line observation, and a confidence "
            "in [0, 1]. Then give an overall pass/fail, a 2-5 sentence "
            "critique, and a short list of concrete suggestions a future "
            "attempt could use." + ask_note
        )

        images: list[bytes] = [_encode_frame_png(sim_frame)]
        if real_frame is not None:
            images.append(_encode_frame_png(real_frame))

        raw = await self.backend.judge(
            system_prompt=_SYSTEM_PROMPT,
            user_text=user_text,
            images=images,
            tool_schema=_RECORD_EVALUATION_TOOL,
        )

        return EvalResult(
            task_id=task_spec.id,
            passed=bool(raw["passed"]),
            confidence=float(raw["confidence"]),
            critique=str(raw["critique"]),
            suggestions=[str(s) for s in raw["suggestions"]],
            criteria=[CriterionResult.model_validate(c) for c in raw["criteria"]],
            model=self.backend.model_name,
            raw_response=raw,
        )


__all__ = [
    "AnthropicBackend",
    "CriterionResult",
    "EvalResult",
    "VLMBackend",
    "VLMEvaluator",
]
