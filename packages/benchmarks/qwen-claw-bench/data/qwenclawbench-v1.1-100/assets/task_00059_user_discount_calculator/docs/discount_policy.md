# Discount Policy — Internal Reference

## Overview

User discounts are calculated based on a combination of membership tier, loyalty duration, and cumulative spending. The system stacks applicable bonuses up to a configured maximum cap.

## Tier-Based Discounts

| Tier     | Base Discount | Min Orders Required |
|----------|--------------|---------------------|
| Bronze   | 0%           | 0                   |
| Silver   | 5%           | 5                   |
| Gold     | 10%          | 20                  |
| Platinum | 15%          | 50                  |

## Loyalty Bonus

Users who have been members for **2+ years** receive an additional **3%** discount on top of their tier discount.

## Spending Bonus

| Cumulative Spend | Additional Discount |
|-----------------|---------------------|
| $1,000+         | +2%                 |
| $3,000+         | +5%                 |

Note: Spending bonuses do not stack. The highest qualifying threshold applies.

## Cap

Maximum combined discount is **25%**, regardless of stacked bonuses.

## Eligibility

- Only **active** users are eligible for discounts.
- Inactive users receive 0% discount regardless of tier or history.

## Change Log

- 2025-06-01: Raised max cap from 20% to 25%. Added $3,000 spending tier.
- 2024-11-15: Introduced loyalty bonus (2-year threshold).
- 2024-01-01: Initial policy with tier-based discounts only.
