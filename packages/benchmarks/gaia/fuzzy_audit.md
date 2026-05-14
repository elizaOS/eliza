# GAIA fuzzy-scorer false-positive audit

This audit compares the strict GAIA scorer (default after this change) against the previous fuzzy-enabled scorer. Rows marked 'DIVERGENT' are cases where the fuzzy scorer would have inflated the score by counting a wrong answer as correct.

Reference scorer (official): https://huggingface.co/spaces/gaia-benchmark/leaderboard/raw/main/scorer.py

| # | description | ground truth | prediction | strict | fuzzy | divergent? |
|---|---|---|---|---|---|---|
| 1 | substring: GT contained in slightly longer pred | `Margaret Hamilton` | `Margaret Hamilton.` | OK | OK |  |
| 2 | substring: extra short qualifier (>0.8 ratio) | `George Washington Carver` | `George Washington Carver.` | OK | OK |  |
| 3 | Levenshtein typo within 0.9 threshold | `Massachusetts` | `Massachussets` | X | X |  |
| 4 | Levenshtein single-char swap on medium word | `Schwarzenegger` | `Schwartzenegger` | X | OK | DIVERGENT |
| 5 | substring: trailing role suffix close in length | `Marie Curie scientist` | `Marie Curie scientists` | X | OK | DIVERGENT |
| 6 | misspelled name (short, below threshold) | `John Smith` | `Jon Smith` | X | X |  |
| 7 | verbose city answer (different) | `Paris` | `Paris, France` | X | X |  |
| 8 | scratch-work prefix on number | `42` | `approximately 42 cars` | OK | OK |  |
| 9 | substring containment (long pred) | `Mona Lisa` | `the Mona Lisa painting` | X | X |  |
| 10 | plural vs singular (short) | `cat` | `cats` | X | X |  |
| 11 | partial list | `red, blue, green` | `red and blue` | X | X |  |
| 12 | compound name | `New York City` | `New York` | X | X |  |
| 13 | correct exact answer (control) | `Paris` | `Paris` | OK | OK |  |
| 14 | correct numeric (control) | `42` | `42` | OK | OK |  |
| 15 | correct with prefix (control) | `42` | `The answer is 42` | OK | OK |  |

**Synthetic cases divergent: 2 / 15**

## HF validation split sample

Skipped (could not load HF split): `gated: GAIA dataset access denied (gated). Request access at https://huggingface.co/datasets/gaia-benchmark/GAIA and provide a token via HF_TOKEN or --hf-token.`
