# Difficulty Scaling Design Notes

**Project:** 极限生存挑战 (Extreme Survival Challenge)  
**Author:** Game Design Team  
**Last Updated:** 2024-03-12

---

## Overview

The game uses a **tiered difficulty scaling system** that dynamically adjusts enemy spawn rates based on the player's current score and remaining time. This creates a progressively challenging experience while preventing the game from becoming unplayable in the final moments.

---

## Difficulty Tiers

| Tier | Label   | Score Threshold | Time Condition | Spawn Interval | Enemies/sec |
|------|---------|----------------|----------------|----------------|-------------|
| 1    | Normal  | 0 (default)    | None           | 0.5s           | ~2.0        |
| 2    | Hard    | > 10           | None           | 0.4s           | ~2.5        |
| 3    | Extreme | > 20           | > 5 seconds    | 0.3s           | ~3.3        |

The tier with the most restrictive matching condition takes priority. Only one tier is active at any given moment.

---

## Why the Time > 5 Condition in Tier 3?

The `time > 5` condition in Tier 3 serves an important gameplay purpose:

1. **Prevents end-game overwhelm:** Without this condition, a player with a high score would face maximum spawn rates even in the last 5 seconds. Since the timer is counting down, this would create an unfair spike in difficulty right when the game is about to end.

2. **Rewards skilled play:** Players who reach high scores early in the game face the hardest challenge for longer, but get relief in the final seconds.

---

## Apple Spawning

Apple spawning is **independent** of the difficulty tier system:

| Item   | Spawn Interval | Scaling |
|--------|----------------|---------|
| Apple  | 1.0s           | None (constant) |

This ensures the player always has a consistent opportunity to score points regardless of difficulty level.

---

*End of Difficulty Scaling Notes*
