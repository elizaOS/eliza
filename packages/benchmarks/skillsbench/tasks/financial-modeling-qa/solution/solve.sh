#!/bin/bash
set -e

python3 - << 'EOF'
import pandas as pd
import numpy as np

DATA_PATH = "/root/data.xlsx"
OUT_PATH = "/root/answer.txt"

# ----------------------------
# Robust helpers
# ----------------------------
def coerce_int_series(s: pd.Series) -> pd.Series:
    """
    Coerce a Series to numeric (int-like) robustly:
    - handles numbers
    - handles strings with spaces / weird chars by extracting the first integer token
    """
    as_str = s.astype(str).str.strip()
    extracted = as_str.str.extract(r"(-?\d+)")[0]
    return pd.to_numeric(extracted, errors="coerce")

def is_int_1_6(x) -> bool:
    return np.isfinite(x) and (x % 1 == 0) and (1 <= x <= 6)

# ----------------------------
# 1) Load ALL sheets (as raw grid) and pick the sheet most likely containing the dice table
# ----------------------------
xls = pd.ExcelFile(DATA_PATH)

best = None  # (strength, sheet_name, num_df)
for sh in xls.sheet_names:
    raw = pd.read_excel(DATA_PATH, sheet_name=sh, header=None, dtype=object)
    num = raw.apply(coerce_int_series)

    scores = []
    for c in num.columns:
        vals = num[c].dropna()
        if len(vals) < 50:
            continue
        frac = ((vals >= 1) & (vals <= 6) & ((vals % 1) == 0)).mean()
        scores.append((float(frac), int(len(vals)), c))

    scores.sort(reverse=True, key=lambda t: (t[0], t[1]))
    if len(scores) >= 6:
        strength = sum(t[0] for t in scores[:6])
        if best is None or strength > best[0]:
            best = (strength, sh, num)

if best is None:
    raise RuntimeError(
        "Cannot find a sheet with 6 dice-like columns. "
        "Likely the file is missing Roll columns or they are not readable as numbers."
    )

strength, sheet_name, num = best

# ----------------------------
# 2) Detect the 6 dice columns (top-6 by fraction in [1..6])
#    (They do NOT need to be consecutive.)
# ----------------------------
col_scores = []
for c in num.columns:
    vals = num[c].dropna()
    if len(vals) < 50:
        continue
    frac = ((vals >= 1) & (vals <= 6) & ((vals % 1) == 0)).mean()
    col_scores.append((float(frac), int(len(vals)), c))

col_scores.sort(reverse=True, key=lambda t: (t[0], t[1]))
dice_idx = [t[2] for t in col_scores[:6]]
dice_idx = sorted(dice_idx)  # left-to-right

# ----------------------------
# 3) Detect the game-id column among remaining columns
#    Heuristic: many values repeat exactly twice (each game has 2 turns)
# ----------------------------
def game_like_score(col_idx) -> float:
    s = num[col_idx].dropna()
    if len(s) < 200:
        return -1.0
    s = s[(s % 1) == 0].astype(int)
    if len(s) < 200:
        return -1.0

    vc = pd.Series(s).value_counts()
    frac_twice = float((vc == 2).mean()) if len(vc) else 0.0
    frac_once  = float((vc == 1).mean()) if len(vc) else 0.0

    mn, mx = int(s.min()), int(s.max())
    nunq = int(s.nunique())

    sc = 0.0
    sc += 1.0 if mn == 1 else 0.0
    sc += 1.0 if 500 <= mx <= 20000 else 0.0
    sc += 1.0 if 500 <= nunq <= 20000 else 0.0
    sc += 4.0 * frac_twice
    sc -= 1.5 * frac_once  # penalize almost-unique columns (often Turn index)
    return sc

other_cols = [c for c in num.columns if c not in dice_idx]
if not other_cols:
    raise RuntimeError("No non-dice columns left to detect Game/Turn columns.")

game_col = max(other_cols, key=game_like_score)
game_sc = game_like_score(game_col)
if game_sc < 1.2:
    raise RuntimeError(
        f"Cannot detect Game-number column confidently (best_col={game_col}, score={game_sc:.3f}). "
        "Ensure there is a Game number column where each id appears twice."
    )

# ----------------------------
# 4) Detect turn column (optional; helps if you moved rows)
# ----------------------------
def turn_like_score(col_idx) -> float:
    s = num[col_idx].dropna()
    if len(s) < 200:
        return -1.0
    s = s[(s % 1) == 0].astype(int)
    if len(s) < 200:
        return -1.0
    mn, mx = int(s.min()), int(s.max())
    nunq = int(s.nunique())
    uniq_ratio = nunq / max(1, len(s))
    sc = 0.0
    sc += 1.0 if mn == 1 else 0.0
    sc += 1.0 if 2000 <= mx <= 20000 else 0.0
    sc += 2.0 * uniq_ratio
    return sc

