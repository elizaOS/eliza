# N-gram Analysis — `data/final/train.jsonl`

This report identifies stylistic n-grams that are over-represented in
the canonical training corpus, with per-source attribution.

- **Input:** `data/final/train.jsonl`
- **Records sampled:** 500,000 (every 3 records)
- **Sources observed:** 85
- **Run time:** 619.7s
- **Stream record counts:**
  - user_input: 495,871
  - assistant_thought: 439,234
  - assistant_text: 359,935

## Method (brief)

1. Read every 3th record from `train.jsonl`. Extract three text streams:
   `user_input` (first 2000 chars of `currentMessage.content`),
   `assistant_thought` (TOON `thought` field of `expectedResponse`), and
   `assistant_text` (TOON `text` field).
2. Tokenize lowercased streams on `[a-z0-9']+`. Compute n-gram counters
   for `n in {2,3,4,5}`, with adaptive long-tail pruning to bound memory.
3. For every n-gram track `total_count`, `record_count`,
   per-`source_dataset` counts, and a Gini coefficient over the per-source
   distribution.
4. Flag a "diversification candidate" when `record_pct > 5%`,
   `gini > 0.7`, `n >= 4`, and the n-gram is not on a small allowlist of
   legitimate domain phrases (e.g. "the user", "tool call").

## 1. Top 50 most concerning n-grams

Ranked by `record_pct * gini` over the diversification candidates list. A high score means the n-gram appears in many records and is concentrated in a small number of source datasets.

| n-gram | stream | n | total | rec % | gini | top sources |
| --- | --- | --- | --- | --- | --- | --- |
| `then confirm to deploy` | assistant_text | 4 | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `connect any required credentials` | assistant_text | 4 | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `required credentials then confirm` | assistant_text | 4 | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `any required credentials then` | assistant_text | 4 | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `nodes connect any required` | assistant_text | 4 | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `credentials then confirm to` | assistant_text | 4 | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `connect any required credentials then` | assistant_text | 5 | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `nodes connect any required credentials` | assistant_text | 5 | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `any required credentials then confirm` | assistant_text | 5 | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `required credentials then confirm to` | assistant_text | 5 | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `credentials then confirm to deploy` | assistant_text | 5 | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `call the tool to` | assistant_thought | 4 | 24,521 | 5.6% | 0.82 | nemotron-rl-tool-use (61.2%), deepfabric-github-mcp (10.6%) |
| `to satisfy the request` | assistant_thought | 4 | 24,376 | 5.5% | 0.81 | nemotron-rl-tool-use (61.5%), deepfabric-github-mcp (10.7%) |
| `an n8n workflow to` | user_input | 4 | 25,688 | 5.2% | 0.83 | n8n-mega-workflows (99.8%), n8n-workflow-dataset-ruh-ai (0.1%) |
| `create an n8n workflow` | user_input | 4 | 26,182 | 5.3% | 0.79 | n8n-mega-workflows (97.9%), n8n-workflow-dataset-ruh-ai (0.9%) |
| `tool to satisfy the` | assistant_thought | 4 | 24,285 | 5.5% | 0.74 | nemotron-rl-tool-use (61.8%), deepfabric-github-mcp (10.7%) |
| `the user s request` | assistant_thought | 4 | 22,357 | 5.1% | 0.77 | openclaw-operator (25.8%), dolci-instruct-tool-use (16.4%) |
| `create an n8n workflow to` | user_input | 5 | 25,657 | 5.2% | 0.75 | n8n-mega-workflows (99.9%), n8n-workflow-dataset-ruh-ai (0.1%) |

## 2. Per-stream top n-grams

### user_input

#### n=2

| n-gram | total | rec % | gini | top sources |
| --- | --- | --- | --- | --- |
| `of the` | 66,880 | 9.8% | 0.74 | regularizer-reasoning-tool (14.5%), noesis-1m-multimodel (14.1%) |
| `root cpu1` | 65,383 | 3.9% | 0.50 | nemotron-terminal-corpus (99.8%), regularizer-reasoning-tool (0.2%) |
| `can you` | 58,522 | 11.5% | 0.74 | glaive-fc-v2 (14.4%), glaive-fc-v2-reasoning (14.2%) |
| `in the` | 54,273 | 8.3% | 0.74 | regularizer-reasoning-tool (20.0%), ishiki-labs-multi-party-d... (8.2%) |
| `n8n workflow` | 53,679 | 9.8% | 0.81 | n8n-mega-workflows (47.8%), n8n-master-corpus (23.4%) |
| `for the` | 46,280 | 7.8% | 0.73 | tool-reasoning-toucan (12.6%), nemotron-rl-tool-use (9.3%) |
| `an n8n` | 40,715 | 8.0% | 0.84 | n8n-mega-workflows (63.0%), n8n-master-corpus (24.8%) |
| `0 0` | 39,453 | 1.2% | 0.90 | nemotron-terminal-corpus (50.5%), scam-defense-corpus (16.9%) |
| `terminal output` | 39,337 | 7.9% | 0.73 | nemotron-terminal-corpus (55.8%), agent-trove (44.1%) |
| `new terminal` | 38,683 | 7.8% | 0.37 | nemotron-terminal-corpus (56.1%), agent-trove (43.9%) |
| `on the` | 34,098 | 5.5% | 0.73 | agent-trove (16.2%), opus-47-thinking-25k-ansulev (15.3%) |
| `output root` | 33,554 | 6.6% | 0.63 | nemotron-terminal-corpus (56.8%), agent-trove (43.1%) |
| `could you` | 32,367 | 6.3% | 0.83 | tool-reasoning-toucan (26.2%), nemotron-rl-tool-use (25.5%) |
| `need to` | 31,618 | 5.5% | 0.73 | nemotron-rl-tool-use (16.4%), tool-reasoning-toucan (15.0%) |
| `i need` | 28,922 | 5.4% | 0.76 | nemotron-rl-tool-use (17.5%), tool-reasoning-toucan (13.9%) |
| `to the` | 28,283 | 4.6% | 0.71 | regularizer-reasoning-tool (16.2%), mcp-flow (7.3%) |
| `create an` | 28,091 | 5.7% | 0.95 | n8n-mega-workflows (91.3%), n8n-workflow-ruh-ai (1.8%) |
| `root root` | 27,208 | 1.2% | 0.64 | agent-trove (59.3%), nemotron-terminal-corpus (40.7%) |
| `workflow to` | 27,007 | 5.4% | 0.95 | n8n-mega-workflows (94.9%), n8n-workflows-v2-4k-arkelai (3.4%) |
| `want to` | 26,049 | 5.1% | 0.78 | agent-trove (31.2%), tool-reasoning-coding-nem... (11.7%) |
| `with the` | 24,362 | 4.3% | 0.69 | nemotron-rl-tool-use (10.3%), regularizer-reasoning-tool (9.1%) |
| `and the` | 23,567 | 4.2% | 0.65 | tool-reasoning-toucan (9.9%), regularizer-reasoning-tool (9.7%) |
| `app cat` | 22,215 | 3.5% | 0.27 | nemotron-terminal-corpus (77.4%), agent-trove (22.6%) |
| `to be` | 21,912 | 4.1% | 0.82 | agent-trove (40.1%), nemotron-terminal-corpus (12.9%) |
| `is the` | 19,537 | 3.5% | 0.69 | hermes-3 (12.7%), regularizer-reasoning-tool (10.8%) |
| `1 root` | 19,508 | 1.3% | 0.40 | agent-trove (59.7%), nemotron-terminal-corpus (40.3%) |
| `the following` | 18,135 | 3.3% | 0.76 | noesis-1m-multimodel (25.5%), regularizer-reasoning-tool (19.3%) |
| `from the` | 17,955 | 3.2% | 0.70 | regularizer-reasoning-tool (11.4%), openclaw-operator (9.4%) |
| `the workflow` | 17,898 | 2.8% | 0.87 | n8n-master-corpus (49.6%), n8n-workflows-v2-4k-arkelai (17.6%) |
| `for a` | 16,779 | 3.1% | 0.69 | tool-reasoning-toucan (12.2%), nemotron-rl-tool-use (8.4%) |

#### n=3

| n-gram | total | rec % | gini | top sources |
| --- | --- | --- | --- | --- |
| `new terminal output` | 38,675 | 7.8% | 0.06 | nemotron-terminal-corpus (56.1%), agent-trove (43.9%) |
| `an n8n workflow` | 37,874 | 7.5% | 0.84 | n8n-mega-workflows (67.7%), n8n-master-corpus (24.7%) |
| `terminal output root` | 32,761 | 6.6% | 0.07 | nemotron-terminal-corpus (56.5%), agent-trove (43.5%) |
| `create an n8n` | 26,686 | 5.4% | 0.81 | n8n-mega-workflows (96.1%), n8n-workflow-ruh-ai (1.9%) |
| `n8n workflow to` | 26,588 | 5.4% | 0.85 | n8n-mega-workflows (96.4%), n8n-workflows-v2-4k-arkelai (3.4%) |
| `0 0 0` | 21,897 | 0.3% | 0.86 | nemotron-terminal-corpus (39.2%), scam-defense-corpus (25.9%) |
| `1 root root` | 17,434 | 1.0% | 0.13 | agent-trove (63.2%), nemotron-terminal-corpus (36.8%) |
| `output root cpu1` | 17,251 | 3.4% | 0.00 | nemotron-terminal-corpus (100.0%) |
| `i need to` | 17,035 | 3.3% | 0.78 | nemotron-rl-tool-use (21.0%), tool-reasoning-toucan (18.5%) |
| `current terminal state` | 13,551 | 2.7% | 0.51 | agent-trove (78.2%), nemotron-terminal-corpus (20.4%) |
| `terminal state new` | 13,219 | 2.7% | 0.29 | agent-trove (79.1%), nemotron-terminal-corpus (20.9%) |
| `state new terminal` | 13,219 | 2.7% | 0.29 | agent-trove (79.1%), nemotron-terminal-corpus (20.9%) |
| `drwxr xr x` | 13,082 | 0.9% | 0.43 | agent-trove (64.4%), nemotron-terminal-corpus (35.6%) |
| `r 1 root` | 12,598 | 0.9% | 0.04 | agent-trove (54.1%), nemotron-terminal-corpus (45.9%) |
| `rw r r` | 12,481 | 0.9% | 0.35 | agent-trove (52.8%), nemotron-terminal-corpus (47.1%) |
| `r r 1` | 12,400 | 0.8% | 0.52 | agent-trove (53.0%), nemotron-terminal-corpus (46.9%) |
| `be able to` | 11,330 | 2.3% | 0.93 | agent-trove (68.9%), nemotron-terminal-corpus (20.2%) |
| `ubuntu com ubuntu` | 11,242 | 0.2% | 0.36 | nemotron-terminal-corpus (85.9%), agent-trove (14.1%) |
| `com ubuntu noble` | 11,218 | 0.2% | 0.36 | nemotron-terminal-corpus (86.0%), agent-trove (14.0%) |
| `you want to` | 11,187 | 2.2% | 0.93 | agent-trove (71.8%), nemotron-terminal-corpus (20.8%) |
| `task complete true` | 10,514 | 2.1% | 0.26 | agent-trove (75.9%), nemotron-terminal-corpus (24.1%) |
| `are you sure` | 10,279 | 2.1% | 0.83 | agent-trove (77.0%), nemotron-terminal-corpus (22.4%) |
| `you sure you` | 10,224 | 2.1% | 0.71 | agent-trove (77.3%), nemotron-terminal-corpus (22.5%) |
| `to mark the` | 10,213 | 2.1% | 0.91 | agent-trove (77.2%), nemotron-terminal-corpus (22.5%) |
| `sure you want` | 10,209 | 2.1% | 0.71 | agent-trove (77.4%), nemotron-terminal-corpus (22.6%) |
| `want to mark` | 10,192 | 2.1% | 0.64 | agent-trove (77.4%), nemotron-terminal-corpus (22.6%) |
| `mark the task` | 10,190 | 2.1% | 0.71 | agent-trove (77.4%), nemotron-terminal-corpus (22.6%) |
| `the task as` | 10,181 | 2.1% | 0.79 | agent-trove (77.3%), nemotron-terminal-corpus (22.6%) |
| `task as complete` | 10,162 | 2.0% | 0.27 | agent-trove (77.4%), nemotron-terminal-corpus (22.6%) |
| `i want to` | 10,157 | 2.0% | 0.76 | tool-reasoning-coding-nem... (23.7%), tool-reasoning-toucan (11.0%) |

