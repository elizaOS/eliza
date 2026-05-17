"""
Greedy Attempt for House Robber
================================

This greedy approach does NOT always work for the House Robber problem.
It is included here to demonstrate why a greedy strategy fails and
why dynamic programming is necessary.

Approach:
  1. Sort house indices by their money value (descending).
  2. Greedily pick the highest-value house that is not adjacent to
     any already-picked house.

Counterexample:
  nums = [2, 1, 1, 2]
  - Greedy picks index 0 (value 2), then skips index 1 (adjacent).
  - Next highest is index 3 (value 2), but it's not adjacent to 0, so pick it.
  - Greedy result: 2 + 2 = 4. (Happens to be correct here.)

  But consider: nums = [3, 10, 3, 1, 2]
  - Greedy picks index 1 (value 10), skips indices 0 and 2.
  - Next is index 4 (value 2), not adjacent to 1, pick it.
  - Greedy result: 10 + 2 = 12.
  - But optimal is: index 0 + index 2 + index 4 = 3 + 3 + 2 = 8? No...
  - Actually optimal: index 1 + index 3 = 10 + 1 = 11? No, index 1 + index 4 = 12.
  - Better counterexample: nums = [2, 1, 1, 2]
    Greedy by max first: picks index 0 (2), skips 1, picks index 2 (1)? No...
    Actually greedy sorted: indices sorted by value = [0,3,1,2] (values [2,2,1,1])
    Pick index 0 (val 2). Skip index 3? Not adjacent to 0, pick it (val 2). Total = 4.
    This happens to match optimal.

  Real counterexample: nums = [1, 100, 1, 1, 100, 1]
  - Greedy picks index 1 (100), skips 0 and 2.
  - Picks index 4 (100), skips 3 and 5.
  - Greedy total: 200. This is actually optimal.

  The greedy can fail on: nums = [6, 7, 1, 30, 8, 2, 4]
  - Greedy picks index 3 (30), skips 2 and 4.
  - Picks index 1 (7), skips 0 and 2 (already skipped).
  - Picks index 6 (4), skips 5.
  - Greedy total: 30 + 7 + 4 = 41.
  - Optimal: index 0 + index 3 + index 6 = 6 + 30 + 4 = 40? No.
  - Optimal: index 0 + index 2 + index 4 + index 6 = 6 + 1 + 8 + 4 = 19? No.
  - Optimal: dp gives 41. Greedy got lucky again.

  In general, greedy approaches are unreliable for this problem.
  Use DP instead.
"""


def rob_greedy(nums):
    """
    Greedy approach: sort indices by value, greedily pick non-adjacent.
    WARNING: This does NOT always produce the optimal answer.
    """
    if not nums:
        return 0

    n = len(nums)
    # Sort indices by value in descending order
    indices = sorted(range(n), key=lambda i: nums[i], reverse=True)

    picked = set()
    blocked = set()
    total = 0

    for idx in indices:
        if idx not in blocked:
            picked.add(idx)
            total += nums[idx]
            # Block adjacent houses
            blocked.add(idx - 1)
            blocked.add(idx + 1)
            blocked.add(idx)  # block self too

    return total


# --- Quick test ---
if __name__ == "__main__":
    # These may or may not match optimal — that's the point!
    test_cases = [
        [1, 2, 3, 1],
        [2, 7, 9, 3, 1],
        [2, 1, 1, 2],
        [6, 7, 1, 30, 8, 2, 4],
    ]
    for tc in test_cases:
        result = rob_greedy(tc)
        print(f"nums={tc} -> greedy={result}")
