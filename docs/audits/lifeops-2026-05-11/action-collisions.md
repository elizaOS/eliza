# Action description collisions

Generated: 2026-05-12T16:56:02.578Z
Threshold: cosine ≥ 0.75
Population: 128 action descriptions
Pairs above threshold: 0

Each row below is two actions whose `description` strings share enough TF-IDF mass to risk planner-routing collisions. Tighten the wording where appropriate (or merge / split the actions).

_No collisions at or above the configured threshold._

---

## Near-misses (0.50 ≤ similarity < 0.75)

Top 10 pairs below the threshold. Useful when default threshold leaves no hits — action descriptions in this codebase are short and TF-IDF cosines rarely cross 0.75.

| # | Similarity | A | B |
|---:|---:|---|---|
| 1 | 0.688 | `LINEAR_ISSUE` (plugins/plugin-linear/src/actions/routers.ts) | `LINEAR_COMMENT` (plugins/plugin-linear/src/actions/routers.ts) |
| 2 | 0.596 | `OWNER_REMINDERS` (plugins/app-lifeops/src/actions/owner-surfaces.ts) | `OWNER_ALARMS` (plugins/app-lifeops/src/actions/owner-surfaces.ts) |
| 3 | 0.596 | `OWNER_REMINDERS` (plugins/app-lifeops/src/actions/owner-surfaces.ts) | `OWNER_ALARMS` (plugins/app-lifeops/src/actions/owner-surfaces.ts) |
| 4 | 0.596 | `OWNER_REMINDERS` (plugins/app-lifeops/src/actions/owner-surfaces.ts) | `OWNER_ALARMS` (plugins/app-lifeops/src/actions/owner-surfaces.ts) |
| 5 | 0.596 | `OWNER_REMINDERS` (plugins/app-lifeops/src/actions/owner-surfaces.ts) | `OWNER_ALARMS` (plugins/app-lifeops/src/actions/owner-surfaces.ts) |
| 6 | 0.595 | `PLAY_AUDIO` (plugins/plugin-music/src/actions/playAudio.ts) | `PLAYBACK` (plugins/plugin-music/src/actions/playbackOp.ts) |
| 7 | 0.522 | `LINEAR_ISSUE` (plugins/plugin-linear/src/actions/routers.ts) | `LINEAR_WORKFLOW` (plugins/plugin-linear/src/actions/routers.ts) |
| 8 | 0.516 | `LINEAR` (plugins/plugin-linear/src/actions/linear.ts) | `LIST_LINEAR_COMMENTS` (plugins/plugin-linear/src/actions/listComments.ts) |
| 9 | 0.506 | `CREATE_LINEAR_COMMENT` (plugins/plugin-linear/src/actions/createComment.ts) | `DELETE_LINEAR_COMMENT` (plugins/plugin-linear/src/actions/deleteComment.ts) |
| 10 | 0.502 | `LINEAR` (plugins/plugin-linear/src/actions/linear.ts) | `LINEAR_ISSUE` (plugins/plugin-linear/src/actions/routers.ts) |