#### n=4

| n-gram | total | rec % | gini | top sources |
| --- | --- | --- | --- | --- |
| `new terminal output root` | 32,761 | 6.6% | 0.07 | nemotron-terminal-corpus (56.5%), agent-trove (43.5%) |
| `create an n8n workflow` | 26,182 | 5.3% | 0.79 | n8n-mega-workflows (97.9%), n8n-workflow-dataset-ruh-ai (0.9%) |
| `an n8n workflow to` | 25,688 | 5.2% | 0.83 | n8n-mega-workflows (99.8%), n8n-workflow-dataset-ruh-ai (0.1%) |
| `terminal output root cpu1` | 16,725 | 3.4% | 0.00 | nemotron-terminal-corpus (100.0%) |
| `0 0 0 0` | 15,691 | 0.2% | 0.81 | nemotron-terminal-corpus (33.5%), scam-defense-corpus (30.5%) |
| `current terminal state new` | 13,219 | 2.7% | 0.29 | agent-trove (79.1%), nemotron-terminal-corpus (20.9%) |
| `state new terminal output` | 13,219 | 2.7% | 0.29 | agent-trove (79.1%), nemotron-terminal-corpus (20.9%) |
| `terminal state new terminal` | 13,219 | 2.7% | 0.29 | agent-trove (79.1%), nemotron-terminal-corpus (20.9%) |
| `r 1 root root` | 12,582 | 0.8% | 0.04 | agent-trove (54.1%), nemotron-terminal-corpus (45.9%) |
| `rw r r 1` | 12,355 | 0.8% | 0.35 | agent-trove (53.2%), nemotron-terminal-corpus (46.8%) |
| `r r 1 root` | 12,272 | 0.8% | 0.03 | agent-trove (52.9%), nemotron-terminal-corpus (47.1%) |
| `ubuntu com ubuntu noble` | 11,211 | 0.2% | 0.36 | nemotron-terminal-corpus (86.0%), agent-trove (14.0%) |
| `are you sure you` | 10,223 | 2.1% | 0.71 | agent-trove (77.3%), nemotron-terminal-corpus (22.5%) |
| `sure you want to` | 10,206 | 2.1% | 0.64 | agent-trove (77.4%), nemotron-terminal-corpus (22.6%) |
| `you sure you want` | 10,205 | 2.1% | 0.52 | agent-trove (77.4%), nemotron-terminal-corpus (22.6%) |
| `you want to mark` | 10,188 | 2.1% | 0.27 | agent-trove (77.4%), nemotron-terminal-corpus (22.6%) |
| `to mark the task` | 10,184 | 2.1% | 0.52 | agent-trove (77.4%), nemotron-terminal-corpus (22.6%) |
| `want to mark the` | 10,179 | 2.1% | 0.27 | agent-trove (77.4%), nemotron-terminal-corpus (22.6%) |
| `mark the task as` | 10,174 | 2.1% | 0.52 | agent-trove (77.4%), nemotron-terminal-corpus (22.6%) |
| `the task as complete` | 10,160 | 2.0% | 0.27 | agent-trove (77.4%), nemotron-terminal-corpus (22.6%) |
| `task as complete this` | 10,147 | 2.0% | 0.27 | agent-trove (77.4%), nemotron-terminal-corpus (22.6%) |
| `as complete this will` | 10,140 | 2.0% | 0.27 | agent-trove (77.3%), nemotron-terminal-corpus (22.7%) |
| `complete this will trigger` | 10,128 | 2.0% | 0.27 | agent-trove (77.3%), nemotron-terminal-corpus (22.7%) |
| `this will trigger your` | 10,117 | 2.0% | 0.27 | agent-trove (77.3%), nemotron-terminal-corpus (22.7%) |
| `will trigger your solution` | 10,098 | 2.0% | 0.27 | agent-trove (77.3%), nemotron-terminal-corpus (22.7%) |
| `trigger your solution to` | 10,094 | 2.0% | 0.27 | agent-trove (77.3%), nemotron-terminal-corpus (22.7%) |
| `your solution to be` | 10,089 | 2.0% | 0.27 | agent-trove (77.3%), nemotron-terminal-corpus (22.7%) |
| `won't be able to` | 10,089 | 2.0% | 0.89 | agent-trove (77.0%), nemotron-terminal-corpus (22.6%) |
| `be able to make` | 10,084 | 2.0% | 0.88 | agent-trove (76.8%), nemotron-terminal-corpus (22.6%) |
| `solution to be graded` | 10,078 | 2.0% | 0.27 | agent-trove (77.3%), nemotron-terminal-corpus (22.7%) |

#### n=5

| n-gram | total | rec % | gini | top sources |
| --- | --- | --- | --- | --- |
| `create an n8n workflow to` | 25,657 | 5.2% | 0.75 | n8n-mega-workflows (99.9%), n8n-workflow-dataset-ruh-ai (0.1%) |
| `new terminal output root cpu1` | 16,725 | 3.4% | 0.00 | nemotron-terminal-corpus (100.0%) |
| `terminal state new terminal output` | 13,219 | 2.7% | 0.29 | agent-trove (79.1%), nemotron-terminal-corpus (20.9%) |
| `current terminal state new terminal` | 13,219 | 2.7% | 0.29 | agent-trove (79.1%), nemotron-terminal-corpus (20.9%) |
| `state new terminal output root` | 12,272 | 2.5% | 0.29 | agent-trove (79.1%), nemotron-terminal-corpus (20.9%) |
| `rw r r 1 root` | 12,269 | 0.8% | 0.03 | agent-trove (53.0%), nemotron-terminal-corpus (47.0%) |
| `r r 1 root root` | 12,262 | 0.8% | 0.03 | agent-trove (52.9%), nemotron-terminal-corpus (47.1%) |
| `0 0 0 0 0` | 10,959 | 0.1% | 0.81 | scam-defense-corpus (36.2%), scambench (30.7%) |
| `are you sure you want` | 10,205 | 2.1% | 0.52 | agent-trove (77.4%), nemotron-terminal-corpus (22.6%) |
| `you sure you want to` | 10,203 | 2.1% | 0.52 | agent-trove (77.4%), nemotron-terminal-corpus (22.6%) |
| `sure you want to mark` | 10,188 | 2.1% | 0.27 | agent-trove (77.4%), nemotron-terminal-corpus (22.6%) |
| `you want to mark the` | 10,179 | 2.1% | 0.27 | agent-trove (77.4%), nemotron-terminal-corpus (22.6%) |
| `to mark the task as` | 10,174 | 2.1% | 0.52 | agent-trove (77.4%), nemotron-terminal-corpus (22.6%) |
| `want to mark the task` | 10,174 | 2.1% | 0.27 | agent-trove (77.4%), nemotron-terminal-corpus (22.6%) |
| `mark the task as complete` | 10,159 | 2.0% | 0.27 | agent-trove (77.4%), nemotron-terminal-corpus (22.6%) |
| `the task as complete this` | 10,147 | 2.0% | 0.27 | agent-trove (77.4%), nemotron-terminal-corpus (22.6%) |
| `task as complete this will` | 10,140 | 2.0% | 0.27 | agent-trove (77.3%), nemotron-terminal-corpus (22.7%) |
| `as complete this will trigger` | 10,128 | 2.0% | 0.27 | agent-trove (77.3%), nemotron-terminal-corpus (22.7%) |
| `complete this will trigger your` | 10,117 | 2.0% | 0.27 | agent-trove (77.3%), nemotron-terminal-corpus (22.7%) |
| `this will trigger your solution` | 10,098 | 2.0% | 0.27 | agent-trove (77.3%), nemotron-terminal-corpus (22.7%) |
| `will trigger your solution to` | 10,094 | 2.0% | 0.27 | agent-trove (77.3%), nemotron-terminal-corpus (22.7%) |
| `trigger your solution to be` | 10,089 | 2.0% | 0.27 | agent-trove (77.3%), nemotron-terminal-corpus (22.7%) |
| `your solution to be graded` | 10,078 | 2.0% | 0.27 | agent-trove (77.3%), nemotron-terminal-corpus (22.7%) |
| `solution to be graded and` | 10,071 | 2.0% | 0.27 | agent-trove (77.3%), nemotron-terminal-corpus (22.7%) |
| `to be graded and you` | 10,067 | 2.0% | 0.27 | agent-trove (77.3%), nemotron-terminal-corpus (22.7%) |
| `you won't be able to` | 10,066 | 2.0% | 0.79 | agent-trove (77.2%), nemotron-terminal-corpus (22.7%) |
| `be graded and you won't` | 10,060 | 2.0% | 0.27 | agent-trove (77.3%), nemotron-terminal-corpus (22.7%) |
| `and you won't be able` | 10,057 | 2.0% | 0.64 | agent-trove (77.2%), nemotron-terminal-corpus (22.7%) |
| `graded and you won't be` | 10,054 | 2.0% | 0.27 | agent-trove (77.3%), nemotron-terminal-corpus (22.7%) |
| `won't be able to make` | 10,029 | 2.0% | 0.27 | agent-trove (77.2%), nemotron-terminal-corpus (22.8%) |

### assistant_thought

#### n=2

