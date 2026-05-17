"""Grader for M098_video_craft_webpage: Handicraft Showcase Webpage from Video.

Task: Watch video, identify handicraft items, extract images, build HTML showcase.

GT crafts (reference, 6 items):
  1. Ancient-style female figurine (仕女人偶)
  2. Diancui/pearl headdress (点翠珍珠头饰)
  3. Crystal/glass hanging ornament (琉璃水晶悬挂装饰)
  4. Clay animal figurines group (泥塑动物群像)
  5. Clay warrior on horseback (骑马武将泥塑)
  6. Dough figurine (面塑小人偶)

GT reference images: fixtures/gt_1.png through gt_10.png

Scoring (total = 1.0):
  - 0.2: HTML exists and can render properly
  - 0.2: HTML aesthetics — layout, color harmony, visual appeal
  - 0.6: Content — at least 3 crafts, each worth 0.2 (image + description match video)
"""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.graders.visual_grader import VisualGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


INDEX_FILE = "/workspace/index.html"
IMAGE_DIR = "/workspace/images"
MAX_IMAGES = 6

# GT reference images for visual comparison
GT_IMAGES = [f"/workspace/fixtures/gt_{i}.png" for i in range(1, 11)]

HTML_RENDER_RUBRIC = """\
You are evaluating whether an HTML file can render properly as a webpage.

Below is the HTML source code. Check:
1. Is it valid HTML with proper structure (html/head/body tags or at least \
renderable content)?
2. Does it contain meaningful content (not empty or just boilerplate)?
3. Would it render without major errors in a browser?

Scoring:
- 1.0: Valid HTML with content, would render properly
- 0.5: HTML has some issues but would partially render
- 0.0: Not valid HTML, empty, or would not render at all"""

HTML_AESTHETICS_RUBRIC = """\
You are evaluating the visual design quality of an HTML showcase webpage for \
Chinese traditional handicrafts.

Below is the HTML source code (including CSS). Evaluate:
1. Layout: Is there a card/grid/gallery layout for items? Is it well-organized?
2. Styling: Does it have CSS styling? Are colors harmonious? Is typography readable?
3. Visual appeal: Would this look professional and attractive in a browser?

Scoring:
- 1.0: Polished design — clean layout, harmonious colors, professional look
- 0.7: Good design — proper card layout with decent styling
- 0.4: Basic design — has some CSS but layout is plain or inconsistent
- 0.0: No styling at all, or ugly/broken layout"""

CONTENT_RUBRIC = """\
You are evaluating the content of an HTML showcase webpage about Chinese \
traditional handicrafts from a video documentary.

The video features these craft items (for reference):
1. Ancient-style female figurine (古风仕女人偶) — Hanfu costume, flowers, jewelry
2. Diancui/pearl headdress (点翠珍珠头饰) — blue kingfisher feathers + large pearls
3. Crystal/glass hanging ornament (琉璃水晶悬挂装饰) — blue-purple vine with bead chains
4. Clay animal figurines (泥塑动物群像) — rabbit, crow, bear, cute shapes
5. Clay warrior on horseback (骑马武将泥塑) — armor, red horse, spear
6. Dough figurine (面塑小人偶) — small figure wearing hat, Republic era style

Below is the HTML source code. Also provided are the agent's craft images and \
GT reference images from the video for comparison.

Evaluate how many DISTINCT handicraft items from the video are correctly \
represented in the webpage. A craft counts as "correctly represented" if:
- There is an image that shows the craft (compared against GT reference images)
- There is a text description that reasonably matches the craft

Score = (number of correctly represented crafts) / 3, capped at 1.0.
So: 0 crafts = 0.0, 1 craft = 0.33, 2 crafts = 0.67, 3+ crafts = 1.0.

Be generous — if an image clearly shows a handicraft and the description is \
roughly correct, count it."""


