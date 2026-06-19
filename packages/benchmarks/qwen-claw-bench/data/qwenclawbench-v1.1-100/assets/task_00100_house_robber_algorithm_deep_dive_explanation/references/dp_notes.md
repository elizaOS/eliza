# Dynamic Programming Reference Notes

## Core Concepts

### 1. Overlapping Subproblems

A problem has **overlapping subproblems** when the same smaller subproblems are solved multiple times during a naive recursive approach. For example, computing `fib(5)` naively requires computing `fib(3)` twice and `fib(2)` three times.

Dynamic programming avoids this redundant work by storing results of subproblems.

### 2. Optimal Substructure

A problem exhibits **optimal substructure** if an optimal solution to the whole problem can be constructed from optimal solutions to its subproblems. This is what allows us to build up a solution incrementally.

---

## Two DP Approaches

### Top-Down (Memoization)

- Start from the original problem and recurse into subproblems.
- Cache (memoize) results in a hash map or array.
- Natural to implement; mirrors the recursive thinking.
- May have overhead from recursion stack.

```python
# Example: Fibonacci with memoization
def fib(n, memo={}):
    if n <= 1:
        return n
    if n not in memo:
        memo[n] = fib(n - 1, memo) + fib(n - 2, memo)
    return memo[n]
```

### Bottom-Up (Tabulation)

- Solve subproblems in order from smallest to largest.
- Fill a table (array) iteratively.
- No recursion overhead; often faster in practice.

```python
# Example: Fibonacci with tabulation
def fib(n):
    if n <= 1:
        return n
    dp = [0] * (n + 1)
    dp[1] = 1
    for i in range(2, n + 1):
        dp[i] = dp[i - 1] + dp[i - 2]
    return dp[n]
```

---

## Space Optimization

A critical optimization technique: **when `dp[i]` depends only on a constant number of previous states, you can reduce the space from O(n) to O(1).**

### Pattern: Rolling Variables

When `dp[i]` depends only on `dp[i-1]` and `dp[i-2]`, you do not need the entire array. Instead, maintain just two variables:

```python
def fib(n):
    if n <= 1:
        return n
    prev2, prev1 = 0, 1
    for i in range(2, n + 1):
        curr = prev1 + prev2
        prev2 = prev1
        prev1 = curr
    return prev1
```

This reduces space from **O(n)** to **O(1)**.

### Applying to House Robber

For the House Robber problem, define:

- `dp[i]` = the maximum amount of money that can be robbed from houses `0` through `i` (where house `i` may or may not be robbed).

The recurrence is:

```
dp[i] = max(dp[i-1], dp[i-2] + nums[i])
```

- `dp[i-1]`: skip house `i`, take the best from houses `0..i-1`
- `dp[i-2] + nums[i]`: rob house `i`, add its value to the best from houses `0..i-2`

Since `dp[i]` depends only on `dp[i-1]` and `dp[i-2]`, we can use two rolling variables and achieve **O(1) extra space**:

```python
def rob(nums):
    prev2, prev1 = 0, 0
    for num in nums:
        curr = max(prev1, prev2 + num)
        prev2 = prev1
        prev1 = curr
    return prev1
```

**Time complexity:** O(n)  
**Space complexity:** O(1)

---

## Common DP Problem Patterns

| Pattern | Example Problems |
|---------|-----------------|
| Linear sequence | Fibonacci, Climbing Stairs, House Robber |
| Grid/matrix | Unique Paths, Minimum Path Sum |
| String matching | Edit Distance, Longest Common Subsequence |
| Knapsack | 0/1 Knapsack, Coin Change |
| Interval | Matrix Chain Multiplication, Burst Balloons |