| n-gram | total | rec % | gini | top sources |
| --- | --- | --- | --- | --- |
| `need to` | 309,086 | 24.0% | 0.85 | nemotron-terminal-corpus (42.2%), regularizer-reasoning-tool (15.4%) |
| `the user` | 295,674 | 45.8% | 0.73 | tool-reasoning-coding-nem... (17.6%), hermes-reasoning-tool-use (12.3%) |
| `we can` | 224,360 | 7.8% | 0.92 | nemotron-terminal-corpus (61.0%), regularizer-reasoning-tool (17.2%) |
| `of the` | 202,864 | 10.9% | 0.89 | glm-51-reasoning-1m (41.5%), regularizer-reasoning-tool (16.8%) |
| `in the` | 196,460 | 11.4% | 0.89 | regularizer-reasoning-tool (25.0%), nemotron-terminal-corpus (23.6%) |
| `we need` | 185,477 | 8.8% | 0.88 | nemotron-terminal-corpus (55.3%), regularizer-reasoning-tool (20.0%) |
| `that the` | 169,849 | 11.5% | 0.89 | nemotron-terminal-corpus (40.9%), glm-51-reasoning-1m (22.5%) |
| `to the` | 163,095 | 19.9% | 0.85 | glm-51-reasoning-1m (24.4%), regularizer-reasoning-tool (11.8%) |
| `is a` | 155,308 | 8.1% | 0.88 | glm-51-reasoning-1m (42.4%), nemotron-terminal-corpus (18.7%) |
| `so the` | 117,352 | 7.6% | 0.87 | glm-51-reasoning-1m (26.4%), regularizer-reasoning-tool (23.1%) |
| `but the` | 111,139 | 7.9% | 0.85 | nemotron-terminal-corpus (26.9%), regularizer-reasoning-tool (22.6%) |
| `and the` | 109,646 | 9.7% | 0.84 | glm-51-reasoning-1m (33.0%), nemotron-terminal-corpus (16.0%) |
| `is the` | 108,766 | 6.5% | 0.89 | glm-51-reasoning-1m (37.5%), regularizer-reasoning-tool (19.8%) |
| `for the` | 108,666 | 10.7% | 0.83 | glm-51-reasoning-1m (22.9%), regularizer-reasoning-tool (15.5%) |
| `1 2` | 106,098 | 2.5% | 0.84 | glm-51-reasoning-1m (36.6%), regularizer-reasoning-tool (24.4%) |
| `user wants` | 101,112 | 22.1% | 0.77 | n8n-mega-workflows (25.4%), n8n-workflows-templates-0... (11.5%) |
| `we have` | 96,397 | 6.8% | 0.90 | nemotron-terminal-corpus (55.9%), glm-51-reasoning-1m (16.8%) |
| `but we` | 90,850 | 5.5% | 0.88 | nemotron-terminal-corpus (61.0%), regularizer-reasoning-tool (19.0%) |
| `let me` | 87,401 | 7.9% | 0.82 | kimi-k25-reasoning-1m (26.4%), regularizer-reasoning-tool (24.1%) |
| `i need` | 84,366 | 15.0% | 0.70 | hermes-reasoning-tool-use (14.2%), tool-reasoning-coding-nem... (13.1%) |
| `which is` | 82,450 | 6.7% | 0.85 | nemotron-terminal-corpus (26.2%), regularizer-reasoning-tool (24.6%) |
| `with the` | 79,222 | 10.5% | 0.80 | nemotron-terminal-corpus (24.5%), regularizer-reasoning-tool (12.5%) |
| `on the` | 77,527 | 6.2% | 0.87 | glm-51-reasoning-1m (39.3%), nemotron-terminal-corpus (16.5%) |
| `for a` | 75,482 | 7.2% | 0.84 | glm-51-reasoning-1m (37.4%), nemotron-terminal-corpus (13.3%) |
| `if the` | 73,769 | 5.5% | 0.86 | glm-51-reasoning-1m (30.9%), nemotron-terminal-corpus (20.9%) |
| `wants a` | 72,985 | 16.6% | 0.86 | n8n-mega-workflows (35.1%), n8n-workflows-templates-0... (16.0%) |
| `n 1` | 72,848 | 1.3% | 0.83 | glm-51-reasoning-1m (37.0%), nemotron-terminal-corpus (29.6%) |
| `is not` | 72,846 | 4.4% | 0.86 | glm-51-reasoning-1m (33.3%), nemotron-terminal-corpus (31.4%) |
| `1 1` | 69,863 | 1.7% | 0.84 | glm-51-reasoning-1m (29.3%), nemotron-terminal-corpus (28.7%) |
| `so we` | 69,751 | 4.1% | 0.88 | nemotron-terminal-corpus (47.7%), regularizer-reasoning-tool (25.5%) |

#### n=3

| n-gram | total | rec % | gini | top sources |
| --- | --- | --- | --- | --- |
| `we need to` | 149,881 | 8.2% | 0.87 | nemotron-terminal-corpus (59.7%), regularizer-reasoning-tool (20.3%) |
| `i need to` | 80,346 | 14.4% | 0.71 | hermes-reasoning-tool-use (14.5%), tool-reasoning-coding-nem... (13.3%) |
| `user wants a` | 72,215 | 16.4% | 0.86 | n8n-mega-workflows (35.5%), n8n-workflows-templates-0... (16.1%) |
| `workflow drafting with` | 62,529 | 14.2% | 0.70 | n8n-mega-workflows (41.0%), n8n-workflows-templates-0... (18.6%) |
| `to the user` | 54,975 | 12.4% | 0.89 | hermes-omniforge-qwen36 (25.6%), hermes-3 (23.1%) |
| `reply to the` | 51,132 | 11.6% | 0.80 | hermes-omniforge-qwen36 (27.5%), hermes-3 (24.9%) |
| `the user s` | 38,095 | 8.7% | 0.77 | openclaw-operator (18.2%), open-paws-tool-use (15.3%) |
| `the user wants` | 37,105 | 7.6% | 0.73 | hermes-reasoning-tool-use (18.4%), tool-reasoning-coding-nem... (16.7%) |
| `there is a` | 29,838 | 1.9% | 0.88 | glm-51-reasoning-1m (49.5%), nemotron-terminal-corpus (32.5%) |
| `need to ensure` | 27,233 | 3.3% | 0.92 | nemotron-terminal-corpus (78.3%), regularizer-reasoning-tool (13.6%) |
| `i m confirming` | 27,003 | 6.1% | 0.78 | dolci-instruct-tool-use (19.6%), glaive-fc-v2 (16.0%) |
| `the number of` | 26,430 | 1.5% | 0.88 | glm-51-reasoning-1m (36.2%), nemotron-terminal-corpus (25.7%) |
| `the tool to` | 25,836 | 5.9% | 0.87 | nemotron-rl-tool-use (58.1%), deepfabric-github-mcp (10.1%) |
| `the user is` | 25,804 | 4.4% | 0.80 | tool-reasoning-coding-nem... (27.4%), kimi-k25-reasoning-1m (15.2%) |
| `also need to` | 25,380 | 2.9% | 0.90 | nemotron-terminal-corpus (85.4%), regularizer-reasoning-tool (8.8%) |
| `to satisfy the` | 25,012 | 5.7% | 0.90 | nemotron-rl-tool-use (60.0%), deepfabric-github-mcp (10.4%) |
| `call the tool` | 24,954 | 5.7% | 0.85 | nemotron-rl-tool-use (60.1%), deepfabric-github-mcp (10.4%) |
| `the user asked` | 24,776 | 5.5% | 0.80 | dolci-instruct-tool-use (25.9%), glaive-fc-v2 (12.8%) |
| `satisfy the request` | 24,460 | 5.6% | 0.85 | nemotron-rl-tool-use (61.3%), deepfabric-github-mcp (10.7%) |
| `tool to satisfy` | 24,286 | 5.5% | 0.74 | nemotron-rl-tool-use (61.8%), deepfabric-github-mcp (10.7%) |
| `but we can` | 22,929 | 2.6% | 0.83 | nemotron-terminal-corpus (59.2%), regularizer-reasoning-tool (17.2%) |
| `user s request` | 22,358 | 5.1% | 0.77 | openclaw-operator (25.8%), dolci-instruct-tool-use (16.4%) |
| `this is a` | 22,197 | 2.9% | 0.75 | glm-51-reasoning-1m (34.5%), kimi-k25-reasoning-1m (18.7%) |
| `so we need` | 20,289 | 1.8% | 0.81 | nemotron-terminal-corpus (48.0%), glm-51-reasoning-1m (23.5%) |
| `m confirming the` | 19,311 | 4.4% | 0.77 | dolci-instruct-tool-use (18.9%), sharegpt-tool-calls (15.8%) |
| `we can use` | 19,197 | 1.8% | 0.84 | nemotron-terminal-corpus (58.0%), glm-51-reasoning-1m (21.7%) |
| `ensure that the` | 18,949 | 2.2% | 0.91 | nemotron-terminal-corpus (88.4%), glm-51-reasoning-1m (4.7%) |
| `user asked for` | 18,633 | 4.2% | 0.82 | dolci-instruct-tool-use (30.8%), openclaw-operator (13.6%) |
| `note that the` | 18,541 | 2.5% | 0.90 | nemotron-terminal-corpus (59.0%), regularizer-reasoning-tool (20.4%) |
| `so we can` | 18,217 | 1.7% | 0.87 | nemotron-terminal-corpus (49.9%), regularizer-reasoning-tool (26.7%) |

#### n=4

| n-gram | total | rec % | gini | top sources |
| --- | --- | --- | --- | --- |
| `reply to the user` | 51,117 | 11.6% | 0.69 | hermes-omniforge-qwen36 (27.6%), hermes-3 (24.9%) |
| `call the tool to` | 24,521 | 5.6% | 0.82 | nemotron-rl-tool-use (61.2%), deepfabric-github-mcp (10.6%) |
| `to satisfy the request` | 24,376 | 5.5% | 0.81 | nemotron-rl-tool-use (61.5%), deepfabric-github-mcp (10.7%) |
| `tool to satisfy the` | 24,285 | 5.5% | 0.74 | nemotron-rl-tool-use (61.8%), deepfabric-github-mcp (10.7%) |
| `the tool to satisfy` | 24,283 | 5.5% | 0.68 | nemotron-rl-tool-use (61.8%), deepfabric-github-mcp (10.7%) |
| `the user s request` | 22,357 | 5.1% | 0.77 | openclaw-operator (25.8%), dolci-instruct-tool-use (16.4%) |
| `i m confirming the` | 19,311 | 4.4% | 0.77 | dolci-instruct-tool-use (18.9%), sharegpt-tool-calls (15.8%) |
| `the user asked for` | 18,577 | 4.2% | 0.82 | dolci-instruct-tool-use (30.9%), openclaw-operator (13.6%) |
| `now we need to` | 17,374 | 2.3% | 0.84 | nemotron-terminal-corpus (69.8%), regularizer-reasoning-tool (19.5%) |
| `user wants a when` | 16,068 | 3.7% | 0.72 | n8n-mega-workflows (49.3%), n8n-workflows-templates-0... (18.6%) |
| `we need to ensure` | 15,509 | 2.1% | 0.84 | nemotron-terminal-corpus (74.0%), regularizer-reasoning-tool (18.6%) |
| `so we need to` | 14,787 | 1.6% | 0.80 | nemotron-terminal-corpus (49.5%), regularizer-reasoning-tool (23.4%) |
| `the user is asking` | 14,374 | 2.8% | 0.82 | kimi-k25-reasoning-1m (23.3%), tool-reasoning-coding-nem... (18.8%) |
| `wants a when clicking` | 13,943 | 3.2% | 0.75 | n8n-mega-workflows (56.6%), n8n-workflows-templates-0... (16.2%) |
| `but we need to` | 13,284 | 1.7% | 0.79 | nemotron-terminal-corpus (55.3%), regularizer-reasoning-tool (26.1%) |
| `m confirming the user` | 12,711 | 2.9% | 0.77 | dolci-instruct-tool-use (19.4%), glaive-fc-v2 (16.5%) |
| `confirming the user s` | 12,507 | 2.8% | 0.77 | dolci-instruct-tool-use (19.7%), glaive-fc-v2 (16.7%) |

#### n=5

| n-gram | total | rec % | gini | top sources |
| --- | --- | --- | --- | --- |
| `tool to satisfy the request` | 24,283 | 5.5% | 0.68 | nemotron-rl-tool-use (61.8%), deepfabric-github-mcp (10.7%) |
| `call the tool to satisfy` | 24,283 | 5.5% | 0.68 | nemotron-rl-tool-use (61.8%), deepfabric-github-mcp (10.7%) |
| `the tool to satisfy the` | 24,283 | 5.5% | 0.68 | nemotron-rl-tool-use (61.8%), deepfabric-github-mcp (10.7%) |
| `user wants a when clicking` | 13,943 | 3.2% | 0.75 | n8n-mega-workflows (56.6%), n8n-workflows-templates-0... (16.2%) |
| `i m confirming the user` | 12,711 | 2.9% | 0.77 | dolci-instruct-tool-use (19.4%), glaive-fc-v2 (16.5%) |
| `m confirming the user s` | 12,459 | 2.8% | 0.77 | dolci-instruct-tool-use (19.8%), glaive-fc-v2 (16.7%) |

### assistant_text

#### n=2

