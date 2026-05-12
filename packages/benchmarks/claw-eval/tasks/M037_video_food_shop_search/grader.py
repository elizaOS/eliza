"""M037_video_food_shop_search grader — vlog food shop identification.

评分逻辑:
  7家有名字的店铺，每家满分1分（店名0.33 + 图片0.33 + 地址0.33）
  总分 = 各店得分之和 / 7
"""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.graders.visual_grader import VisualGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VlogFoodShopSearchGrader(AbstractGrader, MultimodalGraderMixin, VisualGraderMixin):

    GT_SHOPS = [
        {
            "name": "沈大成",
            "aliases": ["沈大成", "南京东路总店"],
            "address": "黄浦区南京东路636号",
            "address_keywords": ["南京东路", "南京路步行街", "黄浦区"],
        },
        {
            "name": "莱莱小笼",
            "aliases": ["莱莱小笼", "巧爱莱莱小笼"],
            "address": "黄浦区天津路504号",
            "address_keywords": ["天津路", "黄浦区"],
        },
        {
            "name": "OT另茶",
            "aliases": ["另茶", "OT另茶", "OT"],
            "address": "上海多家分店",
            "address_keywords": ["K11", "淮海中路", "上海"],
        },
        {
            "name": "晓平饭店",
            "aliases": ["晓平饭店", "晓平"],
            "address": "徐汇区嘉善路202号",
            "address_keywords": ["嘉善路", "田子坊", "徐汇区"],
        },
        {
            "name": "国际饭店·西饼屋",
            "aliases": ["国际饭店", "西饼屋", "蝴蝶酥"],
            "address": "黄浦区南京西路170号",
            "address_keywords": ["南京西路", "黄河路", "人民广场"],
        },
        {
            "name": "醉师傅/DRUNK BAKER",
            "aliases": ["醉师傅", "DRUNK BAKER", "drunk baker"],
            "address": "上海多家分店",
            "address_keywords": ["四川北路", "武康路", "安福路", "上海"],
        },
        {
            "name": "红料理",
            "aliases": ["红料理", "红料理串串有瘾", "串串有瘾"],
            "address": "上海多家分店",
            "address_keywords": ["仙乐斯", "南京西路388号", "上海"],
        },
    ]

    JUDGE_RUBRIC = (
        "You are evaluating a food vlog shop identification task.\n"
        "The agent was asked to identify shops from a Shanghai food vlog.\n\n"
        "There are 7 shops with known names. For each shop, evaluate:\n"
        "1. Shop name correct? (0.33)\n"
        "2. Has a relevant photo? (0.33)\n"
        "3. Geographic location/address correct? (0.33)\n\n"
        "Ground truth shops:\n"
        "1. 沈大成（南京东路总店）- 黄浦区南京东路636号\n"
        "2. 莱莱小笼 - 黄浦区天津路504号\n"
        "3. OT另茶 - 上海多家分店\n"
        "4. 晓平饭店 - 徐汇区嘉善路202号\n"
        "5. 国际饭店·西饼屋 - 黄浦区南京西路170号\n"
        "6. DRUNK BAKER/醉师傅 - 上海多家分店\n"
        "7. 红料理串串有瘾 - 上海多家分店\n\n"
        "Score = (sum of per-shop scores) / 7\n"
        "Give an overall score from 0.0 to 1.0."
    )

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

        final_text = self._get_final_assistant_text(messages)
        all_text = self._get_all_assistant_text(messages)

        # Check output file
        output_content = ""
        for path in ["/workspace/output.md", "/workspace/output.html"]:
            if self.check_file_exists(env_snapshot, path):
                output_content = (env_snapshot or {}).get(
                    f"file:{path}", {}
                ).get("content", "")
                if output_content:
                    break

        # Also check command output
        cmd_output = self.get_snapshot_stdout(
            env_snapshot,
            "cat /workspace/output.md 2>/dev/null || cat /workspace/output.html 2>/dev/null || echo 'NO_OUTPUT'"
        )

        eval_text = output_content or cmd_output or all_text

        if not eval_text or eval_text.strip() == "NO_OUTPUT":
            scores.completion = 0.0
            scores.robustness = self.compute_robustness(dispatches)
            scores.efficiency_turns = len(
                [m for m in messages if m.message.role == "assistant"]
            )
            return scores

        # Rule-based: count how many shop names are mentioned
        shops_found = 0
        for shop in self.GT_SHOPS:
            for alias in shop["aliases"]:
                if alias.lower() in eval_text.lower():
                    shops_found += 1
                    break

        # Base score from rule-based detection
        rule_score = min(shops_found / 7.0, 1.0) * 0.3  # 30% weight

        # LLM judge for detailed evaluation
        judge_score = 0.0
        if judge:
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=eval_text[:8000],
                actions_summary=self.summarize_actions(audit_data),
                rubric=self.JUDGE_RUBRIC,
            )
            if result:
                judge_score = result.score

        scores.completion = round(rule_score + 0.7 * judge_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )

        print(
            f"[grader] {task.task_id}: shops_found={shops_found}/7 "
            f"rule={rule_score:.2f} judge={judge_score:.2f} → C={scores.completion}"
        )
        return scores
