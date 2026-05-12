# Distribution — bucket: `scope_global_vs_user`

Total scenarios: **40**

## Length brackets (intended vs actual)

Some buckets require a semantic minimum (e.g. `note_trait_unrelated` needs ≥3 turns to test a trait on an unrelated topic; `scope_global_vs_user` needs ≥4 turns for two-room flow). When the intended bracket falls below that minimum, the scenario is clamped upward and its `length:<bracket>` tag reflects the **actual** count.

| Bracket | Intended count | Actual count |
|---|---:|---:|
| `len_1` (1 turn) | 5 | 0 |
| `len_2` (2 turns) | 5 | 0 |
| `len_3to5` (3-5 turns) | 5 | 15 |
| `len_6to8` (6-8 turns) | 5 | 5 |
| `len_9to12` (9-12 turns) | 5 | 5 |
| `len_13to16` (13-16 turns) | 5 | 5 |
| `len_17to20` (17-20 turns) | 5 | 5 |
| `len_21to25` (21-25 turns) | 5 | 5 |

## Aggression levels

| Level | Count |
|---|---:|
| `polite` | 8 |
| `neutral` | 8 |
| `frank` | 8 |
| `aggressive` | 8 |
| `hostile` | 8 |

## Format axes

| Axis | Count |
|---|---:|
| `long_text` | 5 |
| `short_text` | 5 |
| `list` | 5 |
| `code` | 5 |
| `allcaps` | 5 |
| `multilang` | 5 |
| `with_emojis` | 5 |
| `with_injection_attempt` | 5 |

## Joint actual-length × aggression × format

| # | id | actual length | intended length | aggression | format | turns |
|---:|---|---|---|---|---|---:|
| 1 | `scope_global_vs_user.polite.long_text.001` | len_3to5 | len_1 | polite | long_text | 4 |
| 2 | `scope_global_vs_user.neutral.short_text.002` | len_3to5 | len_2 | neutral | short_text | 4 |
| 3 | `scope_global_vs_user.frank.list.003` | len_3to5 | len_3to5 | frank | list | 4 |
| 4 | `scope_global_vs_user.aggressive.code.004` | len_6to8 | len_6to8 | aggressive | code | 7 |
| 5 | `scope_global_vs_user.hostile.allcaps.005` | len_9to12 | len_9to12 | hostile | allcaps | 10 |
| 6 | `scope_global_vs_user.polite.multilang.006` | len_13to16 | len_13to16 | polite | multilang | 15 |
| 7 | `scope_global_vs_user.neutral.with_emojis.007` | len_17to20 | len_17to20 | neutral | with_emojis | 20 |
| 8 | `scope_global_vs_user.frank.with_injection_attempt.008` | len_21to25 | len_21to25 | frank | with_injection_attempt | 24 |
| 9 | `scope_global_vs_user.aggressive.short_text.009` | len_3to5 | len_1 | aggressive | short_text | 4 |
| 10 | `scope_global_vs_user.hostile.list.010` | len_3to5 | len_2 | hostile | list | 4 |
| 11 | `scope_global_vs_user.polite.code.011` | len_3to5 | len_3to5 | polite | code | 5 |
| 12 | `scope_global_vs_user.neutral.allcaps.012` | len_6to8 | len_6to8 | neutral | allcaps | 6 |
| 13 | `scope_global_vs_user.frank.multilang.013` | len_9to12 | len_9to12 | frank | multilang | 10 |
| 14 | `scope_global_vs_user.aggressive.with_emojis.014` | len_13to16 | len_13to16 | aggressive | with_emojis | 15 |
| 15 | `scope_global_vs_user.hostile.with_injection_attempt.015` | len_17to20 | len_17to20 | hostile | with_injection_attempt | 20 |
| 16 | `scope_global_vs_user.polite.long_text.016` | len_21to25 | len_21to25 | polite | long_text | 22 |
| 17 | `scope_global_vs_user.neutral.list.017` | len_3to5 | len_1 | neutral | list | 4 |
| 18 | `scope_global_vs_user.frank.code.018` | len_3to5 | len_2 | frank | code | 4 |
| 19 | `scope_global_vs_user.aggressive.allcaps.019` | len_3to5 | len_3to5 | aggressive | allcaps | 4 |
| 20 | `scope_global_vs_user.hostile.multilang.020` | len_6to8 | len_6to8 | hostile | multilang | 8 |
| 21 | `scope_global_vs_user.polite.with_emojis.021` | len_9to12 | len_9to12 | polite | with_emojis | 10 |
| 22 | `scope_global_vs_user.neutral.with_injection_attempt.022` | len_13to16 | len_13to16 | neutral | with_injection_attempt | 15 |
| 23 | `scope_global_vs_user.frank.long_text.023` | len_17to20 | len_17to20 | frank | long_text | 20 |
| 24 | `scope_global_vs_user.aggressive.short_text.024` | len_21to25 | len_21to25 | aggressive | short_text | 25 |
| 25 | `scope_global_vs_user.hostile.code.025` | len_3to5 | len_1 | hostile | code | 4 |
| 26 | `scope_global_vs_user.polite.allcaps.026` | len_3to5 | len_2 | polite | allcaps | 4 |
| 27 | `scope_global_vs_user.neutral.multilang.027` | len_3to5 | len_3to5 | neutral | multilang | 4 |
| 28 | `scope_global_vs_user.frank.with_emojis.028` | len_6to8 | len_6to8 | frank | with_emojis | 7 |
| 29 | `scope_global_vs_user.aggressive.with_injection_attempt.029` | len_9to12 | len_9to12 | aggressive | with_injection_attempt | 10 |
| 30 | `scope_global_vs_user.hostile.long_text.030` | len_13to16 | len_13to16 | hostile | long_text | 15 |
| 31 | `scope_global_vs_user.polite.short_text.031` | len_17to20 | len_17to20 | polite | short_text | 20 |
| 32 | `scope_global_vs_user.neutral.list.032` | len_21to25 | len_21to25 | neutral | list | 23 |
| 33 | `scope_global_vs_user.frank.allcaps.033` | len_3to5 | len_1 | frank | allcaps | 4 |
| 34 | `scope_global_vs_user.aggressive.multilang.034` | len_3to5 | len_2 | aggressive | multilang | 4 |
| 35 | `scope_global_vs_user.hostile.with_emojis.035` | len_3to5 | len_3to5 | hostile | with_emojis | 5 |
| 36 | `scope_global_vs_user.polite.with_injection_attempt.036` | len_6to8 | len_6to8 | polite | with_injection_attempt | 6 |
| 37 | `scope_global_vs_user.neutral.long_text.037` | len_9to12 | len_9to12 | neutral | long_text | 10 |
| 38 | `scope_global_vs_user.frank.short_text.038` | len_13to16 | len_13to16 | frank | short_text | 15 |
| 39 | `scope_global_vs_user.aggressive.list.039` | len_17to20 | len_17to20 | aggressive | list | 20 |
| 40 | `scope_global_vs_user.hostile.code.040` | len_21to25 | len_21to25 | hostile | code | 21 |
