# 198. House Robber

## Problem Statement

You are a professional robber planning to rob houses along a street. Each house has a certain amount of money stashed. The only constraint stopping you from robbing each of them is that **adjacent houses have security systems connected** — if two adjacent houses are broken into on the same night, the police will be automatically contacted.

Given an integer array `nums` where `nums[i]` represents the amount of money the *i-th* house has, return *the maximum amount of money you can rob tonight **without alerting the police***.

---

## Examples

### Example 1

```
Input: nums = [1,2,3,1]
Output: 4
Explanation: Rob house 0 (money = 1) and then rob house 2 (money = 3).
             Total amount = 1 + 3 = 4.
```

### Example 2

```
Input: nums = [2,7,9,3,1]
Output: 12
Explanation: Rob house 0 (money = 2), rob house 2 (money = 9), and rob house 4 (money = 1).
             Total amount = 2 + 9 + 1 = 12.
```

---

## Constraints

- `1 <= nums.length <= 100`
- `0 <= nums[i] <= 400`