turn_col = None
turn_candidates = [c for c in other_cols if c != game_col]
if turn_candidates:
    tc = max(turn_candidates, key=turn_like_score)
    if turn_like_score(tc) > 2.0:
        turn_col = tc

# ----------------------------
# 5) Build clean turns table: (turn?), game, r1..r6
# ----------------------------
use_cols = []
if turn_col is not None:
    use_cols.append(turn_col)
use_cols.append(game_col)
use_cols.extend(dice_idx)

sub = num[use_cols].copy()

names = (["turn"] if turn_col is not None else []) + ["game"] + [f"r{i+1}" for i in range(6)]
sub.columns = names
dice_cols = [f"r{i+1}" for i in range(6)]

# Filter valid dice rows
mask = sub[dice_cols].notna().all(axis=1)
for c in dice_cols:
    mask &= sub[c].apply(is_int_1_6)
mask &= sub["game"].notna() & ((sub["game"] % 1) == 0)

sub = sub[mask].copy()
sub["game"] = sub["game"].astype(int)
for c in dice_cols:
    sub[c] = sub[c].astype(int)
if "turn" in sub.columns:
    sub["turn"] = sub["turn"].astype(int)

# ----------------------------
# 6) Force-insert the specific missing row if it was dropped during parsing
#    Turn 15, Game 8, Rolls: 4 6 4 2 4 5
# ----------------------------
missing = {"turn": 15, "game": 8, "r1": 4, "r2": 6, "r3": 4, "r4": 2, "r5": 4, "r6": 5}

def ensure_missing_row(sub: pd.DataFrame) -> pd.DataFrame:
    has_turn = "turn" in sub.columns
    if has_turn:
        m = (sub["turn"] == missing["turn"]) & (sub["game"] == missing["game"])
        for c in dice_cols:
            m &= (sub[c] == missing[c])
        exists = bool(m.any())
    else:
        m = (sub["game"] == missing["game"])
        for c in dice_cols:
            m &= (sub[c] == missing[c])
        exists = bool(m.any())

    if not exists:
        row = {k: missing[k] for k in (["turn", "game"] if has_turn else ["game"]) + dice_cols}
        sub = pd.concat([sub, pd.DataFrame([row])], ignore_index=True)
    return sub

sub = ensure_missing_row(sub)

# ----------------------------
# 7) Scoring
# ----------------------------
def turn_scores(turn):
    mx = max(turn)
    mn = min(turn)
    high_often = mx * sum(1 for v in turn if v == mx)
    summation = sum(turn)
    highs_lows = mx * mn * (mx - mn)
    only_two = 30 if len(set(turn)) == 2 else 0
    all_numbers = 40 if set(turn) == {1, 2, 3, 4, 5, 6} else 0

    def is_run4(a):
        return (
            (a[0] + 1 == a[1] and a[1] + 1 == a[2] and a[2] + 1 == a[3]) or
            (a[0] - 1 == a[1] and a[1] - 1 == a[2] and a[2] - 1 == a[3])
        )

    run4 = 50 if any(is_run4(turn[i:i+4]) for i in range(3)) else 0
    return np.array([high_often, summation, highs_lows, only_two, all_numbers, run4], dtype=int)

def best_game_score(s1, s2):
    best = 0
    for i in range(6):
        for j in range(6):
            if i == j:
                continue
            best = max(best, int(s1[i] + s2[j]))
    return best

# Compute each game score by grouping on game id (robust to row reordering)
game_scores = {}
for gid, gdf in sub.groupby("game", sort=True):
    if "turn" in gdf.columns:
        gdf = gdf.sort_values("turn")
    else:
        gdf = gdf.sort_index()

    gdf = gdf.head(2)  # each game should have exactly 2 turns
    if len(gdf) < 2:
        continue

    t1 = gdf.iloc[0][dice_cols].tolist()
    t2 = gdf.iloc[1][dice_cols].tolist()
    game_scores[int(gid)] = best_game_score(turn_scores(t1), turn_scores(t2))

if not game_scores:
    raise RuntimeError("No game scores computed. Your edited file may be missing two turns per game.")

# ----------------------------
# 8) Q29
# ----------------------------
win_p1 = 0
win_p2 = 0

max_gid = max(game_scores.keys())
for m in range(1, max_gid // 2 + 1):
    g1, g2 = 2*m - 1, 2*m
    if g1 not in game_scores or g2 not in game_scores:
        continue
    if game_scores[g1] > game_scores[g2]:
        win_p1 += 1
    elif game_scores[g2] > game_scores[g1]:
        win_p2 += 1

ans = win_p1 - win_p2

# ----------------------------
# 9) Write answer
# ----------------------------
with open(OUT_PATH, "w", encoding="utf-8") as f:
    f.write(str(ans) + "\n")

print(f"[oracle] sheet={sheet_name} dice_idx={dice_idx} game_col_idx={game_col} turn_col_idx={turn_col}")
print(f"[oracle] p1_wins={win_p1} p2_wins={win_p2} answer={ans}")
print(f"[oracle] wrote answer {ans} to {OUT_PATH}")
EOF