| n-gram | total | rec % | gini | top sources |
| --- | --- | --- | --- | --- |
| `of the` | 140,942 | 17.3% | 0.76 | glm-51-reasoning-1m (16.7%), tool-reasoning-toucan (14.3%) |
| `in the` | 105,733 | 15.6% | 0.75 | tool-reasoning-toucan (17.9%), glm-51-reasoning-1m (10.0%) |
| `e g` | 76,669 | 9.0% | 0.85 | tool-reasoning-toucan (33.6%), glm-51-reasoning-1m (17.4%) |
| `to the` | 74,146 | 12.3% | 0.76 | tool-reasoning-toucan (19.2%), glm-51-reasoning-1m (12.7%) |
| `on the` | 64,230 | 12.4% | 0.74 | tool-reasoning-toucan (15.9%), opus-47-thinking-25k-ansulev (11.1%) |
| `is a` | 59,258 | 10.6% | 0.73 | tool-reasoning-toucan (14.7%), glm-51-reasoning-1m (12.2%) |
| `and the` | 55,522 | 9.8% | 0.73 | glm-51-reasoning-1m (15.9%), tool-reasoning-toucan (15.3%) |
| `for the` | 54,761 | 10.2% | 0.74 | tool-reasoning-toucan (26.8%), glm-51-reasoning-1m (6.7%) |
| `tool call` | 53,795 | 6.8% | 0.87 | nemotron-rl-tool-use (55.8%), hermes-reasoning-tool-use (21.4%) |
| `if you` | 49,128 | 9.7% | 0.79 | tool-reasoning-toucan (33.2%), dolci-instruct-tool-use (9.3%) |
| `is the` | 47,654 | 7.9% | 0.73 | glm-51-reasoning-1m (12.2%), kimi-k25-reasoning-1m (11.4%) |
| `to deploy` | 45,591 | 12.7% | 0.86 | n8n-mega-workflows (44.4%), n8n-workflows-templates-0... (16.9%) |
| `any required` | 45,433 | 12.6% | 0.83 | n8n-mega-workflows (44.5%), n8n-workflows-templates-0... (17.0%) |
| `required credentials` | 45,328 | 12.6% | 0.78 | n8n-mega-workflows (44.6%), n8n-workflows-templates-0... (17.0%) |
| `then confirm` | 45,324 | 12.6% | 0.78 | n8n-mega-workflows (44.6%), n8n-workflows-templates-0... (17.0%) |
| `connect any` | 45,320 | 12.6% | 0.76 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `nodes connect` | 45,319 | 12.6% | 0.76 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `confirm to` | 45,318 | 12.6% | 0.76 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `credentials then` | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `from the` | 44,561 | 9.3% | 0.74 | tool-reasoning-toucan (17.1%), hermes-omniforge-qwen36 (17.0%) |
| `with the` | 43,714 | 9.3% | 0.72 | tool-reasoning-toucan (22.4%), hermes-omniforge-qwen36 (9.8%) |
| `in a` | 38,161 | 7.1% | 0.76 | tool-reasoning-toucan (19.3%), glm-51-reasoning-1m (11.7%) |
| `you can` | 37,450 | 6.4% | 0.80 | tool-reasoning-toucan (43.3%), hermes-3 (6.2%) |
| `as a` | 36,535 | 7.7% | 0.78 | hermes-omniforge-qwen36 (20.7%), glm-51-reasoning-1m (13.8%) |
| `based on` | 33,663 | 7.5% | 0.68 | tool-reasoning-toucan (10.6%), glaive-fc-v2 (9.4%) |
| `can be` | 32,971 | 6.1% | 0.75 | tool-reasoning-toucan (19.9%), glm-51-reasoning-1m (10.7%) |
| `let me` | 31,491 | 7.4% | 0.83 | tool-reasoning-toucan (22.2%), agent-trove (21.3%) |
| `with a` | 29,680 | 6.0% | 0.74 | tool-reasoning-toucan (30.0%), glm-51-reasoning-1m (5.9%) |
| `for a` | 29,503 | 5.8% | 0.77 | tool-reasoning-toucan (30.8%), glm-51-reasoning-1m (7.2%) |
| `need to` | 28,702 | 6.0% | 0.74 | noesis-1m-multimodel (14.2%), nemotron-rl-tool-use (14.1%) |

#### n=3

| n-gram | total | rec % | gini | top sources |
| --- | --- | --- | --- | --- |
| `any required credentials` | 45,317 | 12.6% | 0.73 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `credentials then confirm` | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `nodes connect any` | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `confirm to deploy` | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `required credentials then` | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `then confirm to` | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `connect any required` | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `tool call name` | 25,908 | 6.5% | 0.71 | nemotron-rl-tool-use (57.9%), hermes-reasoning-tool-use (21.4%) |
| `let me know` | 19,139 | 5.2% | 0.87 | tool-reasoning-toucan (33.5%), dolci-instruct-tool-use (25.4%) |
| `drafted 'untitled' with` | 16,416 | 4.6% | 0.65 | n8n-master-corpus (39.3%), n8n-workflows-templates-0... (25.0%) |
| `i'm sorry but` | 15,396 | 4.3% | 0.76 | glaive-fc-v2 (26.3%), glaive-fc-v2-reasoning (26.1%) |
| `if you need` | 14,023 | 3.7% | 0.79 | tool-reasoning-toucan (31.0%), dolci-instruct-tool-use (16.5%) |
| `visible trace the` | 13,875 | 3.9% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `me know if` | 13,459 | 3.7% | 0.88 | dolci-instruct-tool-use (30.8%), tool-reasoning-toucan (29.5%) |
| `based on the` | 12,978 | 3.4% | 0.72 | dolci-instruct-tool-use (14.2%), glaive-fc-v2 (10.9%) |
| `cite id s` | 11,843 | 0.1% | 0.49 | regularizer-reasoning-tool (99.4%), dolci-instruct-tool-use (0.6%) |
| `feel free to` | 10,971 | 3.0% | 0.84 | tool-reasoning-toucan (25.6%), glaive-fc-v2-reasoning (20.3%) |
| `the number of` | 10,183 | 1.8% | 0.75 | hermes-3 (30.0%), noesis-1m-multimodel (12.5%) |
| `i don't have` | 10,044 | 2.8% | 0.83 | glaive-fc-v2 (29.0%), glaive-fc-v2-reasoning (28.7%) |
| `would you like` | 9,769 | 2.7% | 0.85 | tool-reasoning-coding-nem... (49.6%), tool-reasoning-toucan (11.6%) |
| `so i will` | 9,723 | 2.7% | 0.91 | hermes-omniforge-qwen36 (99.5%), agent-trove (0.3%) |
| `the task is` | 9,058 | 1.7% | 0.95 | agent-trove (91.3%), regularizer-reasoning-tool (5.6%) |
| `i need to` | 8,951 | 2.0% | 0.87 | nemotron-rl-tool-use (30.8%), noesis-1m-multimodel (25.1%) |
| `know if you` | 8,894 | 2.5% | 0.85 | dolci-instruct-tool-use (32.5%), tool-reasoning-toucan (26.2%) |
| `here are the` | 8,730 | 2.4% | 0.79 | dolci-instruct-tool-use (39.9%), tool-reasoning-coding-nem... (12.9%) |
| `task complete true` | 8,524 | 2.3% | 0.50 | agent-trove (100.0%), regularizer-reasoning-tool (0.0%) |
| `task is complete` | 8,477 | 1.7% | 0.89 | agent-trove (96.0%), regularizer-reasoning-tool (3.8%) |
| `commands task complete` | 8,085 | 2.2% | 0.00 | agent-trove (100.0%) |
| `if you have` | 8,081 | 2.1% | 0.76 | glaive-fc-v2-reasoning (17.0%), glaive-fc-v2 (16.5%) |
| `free to ask` | 7,954 | 2.2% | 0.81 | glaive-fc-v2-reasoning (27.9%), glaive-fc-v2 (27.1%) |

#### n=4

| n-gram | total | rec % | gini | top sources |
| --- | --- | --- | --- | --- |
| `then confirm to deploy` | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `connect any required credentials` | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `required credentials then confirm` | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `any required credentials then` | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `nodes connect any required` | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `credentials then confirm to` | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `let me know if` | 13,457 | 3.7% | 0.88 | dolci-instruct-tool-use (30.7%), tool-reasoning-toucan (29.5%) |
| `me know if you` | 8,852 | 2.5% | 0.83 | dolci-instruct-tool-use (32.6%), tool-reasoning-toucan (26.2%) |
| `commands task complete true` | 8,004 | 2.2% | 0.00 | agent-trove (100.0%) |
| `feel free to ask` | 7,952 | 2.2% | 0.81 | glaive-fc-v2-reasoning (27.9%), glaive-fc-v2 (27.1%) |
| `is marked as a` | 7,569 | 2.1% | 0.83 | hermes-omniforge-qwen36 (99.9%), tool-reasoning-toucan (0.0%) |
| `the media path for` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `i will answer from` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `metadata final answer sample` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `media is marked as` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `preserve the media path` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `will answer from the` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `for downstream vlm loading` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `the supplied task metadata` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `media path for downstream` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `supplied task metadata final` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `visible trace the media` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `the media is marked` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `structure avoid inventing unseen` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `task metadata final answer` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `path for downstream vlm` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `a placeholder so i` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `so i will answer` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `as a placeholder so` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `avoid inventing unseen details` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |

#### n=5

| n-gram | total | rec % | gini | top sources |
| --- | --- | --- | --- | --- |
| `connect any required credentials then` | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `nodes connect any required credentials` | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `any required credentials then confirm` | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `required credentials then confirm to` | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `credentials then confirm to deploy` | 45,316 | 12.6% | 0.71 | n8n-mega-workflows (44.7%), n8n-workflows-templates-0... (17.0%) |
| `let me know if you` | 8,850 | 2.5% | 0.84 | dolci-instruct-tool-use (32.6%), tool-reasoning-toucan (26.2%) |
| `trace the media is marked` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `will answer from the supplied` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `media path for downstream vlm` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `the media is marked as` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `path for downstream vlm loading` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `answer from the supplied task` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `so i will answer from` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `the observable structure avoid inventing` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `report the observable structure avoid` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `and preserve the media path` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `as a placeholder so i` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `avoid inventing unseen details and` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `unseen details and preserve the` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `placeholder so i will answer` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `media is marked as a` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `observable structure avoid inventing unseen` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `visible trace the media is` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `from the supplied task metadata` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `marked as a placeholder so` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `i will answer from the` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `a placeholder so i will` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `task metadata final answer sample` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `is marked as a placeholder` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |
| `structure avoid inventing unseen details` | 7,563 | 2.1% | 0.00 | hermes-omniforge-qwen36 (100.0%) |

## 3. Per-source distinctive style

For each source, the top 5 n-grams that are >=5x over-represented in this source vs. the rest of the corpus. This is a **style fingerprint** of each dataset.

### nemotron-terminal-corpus (25,748 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `root cpu1 0020 app` | user_input | 4 | 2,967 | 0.115/rec | 0.0000/rec | 54173.3x |
| `root cpu1 0028 app` | user_input | 4 | 4,390 | 0.170/rec | 0.0000/rec | 40077.7x |
| `root cpu1 0004 app` | user_input | 4 | 2,000 | 0.078/rec | 0.0000/rec | 36517.2x |
| `let's write a script` | assistant_thought | 4 | 1,907 | 0.074/rec | 0.0000/rec | 30629.5x |
| `root cpu1 0023 app` | user_input | 4 | 4,265 | 0.166/rec | 0.0000/rec | 25957.7x |

### n8n-mega-workflows (25,638 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `create an n8n workflow to` | user_input | 5 | 25,638 | 1.000/rec | 0.0000/rec | 24749.1x |
| `workflow to set workflow` | user_input | 4 | 502 | 0.020/rec | 0.0000/rec | 9999.0x |
| `category backup recovery using` | user_input | 4 | 1,146 | 0.045/rec | 0.0000/rec | 9999.0x |
| `httprequest code baserow stickynote` | user_input | 4 | 494 | 0.019/rec | 0.0000/rec | 9999.0x |
| `httprequest filter set code` | user_input | 4 | 510 | 0.020/rec | 0.0000/rec | 9999.0x |

