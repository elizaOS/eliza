# 213. House Robber II

## Problem Statement

You are a professional robber planning to rob houses along a street. Each house has a certain amount of money stashed. All houses at this place are **arranged in a circle**. That means the first house is the neighbor of the last one. Meanwhile, adjacent houses have security systems connected, and **if two adjacent houses are broken into on the same night, the police will be automatically contacted**.

Given an integer array `nums` representing the amount of money of each house, return *the maximum amount of money you can rob tonight **without alerting the police***.

> **Key Difference from House Robber I:** Because the houses form a circle, house `0` and house `n-1` are considered adjacent. You cannot rob both the first and last house.

---

## Examples

### Example 1

```
Input: nums = [2,3,2]
Output: 3
Explanation: You cannot rob house 0 (money = 2) and house 2 (money = 2),
             because they are adjacent in the circle.
             The best strategy is to rob house 1 (money = 3).
```

### Example 2

```
Input: nums = [1,2,3,1]
Output: 4
Explanation: Rob house 0 (money = 1) and then rob house 2 (money = 3).
             Total amount = 1 + 3 = 4.
```

### Example 3

```
Input: nums = [1,2,3]
Output: 3
Explanation: Rob house 2 (money = 3). You cannot rob house 0 and house 2
             together since they are adjacent in the circular arrangement.
```

---

## Constraints

- `1 <= nums.length <= 100`
- `0 <= nums[i] <= 1000`

---

## Approach Hint

Since house `0` and house `n-1` are now neighbors, you can break the problem into two subproblems:

1. Solve House Robber I on `nums[0..n-2]` (exclude the last house)
2. Solve House Robber I on `nums[1..n-1]` (exclude the first house)

Return the maximum of the two results. Handle the edge case where `n == 1` separately.
