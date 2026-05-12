"""M022_video_movie_recognition grader — identify movies in a 2023 montage."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoMovieRecognitionGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade movie recognition from a 2023 montage video.

    Score = 0.7 * F1 recognition accuracy + 0.3 * LCS sequence accuracy.
    Both components evaluated by LLM judge against 56-movie ground truth.
    """

    RUBRIC = """\
Ground Truth: 56 movies in chronological order:
0:00 Barbie, 0:04 Peter Pan and Wendy, 0:06 The Iron Claw, 0:08 River, \
0:11 Second tour, 0:13 Barbie, 0:19 Dungeons & Dragons: Honor Among Thieves, \
0:21 Canary, 0:22 Soudain Seuls, 0:24 Killers of the Flower Moon, \
0:26 When You Finish Saving the World, 0:26 The Magic Flute, 0:32 Past Lives, \
0:35 A Thousand and One, 0:36 King Coal, 0:37 Les Enfants des Autres, \
0:39 The Velveteen Rabbit, 0:41 Somebody I Used to Know, \
0:44 What Happens Later, 0:45 Love at First Sight, 0:47 Earth Mama, \
0:49 The Other Zoey, 0:51 Love Again, 0:52 Scrapper, 0:54 Oppenheimer, \
0:56 Guardians of the Galaxy: Vol. 3, 0:57 Amerikatsi, \
0:58 The Last Voyage of the Demeter, 1:00 Pravednik, 1:02 Lord of the Wind, \
1:03 The Hunger Games: The Ballad of Songbirds and Snakes, \
1:05 Society of the Snow, 1:08 Lord of the Wind, 1:09 The Creator, \
1:11 Sitting in Bars with Cakes, 1:12 Elemental, 1:15 The Boy and the Heron, \
1:16 Wish, 1:19 The Tunnel to Summer the Exit of Goodbyes, 1:21 NYAD, \
1:22 Knights of the Zodiac, 1:23 Migration, 1:26 The Little Mermaid, \
1:28 Poor Things, 1:30 Peter Pan & Wendy, 1:32 The Eight Mountains, \
1:33 Aquaman and the Lost Kingdom, 1:34 Trolls: Band Together, 1:35 65, \
1:36 The Mission, 1:38 Jesus Revolution, 1:39 Knock at the Cabin, \
1:41 Mending the Line, 1:42 The Unknown Country, 1:43 The Color Purple, \
1:44 The Royal Hotel

Total Score = Recognition Accuracy (70%) + Sequential Accuracy (30%)

1. Recognition Accuracy (F1-Score, weight 0.7):
   Let G = ground truth set (56 movies), P = model output set.
   TP = movies in P that exist in G. FP = movies in P not in G. FN = movies in G missed by P.
   Precision = TP / (TP + FP). Recall = TP / 56. F1 = 2*(Precision*Recall)/(Precision+Recall).
   Score_part1 = 0.7 * F1.

2. Sequential Accuracy (LCS, weight 0.3):
   Remove FP from model output -> Seq_P (length=TP). Extract same movies from GT order -> Seq_G.
   Compute LCS(Seq_P, Seq_G). Sequence_Score = LCS / TP (if TP=0, score=0).
   Score_part2 = 0.3 * Sequence_Score.

Final score = Score_part1 + Score_part2. Output 0.0-1.0."""

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
        if not final_text.strip():
            scores.completion = 0.0
            scores.robustness = self.compute_robustness(dispatches)
            return scores

        if judge:
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=final_text,
                actions_summary="",
                rubric=self.RUBRIC,
            )
            scores.completion = result.score if result else 0.0

        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