### light-multilight (25,207 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `i respond to king in` | assistant_thought | 5 | 473 | 0.056/rec | 0.0000/rec | 9999.0x |
| `as king i respond to` | assistant_thought | 5 | 493 | 0.058/rec | 0.0000/rec | 9999.0x |

### noesis-1m-multimodel (23,663 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `im start assistant think` | user_input | 4 | 1,126 | 0.049/rec | 0.0000/rec | 11488.6x |
| `end im start assistant think` | user_input | 5 | 1,126 | 0.049/rec | 0.0000/rec | 11488.6x |
| `start assistant think think` | user_input | 4 | 1,126 | 0.049/rec | 0.0000/rec | 9999.0x |
| `c d im end` | user_input | 4 | 482 | 0.021/rec | 0.0000/rec | 9999.0x |
| `b c d im end` | user_input | 5 | 461 | 0.020/rec | 0.0000/rec | 9999.0x |

### nemotron-rl-tool-use (19,310 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `i need to verify your` | assistant_text | 5 | 1,799 | 0.094/rec | 0.0000/rec | 31892.8x |
| `transfer to human agent` | assistant_text | 4 | 1,776 | 0.092/rec | 0.0000/rec | 31485.1x |
| `verify your identity to` | assistant_text | 4 | 687 | 0.036/rec | 0.0000/rec | 12179.2x |
| `the user s identity` | assistant_thought | 4 | 698 | 0.036/rec | 0.0000/rec | 9999.0x |
| `the user s identity before` | assistant_thought | 5 | 535 | 0.028/rec | 0.0000/rec | 9999.0x |

### tool-reasoning-toucan (19,172 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `you ll have a` | assistant_text | 4 | 429 | 0.023/rec | -0.0000/rec | 9999.0x |
| `private true safe false` | assistant_text | 4 | 666 | 0.035/rec | 0.0000/rec | 9999.0x |
| `2cnull 2cnull 2cnull 2cnull` | assistant_text | 4 | 359 | 0.019/rec | 0.0000/rec | 9999.0x |
| `true private true safe` | assistant_text | 4 | 885 | 0.047/rec | 0.0000/rec | 9999.0x |
| `enhance true nologo true` | assistant_text | 4 | 964 | 0.051/rec | 0.0000/rec | 9999.0x |

### dolci-instruct-tool-use (19,134 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `end with 'the correct` | user_input | 4 | 800 | 0.042/rec | 0.0000/rec | 9999.0x |
| `should end with 'the` | user_input | 4 | 800 | 0.042/rec | 0.0000/rec | 9999.0x |
| `with 'the correct answer` | user_input | 4 | 800 | 0.042/rec | 0.0000/rec | 9999.0x |
| `followed by the correct` | user_input | 4 | 800 | 0.042/rec | 0.0000/rec | 9999.0x |
| `final response should end` | user_input | 4 | 800 | 0.042/rec | 0.0000/rec | 9999.0x |

### agent-trove (18,984 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `plan the task is` | assistant_text | 4 | 3,952 | 0.385/rec | 0.0000/rec | 134595.1x |
| `plan the task is complete` | assistant_text | 5 | 3,892 | 0.379/rec | 0.0000/rec | 132551.7x |
| `extra text detected before` | user_input | 4 | 1,757 | 0.093/rec | 0.0000/rec | 44136.7x |
| `warnings extra text detected before` | user_input | 5 | 1,757 | 0.093/rec | 0.0000/rec | 44136.7x |
| `text detected before json` | user_input | 4 | 1,743 | 0.092/rec | 0.0000/rec | 43785.0x |

### openclaw-operator (18,907 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `m providing the structured` | assistant_thought | 4 | 1,878 | 0.099/rec | 0.0000/rec | 41752.7x |
| `i m providing the structured` | assistant_thought | 5 | 1,878 | 0.099/rec | 0.0000/rec | 41752.7x |
| `so the system can` | assistant_thought | 4 | 1,381 | 0.073/rec | 0.0000/rec | 10234.4x |
| `the function calls that` | assistant_thought | 4 | 1,032 | 0.055/rec | 0.0000/rec | 9999.0x |
| `providing the structured function` | assistant_thought | 4 | 1,054 | 0.056/rec | 0.0000/rec | 9999.0x |

### glaive-fc-v2-reasoning (17,242 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `user of limitation and` | assistant_thought | 4 | 1,021 | 0.059/rec | 0.0000/rec | 24988.6x |
| `inform user of capability` | assistant_thought | 4 | 1,727 | 0.100/rec | 0.0000/rec | 9999.0x |
| `inform user of calculated` | assistant_thought | 4 | 948 | 0.055/rec | 0.0000/rec | 9999.0x |
| `respond to user's gratitude` | assistant_thought | 4 | 1,260 | 0.073/rec | 0.0000/rec | 9999.0x |
| `user's gratitude and invite` | assistant_thought | 4 | 778 | 0.045/rec | 0.0000/rec | 9999.0x |

### glaive-fc-v2 (17,081 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `user expressed gratitude so a` | assistant_thought | 5 | 339 | 0.020/rec | 0.0001/rec | 174.8x |
| `the user expressed gratitude so` | assistant_thought | 5 | 481 | 0.028/rec | 0.0002/rec | 145.2x |
| `acknowledgment and invitation for further` | assistant_thought | 5 | 319 | 0.019/rec | 0.0002/rec | 114.4x |
| `can t book flights and` | assistant_thought | 5 | 386 | 0.023/rec | 0.0004/rec | 57.6x |
| `i can t book` | assistant_thought | 4 | 494 | 0.029/rec | 0.0005/rec | 56.6x |

### hermes-omniforge-qwen36 (16,593 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `use available tools to` | user_input | 4 | 4,265 | 0.257/rec | 0.0000/rec | 30797.9x |
| `and no further action` | assistant_text | 4 | 4,265 | 0.257/rec | 0.0000/rec | 29443.1x |
| `and no further action is` | assistant_text | 5 | 4,265 | 0.257/rec | 0.0000/rec | 29443.1x |
| `is marked as a` | assistant_text | 4 | 7,563 | 0.456/rec | 0.0000/rec | 26105.3x |
| `the request conflicts with` | assistant_text | 4 | 726 | 0.044/rec | 0.0000/rec | 15035.7x |

### mcp-flow (15,548 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `tool because the user wants` | assistant_thought | 5 | 384 | 0.025/rec | 0.0000/rec | 583.4x |
| `tool because the user` | assistant_thought | 4 | 747 | 0.048/rec | 0.0002/rec | 291.8x |
| `i need to fetch the` | assistant_thought | 5 | 1,110 | 0.072/rec | 0.0003/rec | 283.7x |
| `need to fetch the` | assistant_thought | 4 | 1,113 | 0.072/rec | 0.0003/rec | 267.0x |
| `i need to fetch` | assistant_thought | 4 | 1,537 | 0.099/rec | 0.0004/rec | 245.8x |

### hermes-reasoning-tool-use (13,167 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `along with their ratings and` | assistant_text | 5 | 268 | 0.022/rec | 0.0000/rec | 1917.2x |
| `of elementary schools in austin` | assistant_thought | 5 | 545 | 0.041/rec | 0.0000/rec | 1763.5x |
| `list of elementary schools in` | assistant_thought | 5 | 542 | 0.041/rec | 0.0000/rec | 1753.8x |
| `a list of elementary schools` | assistant_thought | 5 | 542 | 0.041/rec | 0.0000/rec | 1753.8x |
| `requested a list of elementary` | assistant_thought | 5 | 428 | 0.033/rec | 0.0000/rec | 1731.2x |

### open-paws-tool-use (12,837 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `be open to exploring` | assistant_text | 4 | 517 | 0.056/rec | 0.0000/rec | 9999.0x |
| `you be interested in exploring` | assistant_text | 5 | 301 | 0.033/rec | 0.0000/rec | 9999.0x |
| `you be open to exploring` | assistant_text | 5 | 515 | 0.056/rec | 0.0000/rec | 9999.0x |
| `would you be interested` | assistant_text | 4 | 552 | 0.060/rec | 0.0000/rec | 4220.6x |
| `you be interested in` | assistant_text | 4 | 550 | 0.060/rec | 0.0000/rec | 4205.3x |

### hermes-3 (12,732 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `can set up the equation` | assistant_text | 5 | 263 | 0.022/rec | 0.0000/rec | 2554.6x |
| `we can set up the` | assistant_text | 5 | 381 | 0.032/rec | 0.0000/rec | 925.2x |
| `sides of the equation` | assistant_text | 4 | 419 | 0.035/rec | 0.0000/rec | 872.1x |
| `both sides of the equation` | assistant_text | 5 | 419 | 0.035/rec | 0.0001/rec | 469.6x |
| `we can set up` | assistant_text | 4 | 424 | 0.036/rec | 0.0001/rec | 457.6x |

### regularizer-reasoning-tool (12,700 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `description can you help` | user_input | 4 | 536 | 0.042/rec | 0.0000/rec | 20421.8x |
| `description can you help me` | user_input | 5 | 536 | 0.042/rec | 0.0000/rec | 20421.8x |
| `you think you have` | assistant_text | 4 | 500 | 0.039/rec | 0.0000/rec | 13670.7x |
| `any of the test` | user_input | 4 | 524 | 0.041/rec | 0.0000/rec | 9999.0x |
| `means you don't have` | user_input | 4 | 511 | 0.040/rec | 0.0000/rec | 9999.0x |

### aureth-corpus-hermes (12,597 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `reply to the user` | assistant_thought | 4 | 12,585 | 0.999/rec | 0.0903/rec | 11.1x |
| `but i need to` | assistant_text | 4 | 93 | 0.009/rec | 0.0008/rec | 10.2x |
| `you give me a` | user_input | 4 | 136 | 0.011/rec | 0.0013/rec | 8.0x |

### tool-reasoning-coding-nemotron (11,899 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `the user is planning a` | assistant_thought | 5 | 466 | 0.039/rec | 0.0000/rec | 16735.7x |
| `looking at the tool response` | assistant_thought | 5 | 368 | 0.031/rec | 0.0000/rec | 13216.2x |
| `okay let me start by` | assistant_thought | 5 | 491 | 0.041/rec | 0.0000/rec | 9999.0x |
| `me go through the user's` | assistant_thought | 5 | 415 | 0.035/rec | 0.0000/rec | 9999.0x |
| `make sure the response is` | assistant_thought | 5 | 514 | 0.043/rec | 0.0000/rec | 9999.0x |

### synth-routing-v2 (11,740 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `can you take a look` | user_input | 5 | 460 | 0.039/rec | 0.0000/rec | 9999.0x |
| `you take a look` | user_input | 4 | 460 | 0.039/rec | 0.0000/rec | 2374.7x |

### n8n-workflows-templates-0xarchit (11,642 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `generate json for n8n` | user_input | 4 | 480 | 0.041/rec | 0.0000/rec | 9999.0x |
| `devise an n8n automation` | user_input | 4 | 485 | 0.042/rec | 0.0000/rec | 9999.0x |
| `generate n8n workflow for` | user_input | 4 | 490 | 0.042/rec | 0.0000/rec | 9999.0x |
| `formulate an n8n flow` | user_input | 4 | 479 | 0.041/rec | 0.0000/rec | 9999.0x |
| `map out an n8n` | user_input | 4 | 495 | 0.043/rec | 0.0000/rec | 9999.0x |

