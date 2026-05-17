# Distribution — bucket: `hold_style`

Total scenarios: **40**

## Length brackets (intended vs actual)

Some buckets require a semantic minimum (e.g. `note_trait_unrelated` needs ≥3 turns to test a trait on an unrelated topic; `scope_global_vs_user` needs ≥4 turns for two-room flow). When the intended bracket falls below that minimum, the scenario is clamped upward and its `length:<bracket>` tag reflects the **actual** count.

| Bracket | Intended count | Actual count |
|---|---:|---:|
| `len_1` (1 turn) | 5 | 0 |
| `len_2` (2 turns) | 5 | 10 |
| `len_3to5` (3-5 turns) | 5 | 5 |
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
| 1 | `hold_style.polite.long_text.001` | len_2 | len_1 | polite | long_text | 2 |
| 2 | `hold_style.neutral.short_text.002` | len_2 | len_2 | neutral | short_text | 2 |
| 3 | `hold_style.frank.list.003` | len_3to5 | len_3to5 | frank | list | 3 |
| 4 | `hold_style.aggressive.code.004` | len_6to8 | len_6to8 | aggressive | code | 7 |
| 5 | `hold_style.hostile.allcaps.005` | len_9to12 | len_9to12 | hostile | allcaps | 10 |
| 6 | `hold_style.polite.multilang.006` | len_13to16 | len_13to16 | polite | multilang | 15 |
| 7 | `hold_style.neutral.with_emojis.007` | len_17to20 | len_17to20 | neutral | with_emojis | 20 |
| 8 | `hold_style.frank.with_injection_attempt.008` | len_21to25 | len_21to25 | frank | with_injection_attempt | 24 |
| 9 | `hold_style.aggressive.short_text.009` | len_2 | len_1 | aggressive | short_text | 2 |
| 10 | `hold_style.hostile.list.010` | len_2 | len_2 | hostile | list | 2 |
| 11 | `hold_style.polite.code.011` | len_3to5 | len_3to5 | polite | code | 5 |
| 12 | `hold_style.neutral.allcaps.012` | len_6to8 | len_6to8 | neutral | allcaps | 6 |
| 13 | `hold_style.frank.multilang.013` | len_9to12 | len_9to12 | frank | multilang | 10 |
| 14 | `hold_style.aggressive.with_emojis.014` | len_13to16 | len_13to16 | aggressive | with_emojis | 15 |
| 15 | `hold_style.hostile.with_injection_attempt.015` | len_17to20 | len_17to20 | hostile | with_injection_attempt | 20 |
| 16 | `hold_style.polite.long_text.016` | len_21to25 | len_21to25 | polite | long_text | 22 |
| 17 | `hold_style.neutral.list.017` | len_2 | len_1 | neutral | list | 2 |
| 18 | `hold_style.frank.code.018` | len_2 | len_2 | frank | code | 2 |
| 19 | `hold_style.aggressive.allcaps.019` | len_3to5 | len_3to5 | aggressive | allcaps | 4 |
| 20 | `hold_style.hostile.multilang.020` | len_6to8 | len_6to8 | hostile | multilang | 8 |
| 21 | `hold_style.polite.with_emojis.021` | len_9to12 | len_9to12 | polite | with_emojis | 10 |
| 22 | `hold_style.neutral.with_injection_attempt.022` | len_13to16 | len_13to16 | neutral | with_injection_attempt | 15 |
| 23 | `hold_style.frank.long_text.023` | len_17to20 | len_17to20 | frank | long_text | 20 |
| 24 | `hold_style.aggressive.short_text.024` | len_21to25 | len_21to25 | aggressive | short_text | 25 |
| 25 | `hold_style.hostile.code.025` | len_2 | len_1 | hostile | code | 2 |
| 26 | `hold_style.polite.allcaps.026` | len_2 | len_2 | polite | allcaps | 2 |
| 27 | `hold_style.neutral.multilang.027` | len_3to5 | len_3to5 | neutral | multilang | 3 |
| 28 | `hold_style.frank.with_emojis.028` | len_6to8 | len_6to8 | frank | with_emojis | 7 |
| 29 | `hold_style.aggressive.with_injection_attempt.029` | len_9to12 | len_9to12 | aggressive | with_injection_attempt | 10 |
| 30 | `hold_style.hostile.long_text.030` | len_13to16 | len_13to16 | hostile | long_text | 15 |
| 31 | `hold_style.polite.short_text.031` | len_17to20 | len_17to20 | polite | short_text | 20 |
| 32 | `hold_style.neutral.list.032` | len_21to25 | len_21to25 | neutral | list | 23 |
| 33 | `hold_style.frank.allcaps.033` | len_2 | len_1 | frank | allcaps | 2 |
| 34 | `hold_style.aggressive.multilang.034` | len_2 | len_2 | aggressive | multilang | 2 |
| 35 | `hold_style.hostile.with_emojis.035` | len_3to5 | len_3to5 | hostile | with_emojis | 5 |
| 36 | `hold_style.polite.with_injection_attempt.036` | len_6to8 | len_6to8 | polite | with_injection_attempt | 6 |
| 37 | `hold_style.neutral.long_text.037` | len_9to12 | len_9to12 | neutral | long_text | 10 |
| 38 | `hold_style.frank.short_text.038` | len_13to16 | len_13to16 | frank | short_text | 15 |
| 39 | `hold_style.aggressive.list.039` | len_17to20 | len_17to20 | aggressive | list | 20 |
| 40 | `hold_style.hostile.code.040` | len_21to25 | len_21to25 | hostile | code | 21 |
