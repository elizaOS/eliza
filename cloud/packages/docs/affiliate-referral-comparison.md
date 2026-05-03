# Affiliate vs referral — quick comparison

Use this table when documenting, debugging payouts, or designing UI copy. Full detail and APIs: [referrals.md](./referrals.md).

| | **Referral** | **Affiliate** |
|---|-------------|---------------|
| **Primary goal** | Attribute signups and share **purchase revenue** (50/40/10) plus signup/qualified **bonuses** | Charge a **markup** on specific usage; affiliate earns the markup |
| **Typical share URL** | `/login?ref=CODE` (also `referral_code=`) | `/login?affiliate=CODE` |
| **Apply / link API** | `POST /api/v1/referrals/apply` | `POST /api/v1/affiliates/link` (and header `X-Affiliate-Code` on API calls) |
| **“My code / link” API** | `GET /api/v1/referrals` (flat JSON: `code`, `total_referrals`, `is_active`) | `GET` / `POST` / `PUT` `/api/v1/affiliates` |
| **Revenue source** | Stripe checkout + x402 purchases (splits) | Auto top-up + MCP (markup) |
| **Double-dip** | **No** — same transaction does not run referral splits and affiliate markup | Same rule |

**Why two programs:** Referral economics are baked into **purchase price distribution** (must sum to 100%). Affiliate economics are **optional markup** on certain flows so cost is visible to the end customer and we never over-allocate platform revenue.