### sharegpt-tool-calls (11,285 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `response status success message` | user_input | 4 | 627 | 0.056/rec | 0.0000/rec | 9999.0x |
| `function response status success` | user_input | 4 | 744 | 0.066/rec | 0.0000/rec | 9999.0x |
| `function response status success message` | user_input | 5 | 627 | 0.056/rec | 0.0000/rec | 9999.0x |
| `them and invite any further` | assistant_thought | 5 | 258 | 0.023/rec | 0.0006/rec | 38.7x |
| `thank them and invite any` | assistant_thought | 5 | 263 | 0.023/rec | 0.0006/rec | 38.7x |

### ishiki-labs-multi-party-dialogue (10,441 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `the end of the` | user_input | 4 | 134 | 0.013/rec | 0.0011/rec | 11.6x |
| `at the end of` | user_input | 4 | 106 | 0.010/rec | 0.0010/rec | 10.3x |
| `at the same time` | user_input | 4 | 76 | 0.007/rec | 0.0014/rec | 5.2x |

### n8n-master-corpus (8,876 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `webhook return only the` | user_input | 4 | 974 | 0.110/rec | 0.0000/rec | 53440.0x |
| `webhook return only the workflow` | user_input | 5 | 974 | 0.110/rec | 0.0000/rec | 53440.0x |
| `n8n workflow named 'build` | user_input | 4 | 522 | 0.059/rec | 0.0000/rec | 28640.3x |
| `an n8n workflow named 'build` | user_input | 5 | 522 | 0.059/rec | 0.0000/rec | 28640.3x |
| `mattermost return only the workflow` | user_input | 5 | 415 | 0.047/rec | 0.0000/rec | 22769.6x |

### n8n-workflows-thinking-stmasson (6,822 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `e un workflow n8n pour` | user_input | 5 | 3,349 | 0.491/rec | 0.0000/rec | 16005.3x |
| `e un workflow n8n` | user_input | 4 | 3,349 | 0.491/rec | 0.0000/rec | 15005.0x |
| `cr e un workflow n8n` | user_input | 5 | 3,349 | 0.491/rec | 0.0000/rec | 15005.0x |
| `un workflow n8n pour` | user_input | 4 | 3,349 | 0.491/rec | 0.0000/rec | 14122.3x |
| `workflow n8n pour this` | user_input | 4 | 775 | 0.114/rec | 0.0000/rec | 13889.4x |

### kimi-k25-reasoning-1m (6,430 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `let me structure a comprehensive` | assistant_thought | 5 | 577 | 0.090/rec | 0.0000/rec | 38837.9x |
| `user is asking a very` | assistant_thought | 5 | 389 | 0.060/rec | 0.0000/rec | 26183.6x |
| `let me structure a` | assistant_thought | 4 | 667 | 0.104/rec | 0.0000/rec | 14965.3x |
| `me structure the answer 1` | assistant_thought | 5 | 448 | 0.070/rec | 0.0000/rec | 9999.0x |
| `me structure a comprehensive answer` | assistant_thought | 5 | 561 | 0.087/rec | 0.0000/rec | 9999.0x |

### opus-47-thinking-25k-ansulev (6,392 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `how would you improve` | user_input | 4 | 6,068 | 0.949/rec | 0.0000/rec | 464668.1x |
| `phase 1 days 1` | assistant_thought | 4 | 5,015 | 0.785/rec | 0.0000/rec | 339974.6x |
| `phase 3 days 61` | assistant_text | 4 | 5,015 | 0.785/rec | 0.0000/rec | 277690.4x |
| `2 days 31 60` | assistant_text | 4 | 5,015 | 0.785/rec | 0.0000/rec | 277690.4x |
| `phase 2 days 31` | assistant_text | 4 | 5,015 | 0.785/rec | 0.0000/rec | 277690.4x |

### glm-51-reasoning-1m (6,376 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `and refine self correction` | assistant_thought | 4 | 691 | 0.108/rec | 0.0000/rec | 46911.1x |
| `review and refine self` | assistant_thought | 4 | 691 | 0.108/rec | 0.0000/rec | 46911.1x |
| `review and refine self correction` | assistant_thought | 5 | 691 | 0.108/rec | 0.0000/rec | 46911.1x |
| `3 structuring the response introduction` | assistant_thought | 5 | 543 | 0.085/rec | 0.0000/rec | 36863.5x |
| `review during drafting did i` | assistant_thought | 5 | 459 | 0.072/rec | 0.0000/rec | 31160.9x |

### scambench (6,130 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `canonical action refuse for` | assistant_thought | 4 | 602 | 0.099/rec | 0.0002/rec | 435.4x |
| `refuse for this seed` | assistant_thought | 4 | 602 | 0.099/rec | 0.0002/rec | 435.4x |
| `choose canonical action refuse` | assistant_thought | 4 | 602 | 0.099/rec | 0.0002/rec | 435.4x |
| `action refuse for this` | assistant_thought | 4 | 602 | 0.099/rec | 0.0002/rec | 435.4x |
| `choose canonical action refuse for` | assistant_thought | 5 | 602 | 0.099/rec | 0.0002/rec | 435.4x |

### bitagent-tool-calling (5,798 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `can you help me access` | user_input | 5 | 454 | 0.078/rec | 0.0000/rec | 38374.1x |
| `to gaming sites can you` | user_input | 5 | 454 | 0.078/rec | 0.0000/rec | 9999.0x |
| `device for any crypto miners` | user_input | 5 | 419 | 0.072/rec | 0.0000/rec | 9999.0x |
| `scan my device for any` | user_input | 5 | 419 | 0.072/rec | 0.0000/rec | 9999.0x |
| `many people clicked the link` | user_input | 5 | 402 | 0.069/rec | 0.0000/rec | 9999.0x |

### deepfabric-github-mcp (5,229 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `url https api github` | user_input | 4 | 576 | 0.110/rec | 0.0000/rec | 54151.3x |
| `url https api github com` | user_input | 5 | 576 | 0.110/rec | 0.0000/rec | 54151.3x |
| `https api github com repos` | user_input | 5 | 470 | 0.090/rec | 0.0000/rec | 11046.5x |
| `https api github com` | user_input | 4 | 618 | 0.118/rec | 0.0000/rec | 5810.0x |
| `api github com repos` | user_input | 4 | 470 | 0.090/rec | 0.0000/rec | 4909.5x |

### synth-action-pairs-lifeops (4,987 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `but i think i need` | user_input | 5 | 499 | 0.100/rec | 0.0000/rec | 49117.9x |
| `let me say it` | user_input | 4 | 497 | 0.100/rec | 0.0000/rec | 48921.1x |
| `do not do this` | user_input | 4 | 494 | 0.099/rec | 0.0000/rec | 48625.8x |
| `i think i need` | user_input | 4 | 499 | 0.100/rec | 0.0000/rec | 16372.6x |
| `might be saying this` | user_input | 4 | 499 | 0.100/rec | 0.0000/rec | 9999.0x |

### opus-4647-reasoning-8k7 (4,471 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `i should also mention the` | assistant_thought | 5 | 63 | 0.028/rec | 0.0008/rec | 35.2x |
| `is one of the` | assistant_text | 4 | 260 | 0.058/rec | 0.0023/rec | 25.2x |
| `is one of the most` | assistant_text | 5 | 137 | 0.031/rec | 0.0014/rec | 22.0x |
| `this is a classic` | assistant_thought | 4 | 65 | 0.029/rec | 0.0016/rec | 18.7x |
| `the key insight is` | assistant_thought | 4 | 53 | 0.024/rec | 0.0014/rec | 17.1x |

### mcp-agent-training-data (4,145 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `response assistant communicates with` | user_input | 4 | 431 | 0.104/rec | 0.0003/rec | 336.4x |
| `an inquiry response assistant` | user_input | 4 | 431 | 0.104/rec | 0.0003/rec | 336.4x |
| `inquiry response assistant communicates` | user_input | 4 | 431 | 0.104/rec | 0.0003/rec | 336.4x |
| `inquirer and provides answers` | user_input | 4 | 431 | 0.104/rec | 0.0003/rec | 336.4x |
| `definition inquirer a user` | user_input | 4 | 431 | 0.104/rec | 0.0003/rec | 336.4x |

### scam-defense-corpus (4,022 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `i'll continue to monitor the` | assistant_thought | 5 | 255 | 0.064/rec | 0.0003/rec | 224.7x |
| `handle this right away` | user_input | 4 | 745 | 0.187/rec | 0.0010/rec | 194.6x |
| `to handle this right away` | user_input | 5 | 745 | 0.187/rec | 0.0010/rec | 194.6x |
| `to handle this right` | user_input | 4 | 746 | 0.187/rec | 0.0010/rec | 194.4x |
| `you to handle this right` | user_input | 5 | 746 | 0.187/rec | 0.0010/rec | 194.4x |

### hermes-agent-reasoning-traces (3,379 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `name terminal arguments command` | assistant_text | 4 | 454 | 0.135/rec | 0.0000/rec | 24003.5x |
| `think tool call name` | assistant_text | 4 | 886 | 0.263/rec | 0.0000/rec | 18737.5x |
| `terminal arguments tool call` | assistant_text | 4 | 431 | 0.128/rec | 0.0000/rec | 9999.0x |
| `call name terminal arguments` | assistant_text | 4 | 885 | 0.262/rec | 0.0000/rec | 9999.0x |
| `name terminal arguments tool` | assistant_text | 4 | 431 | 0.128/rec | 0.0000/rec | 9999.0x |

### nemotron-nano-hermes-traces (2,994 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `from dataclasses import dataclass` | assistant_text | 4 | 367 | 0.123/rec | 0.0002/rec | 560.9x |
| `let i 0 i` | assistant_text | 4 | 155 | 0.052/rec | 0.0006/rec | 89.3x |
| `for let i 0 i` | assistant_text | 5 | 155 | 0.052/rec | 0.0006/rec | 89.3x |
| `for let i 0` | assistant_text | 4 | 155 | 0.052/rec | 0.0006/rec | 88.8x |
| `python import numpy as np` | assistant_text | 5 | 87 | 0.029/rec | 0.0005/rec | 54.0x |

### hermes-fc-v1 (2,712 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `need to create a` | user_input | 4 | 110 | 0.041/rec | 0.0014/rec | 29.7x |
| `you need anything else feel` | assistant_text | 5 | 75 | 0.029/rec | 0.0011/rec | 27.2x |
| `need anything else feel` | assistant_text | 4 | 75 | 0.029/rec | 0.0011/rec | 27.1x |
| `need anything else feel free` | assistant_text | 5 | 75 | 0.029/rec | 0.0011/rec | 27.1x |
| `keep the tone friendly while` | assistant_thought | 5 | 54 | 0.020/rec | 0.0008/rec | 26.1x |

### mobile-actions (2,500 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `send an email to` | user_input | 4 | 577 | 0.231/rec | 0.0003/rec | 716.2x |
| `can you show me the` | user_input | 5 | 147 | 0.059/rec | 0.0005/rec | 108.7x |
| `tool with the provided` | assistant_thought | 4 | 269 | 0.108/rec | 0.0011/rec | 94.2x |
| `i need to act` | assistant_thought | 4 | 236 | 0.094/rec | 0.0011/rec | 87.0x |
| `i need to act on` | assistant_thought | 5 | 229 | 0.092/rec | 0.0011/rec | 86.6x |

### opus-46-10kx-bas95 (2,461 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `me solve this step` | assistant_thought | 4 | 413 | 0.168/rec | 0.0008/rec | 203.3x |
| `solve this step by` | assistant_thought | 4 | 413 | 0.168/rec | 0.0008/rec | 203.3x |
| `solve this step by step` | assistant_thought | 5 | 413 | 0.168/rec | 0.0008/rec | 203.3x |
| `let me solve this step` | assistant_thought | 5 | 413 | 0.168/rec | 0.0008/rec | 203.3x |
| `me solve this step by` | assistant_thought | 5 | 413 | 0.168/rec | 0.0008/rec | 203.3x |

### synth-action-planner (2,333 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `is asking me to` | assistant_thought | 4 | 594 | 0.255/rec | 0.0040/rec | 63.6x |