class Grader(AbstractGrader, MultimodalGraderMixin, VisualGraderMixin):
    """Handicraft showcase webpage grader."""

    def grade(
        self,
        messages: list[TraceMessage],
        dispatches: list[ToolDispatch],
        task: TaskDefinition,
        audit_data: dict[str, dict] | None = None,
        judge: Any | None = None,
        media_events: list[MediaLoad] | None = None,
        env_snapshot: dict | None = None,
    ) -> DimensionScores:
        scores = DimensionScores()
        scores.safety = 1.0
        snapshot = env_snapshot or {}
        total = 0.0

        # Read HTML content
        html_exists = self.check_file_exists(snapshot, INDEX_FILE)
        html_content = ""
        if html_exists:
            html_entry = snapshot.get(f"file:{INDEX_FILE}", {})
            html_content = (
                html_entry.get("content", "").strip()
                if html_entry.get("encoding") != "base64"
                else ""
            )

        if not html_exists or not html_content:
            scores.completion = 0.0
            scores.robustness = self.compute_robustness(dispatches)
            scores.efficiency_turns = len(
                [m for m in messages if m.message.role == "assistant"]
            )
            return scores

        # ------------------------------------------------------------------
        # 1. HTML exists and renders (0.2)
        # ------------------------------------------------------------------
        render_score = 0.0
        if judge:
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=f"HTML source:\n{html_content[:5000]}",
                actions_summary="",
                rubric=HTML_RENDER_RUBRIC,
            )
            render_score = result.score if result else 0.0

        total += 0.2 * render_score

        # ------------------------------------------------------------------
        # 2. HTML aesthetics (0.2)
        # ------------------------------------------------------------------
        aesthetics_score = 0.0
        if judge:
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=f"HTML source:\n{html_content[:5000]}",
                actions_summary="",
                rubric=HTML_AESTHETICS_RUBRIC,
            )
            aesthetics_score = result.score if result else 0.0

        total += 0.2 * aesthetics_score

        # ------------------------------------------------------------------
        # 3. Content — crafts with images and descriptions (0.6)
        # ------------------------------------------------------------------
        content_score = 0.0

        # Collect agent craft images
        agent_images_b64 = []
        for i in range(1, MAX_IMAGES + 1):
            path = f"{IMAGE_DIR}/craft_{i}.png"
            entry = snapshot.get(f"file:{path}", {})
            b64 = (
                entry.get("content", "")
                if entry.get("encoding") == "base64"
                else ""
            )
            if b64:
                agent_images_b64.append(b64)

        # Collect GT reference images
        gt_images_b64 = []
        for gt_path in GT_IMAGES:
            entry = snapshot.get(f"file:{gt_path}", {})
            b64 = (
                entry.get("content", "")
                if entry.get("encoding") == "base64"
                else ""
            )
            if b64:
                gt_images_b64.append(b64)

        if judge and hasattr(judge, "evaluate_visual") and agent_images_b64:
            # Use visual judge with both GT and agent images + HTML content
            all_images = gt_images_b64 + agent_images_b64
            result = judge.evaluate_visual(
                rubric=CONTENT_RUBRIC,
                reference_images_b64=gt_images_b64,
                candidate_images_b64=agent_images_b64,
                context=(
                    f"HTML content (first 3000 chars):\n"
                    f"{html_content[:3000]}\n\n"
                    f"GT reference images: {len(gt_images_b64)} images\n"
                    f"Agent craft images: {len(agent_images_b64)} images"
                ),
            )
            content_score = result.score if result else 0.0
        elif judge:
            # Fallback: text-only evaluation of HTML content
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=f"HTML source:\n{html_content[:5000]}",
                actions_summary="",
                rubric=CONTENT_RUBRIC,
            )
            content_score = result.score if result else 0.0

        total += 0.6 * content_score

        # ------------------------------------------------------------------
        # Final
        # ------------------------------------------------------------------
        scores.completion = round(min(total, 1.0), 3)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )

        print(
            f"[grader] {task.task_id}: render={render_score:.2f} "
            f"aesthetics={aesthetics_score:.2f} content={content_score:.2f} "
            f"images={len(agent_images_b64)} "
            f"-> completion={scores.completion}"
        )
        return scores
