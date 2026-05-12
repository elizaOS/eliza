"""
Recursive Solution with Memoization — House Robber (LeetCode 198)
==================================================================

A correct but less efficient solution using top-down DP (memoization).

Approach:
  Define dfs(i) = maximum money that can be robbed starting from house i
  to the end of the array.

  Base case:
    if i >= len(nums): return 0  (no more houses)

  Recurrence:
    dfs(i) = max(
        nums[i] + dfs(i + 2),   # rob house i, skip house i+1
        dfs(i + 1)               # skip house i, move to house i+1
    )

  Answer: dfs(0)

Complexity:
  Time:  O(n) — each subproblem dfs(0), dfs(1), ..., dfs(n-1) is solved once
  Space: O(n) — for the memoization cache and the recursion call stack
"""

from functools import lru_cache
from typing import List


def rob(nums: List[int]) -> int:
    """
    Return the maximum amount of money that can be robbed without
    robbing two adjacent houses.

    Uses recursion with memoization (top-down DP).

    :param nums: List of non-negative integers representing money at each house.
    :return: Maximum money that can be robbed.
    """
    n = len(nums)

    @lru_cache(maxsize=None)
    def dfs(i: int) -> int:
        """Return the max money obtainable from houses i..n-1."""
        if i >= n:
            return 0
        # Option 1: rob house i, then skip to i+2
        # Option 2: skip house i, consider from i+1
        return max(nums[i] + dfs(i + 2), dfs(i + 1))

    return dfs(0)


# --- Verification against known test cases ---
if __name__ == "__main__":
    test_cases = [
        ([1, 2, 3, 1], 4),
        ([2, 7, 9, 3, 1], 12),
        ([0], 0),
        ([5], 5),
        ([2, 1], 2),
        ([1, 2], 2),
        ([1, 2, 3], 4),
        ([2, 1, 1, 2], 4),
        ([1, 3, 1, 3, 100], 103),
        ([0, 0, 0, 0, 0], 0),
    ]

    all_passed = True
    for nums, expected in test_cases:
        result = rob(nums)
        status = "PASS" if result == expected else "FAIL"
        if status == "FAIL":
            all_passed = False
        print(f"{status}: rob({nums}) = {result} (expected {expected})")

    print()
    if all_passed:
        print("All test cases passed!")
    else:
        print("Some test cases FAILED.")