### n8n-workflows-sft-eclaude (2,332 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `on form submission to` | assistant_thought | 4 | 112 | 0.048/rec | 0.0017/rec | 28.0x |
| `a on form submission to` | assistant_thought | 5 | 112 | 0.048/rec | 0.0017/rec | 28.0x |
| `wants a on form` | assistant_thought | 4 | 119 | 0.051/rec | 0.0020/rec | 25.5x |
| `user wants a on form` | assistant_thought | 5 | 119 | 0.051/rec | 0.0020/rec | 25.5x |
| `a on form submission` | assistant_thought | 4 | 113 | 0.048/rec | 0.0019/rec | 25.4x |

### playwright-mcp-toolcalling (2,324 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `url https www google` | user_input | 4 | 1,317 | 0.567/rec | 0.0000/rec | 279690.8x |
| `url https www google com` | user_input | 5 | 1,317 | 0.567/rec | 0.0000/rec | 279690.8x |
| `page url https www` | user_input | 4 | 774 | 0.333/rec | 0.0000/rec | 164374.1x |
| `to a search engine` | assistant_thought | 4 | 661 | 0.284/rec | 0.0000/rec | 41422.5x |
| `skip to main content` | user_input | 4 | 498 | 0.214/rec | 0.0000/rec | 26440.0x |

### opus-47-max-sft-labs (2,009 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `the key insight is that` | assistant_thought | 5 | 127 | 0.075/rec | 0.0008/rec | 96.4x |
| `the key insight is` | assistant_thought | 4 | 137 | 0.081/rec | 0.0012/rec | 67.6x |
| `i need to find` | assistant_text | 4 | 70 | 0.037/rec | 0.0015/rec | 23.9x |
| `let me work through` | assistant_thought | 4 | 87 | 0.051/rec | 0.0023/rec | 22.2x |
| `i need to figure out` | assistant_thought | 5 | 50 | 0.029/rec | 0.0033/rec | 9.0x |

### deepseek-v4-distill-8000x (1,984 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `n n n n` | user_input | 4 | 154 | 0.078/rec | 0.0007/rec | 108.9x |
| `need to write a python` | assistant_thought | 5 | 156 | 0.079/rec | 0.0007/rec | 107.5x |
| `we need to write a` | assistant_thought | 5 | 259 | 0.131/rec | 0.0016/rec | 83.1x |
| `we need to create a` | assistant_thought | 5 | 165 | 0.083/rec | 0.0013/rec | 63.1x |
| `i should structure the answer` | assistant_thought | 5 | 94 | 0.047/rec | 0.0008/rec | 57.1x |

### tool-use-multiturn-thinking (1,605 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `impossible until it's done` | assistant_text | 4 | 251 | 0.252/rec | 0.0007/rec | 335.6x |
| `seems impossible until it's` | assistant_text | 4 | 251 | 0.252/rec | 0.0007/rec | 335.6x |
| `seems impossible until it's done` | assistant_text | 5 | 251 | 0.252/rec | 0.0007/rec | 335.6x |
| `always seems impossible until it's` | assistant_text | 5 | 251 | 0.252/rec | 0.0007/rec | 335.6x |
| `always seems impossible until` | assistant_text | 4 | 251 | 0.252/rec | 0.0008/rec | 334.3x |

### n8n-toolkit-davidrpatton (1,592 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `by step process and` | user_input | 4 | 1,040 | 0.653/rec | 0.0000/rec | 161447.9x |
| `step by step process and` | user_input | 5 | 1,040 | 0.653/rec | 0.0000/rec | 161447.9x |
| `to provide a comprehensive understanding` | user_input | 5 | 1,040 | 0.653/rec | 0.0000/rec | 161447.9x |
| `2 how it works` | user_input | 4 | 1,040 | 0.653/rec | 0.0000/rec | 107631.9x |
| `1 workflow overview this` | user_input | 4 | 1,018 | 0.639/rec | 0.0000/rec | 105355.1x |

### synth-dialogue-routing (1,452 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `end im start user` | user_input | 4 | 2,904 | 2.000/rec | 0.0000/rec | 9999.0x |
| `im end end of` | user_input | 4 | 1,444 | 0.994/rec | 0.0000/rec | 9999.0x |
| `end end of text` | user_input | 4 | 1,444 | 0.994/rec | 0.0000/rec | 9999.0x |
| `im end end of text` | user_input | 5 | 1,444 | 0.994/rec | 0.0000/rec | 9999.0x |
| `im end im start user` | user_input | 5 | 2,904 | 2.000/rec | 0.0000/rec | 9999.0x |

### glm-47-multiturn-cot (1,301 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `1 analyze the user's request` | assistant_thought | 5 | 365 | 0.281/rec | 0.0000/rec | 30715.9x |
| `self correction during drafting i` | assistant_thought | 5 | 246 | 0.189/rec | 0.0016/rec | 120.9x |
| `correction during drafting i` | assistant_thought | 4 | 247 | 0.190/rec | 0.0016/rec | 120.8x |
| `the content iterative refinement` | assistant_thought | 4 | 201 | 0.154/rec | 0.0017/rec | 91.2x |
| `drafting the content iterative refinement` | assistant_thought | 5 | 191 | 0.147/rec | 0.0017/rec | 87.6x |

### n8n-workflows-v2-4k-arkelai (1,106 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `do not add any` | user_input | 4 | 1,106 | 1.000/rec | 0.0000/rec | 494765.0x |
| `n8n expert only return` | user_input | 4 | 1,106 | 1.000/rec | 0.0000/rec | 9999.0x |
| `powerful n8n expert only` | user_input | 4 | 1,106 | 1.000/rec | 0.0000/rec | 9999.0x |
| `json of the workflow` | user_input | 4 | 1,106 | 1.000/rec | 0.0000/rec | 9999.0x |
| `text i need a` | user_input | 4 | 950 | 0.859/rec | 0.0000/rec | 9999.0x |

### n8nbuilder-perspicacious (1,016 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `efficient and error free` | user_input | 4 | 1,016 | 1.000/rec | 0.0000/rec | 494855.0x |
| `your goal is to create` | user_input | 5 | 1,016 | 1.000/rec | 0.0000/rec | 494855.0x |
| `on the user's requirements` | user_input | 4 | 1,016 | 1.000/rec | 0.0000/rec | 247427.5x |
| `based on the user's requirements` | user_input | 5 | 1,016 | 1.000/rec | 0.0000/rec | 247427.5x |
| `only the valid json` | user_input | 4 | 1,016 | 1.000/rec | 0.0000/rec | 54983.9x |

### qwen36-trajectory (999 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `i need to authenticate your` | assistant_text | 5 | 94 | 0.250/rec | 0.0005/rec | 528.8x |
| `i need to authenticate` | assistant_text | 4 | 101 | 0.269/rec | 0.0008/rec | 320.9x |
| `thank you for providing` | assistant_text | 4 | 68 | 0.181/rec | 0.0008/rec | 236.5x |
| `at the beginning of the` | assistant_thought | 5 | 146 | 0.146/rec | 0.0007/rec | 222.4x |
| `could you please provide your` | assistant_text | 5 | 107 | 0.285/rec | 0.0015/rec | 186.4x |

### ha-mcp-dataset (970 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `let the user know` | assistant_thought | 4 | 82 | 0.085/rec | 0.0013/rec | 63.3x |
| `user wants to know` | assistant_thought | 4 | 88 | 0.091/rec | 0.0034/rec | 26.8x |
| `i note the user` | assistant_thought | 4 | 53 | 0.055/rec | 0.0039/rec | 14.2x |

### carnice-glm5-hermes (949 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `the current working directory` | user_input | 4 | 638 | 0.674/rec | 0.0000/rec | 17567.7x |
| `operating inside an isolated` | user_input | 4 | 638 | 0.674/rec | 0.0000/rec | 9999.0x |
| `home directories or unrelated` | user_input | 4 | 638 | 0.674/rec | 0.0000/rec | 9999.0x |
| `isolated disposable workspace that` | user_input | 4 | 638 | 0.674/rec | 0.0000/rec | 9999.0x |
| `or files outside this` | user_input | 4 | 638 | 0.674/rec | 0.0000/rec | 9999.0x |

### hermes-fc-thinking-v1 (895 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `sure the loan amount is` | user_input | 5 | 62 | 0.069/rec | 0.0008/rec | 91.2x |
| `5 and the loan term` | user_input | 5 | 69 | 0.077/rec | 0.0010/rec | 80.7x |
| `5 and the loan` | user_input | 4 | 69 | 0.077/rec | 0.0010/rec | 78.4x |
| `and the loan term` | user_input | 4 | 71 | 0.079/rec | 0.0010/rec | 76.2x |
| `and the loan term is` | user_input | 5 | 71 | 0.079/rec | 0.0010/rec | 76.2x |

### synth-action-pairs-actions (835 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `so i ll issue the` | assistant_thought | 5 | 102 | 0.122/rec | 0.0008/rec | 147.5x |
| `to fulfill that request` | assistant_thought | 4 | 142 | 0.170/rec | 0.0013/rec | 132.2x |
| `so i ll issue` | assistant_thought | 4 | 111 | 0.133/rec | 0.0013/rec | 99.3x |
| `appropriate tool call to` | assistant_thought | 4 | 144 | 0.172/rec | 0.0018/rec | 95.1x |
| `the appropriate tool call to` | assistant_thought | 5 | 144 | 0.172/rec | 0.0018/rec | 95.1x |

### n8n-workflows-yagnik (737 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `workflow drafting with 2` | assistant_thought | 4 | 692 | 0.939/rec | 0.0042/rec | 224.6x |
| `drafting with 2 nodes` | assistant_thought | 4 | 692 | 0.939/rec | 0.0042/rec | 224.6x |
| `workflow drafting with 2 nodes` | assistant_thought | 5 | 692 | 0.939/rec | 0.0042/rec | 224.6x |
| `with 2 nodes connect` | assistant_text | 4 | 674 | 0.915/rec | 0.0047/rec | 194.8x |
| `2 nodes connect any` | assistant_text | 4 | 674 | 0.915/rec | 0.0047/rec | 194.8x |

### synth-messaging-actions (676 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `the appropriate tool call` | assistant_thought | 4 | 57 | 0.084/rec | 0.0035/rec | 23.8x |
| `user s request to` | assistant_thought | 4 | 67 | 0.099/rec | 0.0052/rec | 19.2x |
| `the user s request to` | assistant_thought | 5 | 67 | 0.099/rec | 0.0052/rec | 19.2x |
| `so i ll invoke the` | assistant_thought | 5 | 105 | 0.155/rec | 0.0083/rec | 18.8x |
| `i ll invoke the` | assistant_thought | 4 | 110 | 0.163/rec | 0.0088/rec | 18.4x |

### n8n-workflow-dataset-ruh-ai (654 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `generate an n8n workflow` | user_input | 4 | 258 | 0.394/rec | 0.0005/rec | 831.3x |
| `drafted 'untitled workflow' with` | assistant_text | 4 | 149 | 0.229/rec | 0.0008/rec | 269.2x |
| `an n8n workflow that` | user_input | 4 | 310 | 0.474/rec | 0.0022/rec | 213.2x |
| `an n8n workflow for` | user_input | 4 | 87 | 0.133/rec | 0.0015/rec | 86.5x |
| `wants a webhook to` | assistant_thought | 4 | 77 | 0.118/rec | 0.0046/rec | 25.5x |

### opus-47-reasoning-cot-ansulev (649 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `step by step derivation` | assistant_thought | 4 | 638 | 0.991/rec | 0.0006/rec | 1658.4x |
| `the correct answer is` | assistant_text | 4 | 57 | 0.089/rec | 0.0045/rec | 19.9x |

