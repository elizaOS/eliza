# Edge Cases Notes — House Robber

When implementing and testing the House Robber solution, consider the following edge cases:

## 1. Single House (`nums.length == 1`)

- Input: `[5]`
- Expected output: `5`
- Simply return `nums[0]`. There's only one house, so rob it.

## 2. Two Houses (`nums.length == 2`)

- Input: `[2, 1]` → output `2`
- Input: `[1, 2]` → output `2`
- Return `max(nums[0], nums[1])`. You can only rob one of the two since they are adjacent.

## 3. All Zeros

- Input: `[0, 0, 0, 0, 0]`
- Expected output: `0`
- The algorithm should handle this gracefully and return 0.

## 4. All Same Values

- Input: `[3, 3, 3, 3]`
- Expected output: `6` (rob house 0 and house 2, or house 1 and house 3)
- Ensures the algorithm doesn't have bias toward any particular index.

## 5. Strictly Increasing

- Input: `[1, 2, 3, 4, 5]`
- Expected output: `9` (rob houses 0, 2, 4 → 1+3+5)
- Tests that the algorithm correctly handles ascending sequences.

## 6. Strictly Decreasing

- Input: `[5, 4, 3, 2, 1]`
- Expected output: `9` (rob houses 0, 2, 4 → 5+3+1)
- Mirror of the increasing case.

## 7. Large Single Value

- Input: `[1, 1, 400, 1, 1]`
- Expected output: `402` (rob houses 0, 2, 4 → 1+400+1)
- Tests that a dominant value in the middle is correctly included.

## Note on Empty Array

The problem constraints specify `1 <= nums.length <= 100`, so an empty array is **not** a valid input. No need to handle `nums = []` as a special case, though adding a guard clause doesn't hurt.
