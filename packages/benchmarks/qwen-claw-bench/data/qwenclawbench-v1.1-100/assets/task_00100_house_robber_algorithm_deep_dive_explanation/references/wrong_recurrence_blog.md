# House Robber DP Approach

*Posted by AlgoExpert42 — Last updated March 2024*

## Overview

The House Robber problem (LeetCode 198) is a classic dynamic programming problem. In this post, I'll walk through the DP formulation step by step.

## Defining the Subproblem

Let's define our DP state carefully:

> **`dp[i]`** = the maximum money we can collect from houses `0..i`, given that **house `i` IS robbed**.

This definition is intuitive — we track the best outcome when we commit to robbing the current house.

## Building the Recurrence

With this definition, the recurrence relation is:

```
dp[i] = max(dp[i-1], dp[i-2] + nums[i-1])
```

Here's the reasoning:
- We look at `dp[i-1]` and `dp[i-2] + nums[i-1]` and take the maximum.
- `dp[i-2] + nums[i-1]` accounts for the constraint that we can't rob two adjacent houses.
- We use `nums[i-1]` because our dp array is 1-indexed for convenience (with `dp[0] = 0` as a base case).

## Base Cases

```
dp[0] = 0          # no houses to rob
dp[1] = nums[0]    # only one house, rob it
```

## Implementation

```python
def rob(nums):
    n = len(nums)
    if n == 0:
        return 0
    if n == 1:
        return nums[0]
    
    dp = [0] * (n + 1)
    dp[0] = 0
    dp[1] = nums[0]
    
    for i in range(2, n + 1):
        dp[i] = max(dp[i-1], dp[i-2] + nums[i-1])
    
    return dp[n]
```

## Walkthrough: nums = [1, 2, 3, 1]

| i | dp[i] | Explanation |
|---|-------|-------------|
| 0 | 0     | Base case |
| 1 | 1     | Rob house 0 |
| 2 | 2     | max(1, 0+2) = 2 |
| 3 | 4     | max(2, 1+3) = 4 |
| 4 | 4     | max(4, 2+1) = 4 |

Result: `dp[4] = 4` ✓

## Complexity

- **Time:** O(n) — single pass through the array
- **Space:** O(n) — for the dp array (can be optimized)

## Key Takeaway

The key insight is defining `dp[i]` as the maximum money when house `i` is robbed, and then using the recurrence to ensure no two adjacent houses are selected. This is a textbook example of how careful state definition leads to an elegant DP solution.

---

*If you found this helpful, check out my other posts on DP patterns!*