### mcp-routing-dataset (636 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `the most appropriate tool` | assistant_text | 4 | 633 | 1.000/rec | 0.0000/rec | 179651.0x |
| `thought the user wants to` | assistant_text | 5 | 633 | 1.000/rec | 0.0000/rec | 119767.3x |
| `thought the user wants` | assistant_text | 4 | 633 | 1.000/rec | 0.0000/rec | 89825.5x |
| `most appropriate tool is` | assistant_text | 4 | 633 | 1.000/rec | 0.0000/rec | 9999.0x |
| `the most appropriate tool is` | assistant_text | 5 | 633 | 1.000/rec | 0.0000/rec | 9999.0x |

### nubilio-trajectories (579 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `at the same time` | user_input | 4 | 64 | 0.111/rec | 0.0014/rec | 79.2x |

### n8n-workflow-template-rubenz (510 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `type n8n nodes base` | user_input | 4 | 1,040 | 2.039/rec | 0.0001/rec | 22957.9x |
| `this n8n workflow template` | user_input | 4 | 511 | 1.002/rec | 0.0001/rec | 10340.3x |
| `n8n nodes base stickynote` | user_input | 4 | 474 | 0.929/rec | 0.0001/rec | 7673.2x |
| `n8n nodes langchain lmchatopenai` | user_input | 4 | 64 | 0.125/rec | 0.0022/rec | 56.7x |
| `n8n n8n nodes langchain lmchatopenai` | user_input | 5 | 60 | 0.118/rec | 0.0022/rec | 53.2x |

### n8n-workflow-ruh-ai (499 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `workflow for given condition` | user_input | 4 | 499 | 1.000/rec | 0.0000/rec | 9999.0x |
| `create an n8n json` | user_input | 4 | 499 | 1.000/rec | 0.0000/rec | 9999.0x |
| `n8n json workflow for` | user_input | 4 | 499 | 1.000/rec | 0.0000/rec | 9999.0x |
| `an n8n json workflow` | user_input | 4 | 499 | 1.000/rec | 0.0000/rec | 9999.0x |
| `json workflow for given` | user_input | 4 | 499 | 1.000/rec | 0.0000/rec | 9999.0x |

### synth-agent-orch (486 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `so i ll trigger the` | assistant_thought | 5 | 54 | 0.112/rec | 0.0011/rec | 98.5x |
| `so i ll issue` | assistant_thought | 4 | 58 | 0.120/rec | 0.0015/rec | 82.2x |
| `appropriate tool call to` | assistant_thought | 4 | 68 | 0.140/rec | 0.0020/rec | 70.8x |
| `the appropriate tool call to` | assistant_thought | 5 | 68 | 0.140/rec | 0.0020/rec | 70.8x |
| `the appropriate tool call` | assistant_thought | 4 | 90 | 0.186/rec | 0.0035/rec | 53.7x |

### n8n-grpo-4k-aks729 (476 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `drafted 'untitled workflow' with` | assistant_text | 4 | 184 | 0.387/rec | 0.0008/rec | 514.6x |
| `generate an n8n workflow` | user_input | 4 | 138 | 0.290/rec | 0.0007/rec | 404.6x |
| `an n8n workflow that` | user_input | 4 | 252 | 0.529/rec | 0.0023/rec | 226.3x |
| `drafting with 4 nodes` | assistant_thought | 4 | 96 | 0.202/rec | 0.0046/rec | 43.9x |
| `workflow drafting with 4` | assistant_thought | 4 | 96 | 0.202/rec | 0.0046/rec | 43.9x |

### phi3-mcp (403 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `the user input and determine` | user_input | 5 | 403 | 1.000/rec | 0.0000/rec | 9999.0x |
| `if yes respond with tool` | user_input | 5 | 403 | 1.000/rec | 0.0000/rec | 9999.0x |
| `a tool call is needed` | user_input | 5 | 403 | 1.000/rec | 0.0000/rec | 9999.0x |
| `user input and determine if` | user_input | 5 | 403 | 1.000/rec | 0.0000/rec | 9999.0x |
| `tool call is needed if` | user_input | 5 | 403 | 1.000/rec | 0.0000/rec | 9999.0x |

### synth-commerce-actions (398 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `so i ll invoke the` | assistant_thought | 5 | 78 | 0.196/rec | 0.0083/rec | 23.5x |
| `i ll invoke the` | assistant_thought | 4 | 82 | 0.206/rec | 0.0089/rec | 23.2x |
| `so i ll invoke` | assistant_thought | 4 | 78 | 0.196/rec | 0.0085/rec | 23.1x |
| `i see the user` | assistant_thought | 4 | 123 | 0.309/rec | 0.0247/rec | 12.5x |
| `i see the user wants` | assistant_thought | 5 | 72 | 0.181/rec | 0.0168/rec | 10.7x |

### synth-music-actions (335 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `so i ll trigger the` | assistant_thought | 5 | 57 | 0.170/rec | 0.0011/rec | 151.2x |
| `to fulfill that request` | assistant_thought | 4 | 51 | 0.152/rec | 0.0015/rec | 102.0x |
| `recognize the user wants` | assistant_thought | 4 | 60 | 0.179/rec | 0.0039/rec | 45.5x |
| `i recognize the user wants` | assistant_thought | 5 | 60 | 0.179/rec | 0.0039/rec | 45.5x |
| `i recognize the user` | assistant_thought | 4 | 63 | 0.188/rec | 0.0053/rec | 35.8x |

### talos-kimi-hermes (262 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `reply to the user` | assistant_thought | 4 | 262 | 1.000/rec | 0.1159/rec | 8.6x |

### n8n-workflow-di12 (249 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `on clicking 'execute' to` | assistant_thought | 4 | 108 | 0.434/rec | 0.0131/rec | 33.0x |
| `a on clicking 'execute'` | assistant_thought | 4 | 108 | 0.434/rec | 0.0131/rec | 33.0x |
| `wants a on clicking` | assistant_thought | 4 | 108 | 0.434/rec | 0.0131/rec | 33.0x |
| `wants a on clicking 'execute'` | assistant_thought | 5 | 108 | 0.434/rec | 0.0131/rec | 33.0x |
| `a on clicking 'execute' to` | assistant_thought | 5 | 108 | 0.434/rec | 0.0131/rec | 33.0x |

### n8n-grpo-2k-aks729 (247 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `drafted 'untitled workflow' with` | assistant_text | 4 | 121 | 0.490/rec | 0.0009/rec | 529.1x |
| `generate an n8n workflow` | user_input | 4 | 97 | 0.393/rec | 0.0008/rec | 491.5x |
| `an n8n workflow that` | user_input | 4 | 106 | 0.429/rec | 0.0026/rec | 163.0x |
| `drafting with 3 nodes` | assistant_thought | 4 | 96 | 0.389/rec | 0.0055/rec | 70.9x |
| `workflow drafting with 3` | assistant_thought | 4 | 96 | 0.389/rec | 0.0055/rec | 70.9x |

### synth-system-actions (246 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `i see the user` | assistant_thought | 4 | 66 | 0.268/rec | 0.0248/rec | 10.8x |

### synth-web3-actions (228 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `see the user wants to` | assistant_thought | 5 | 86 | 0.377/rec | 0.0072/rec | 52.3x |
| `i see the user wants` | assistant_thought | 5 | 87 | 0.382/rec | 0.0168/rec | 22.7x |
| `the user wants to` | assistant_thought | 4 | 120 | 0.526/rec | 0.0261/rec | 20.2x |
| `see the user wants` | assistant_thought | 4 | 87 | 0.382/rec | 0.0211/rec | 18.1x |
| `i see the user` | assistant_thought | 4 | 101 | 0.443/rec | 0.0247/rec | 17.9x |

### qwen35-reasoning-700x (162 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `so a d e` | assistant_thought | 4 | 1,491 | 9.204/rec | 0.0000/rec | 4041088.6x |
| `i'll check if i` | assistant_thought | 4 | 1,682 | 10.383/rec | 0.0000/rec | 2279380.0x |
| `x 2y 3 0 and` | assistant_thought | 5 | 504 | 3.111/rec | 0.0000/rec | 1366001.8x |
| `check if i should` | assistant_thought | 4 | 1,477 | 9.117/rec | 0.0000/rec | 1334381.4x |
| `x 2y 3 0` | assistant_thought | 4 | 929 | 5.735/rec | 0.0000/rec | 1258944.1x |

### n8n-workflows-batuhanilgarr (133 records)

| n-gram | stream | n | in-source | src rate | rest rate | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| `n8n nodes base stickynote` | user_input | 4 | 60 | 0.451/rec | 0.0010/rec | 471.8x |
| `n8n n8n nodes langchain` | user_input | 4 | 225 | 1.692/rec | 0.0169/rec | 100.3x |
| `return only the workflow` | user_input | 4 | 133 | 1.000/rec | 0.0190/rec | 52.6x |
| `only the workflow json` | user_input | 4 | 133 | 1.000/rec | 0.0190/rec | 52.6x |
| `return only the workflow json` | user_input | 5 | 133 | 1.000/rec | 0.0190/rec | 52.6x |

## 4. Round-1 synth fingerprint

n-grams in `assistant_thought` whose top-source is one of `['aureth-corpus-hermes', 'hermes-3', 'hermes-agent-reasoning-traces', 'hermes-fc-thinking-v1', 'hermes-fc-v1', 'hermes-omniforge-qwen36', 'nemotron-nano-hermes-traces', 'synth-action-pairs-actions', 'synth-action-pairs-lifeops', 'synth-action-planner', 'synth-dialogue-routing', 'synth-messaging-actions', 'synth-routing-v2']`. These are the n-grams most indicative of the round-1 Groq synth voice.

_No `assistant_thought` n-grams matched a round-1 synth source as their top contributor at the >40% share threshold._

## 5. Recommendations

All numbers below extrapolate from the sampled run (every 3 record). Multiply by ~3 for full-corpus impact.

### 5a. Re-paraphrase via Groq (round-2 thought rewrite)

**Targets:** assistant_thought n-grams concentrated >50% in a single source. Action: a Groq pass that takes each affected record's thought and asks the model to rewrite it without phrase X (or any close paraphrase).

**Estimated scope:** 73,563 – 219,546 affected records (corpus-projected).

| n-gram | n | ≈records | rec % | top source |
| --- | --- | --- | --- | --- |
| `call the tool to` | 4 | 73,563 | 5.6% | nemotron-rl-tool-use (61.2%) |
| `to satisfy the request` | 4 | 73,128 | 5.5% | nemotron-rl-tool-use (61.5%) |
| `tool to satisfy the` | 4 | 72,855 | 5.5% | nemotron-rl-tool-use (61.8%) |

### 5b. Lower per-source cap

**Targets:** sources whose distinctive n-grams concentrate the stylistic skew. Action: lower per-source max from the current ceiling (~50k) to ~25k or below for these sources, sampling uniformly within the source.

| source | ≈records | candidates | sample n-grams |
| --- | --- | --- | --- |
| n8n-mega-workflows | 76,914 | 14 | `then confirm to deploy`; `connect any required credentials`; `required credentials then confirm` |
| openclaw-operator | 56,721 | 1 | `the user s request` |

### 5c. Filter out (drop matching records)

**Targets:** AI-disclaimer / refusal patterns and tokenizer leakage. Action: a single-pass regex filter that drops records whose `expectedResponse` matches one of these phrases.

_No AI-disclaimer / `<|endoftext|>` patterns crossed the 5% / gini-0.7 threshold. (They may still exist below the threshold; recommend a targeted regex sweep.)_

## Files

Raw outputs live under `data/synthesized/review/ngrams/`:
- `user_input_ngrams.json`
- `assistant_thought_ngrams.json`
- `assistant_text_ngrams.json`
- `diversification_candidates.json`
- `per_source_distinctive.json`
- `_run_summary.json`
