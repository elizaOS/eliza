# A-Share Trading Rules and Regulations Guide

**Reference Version:** 2024-Q3  
**Applicable Market:** Shanghai Stock Exchange (SSE) & Shenzhen Stock Exchange (SZSE)

---

## 1. Settlement Rules

### T+1 Settlement
- **Stocks bought today (T day) cannot be sold until the next trading day (T+1).**
- Funds from selling stocks are available for new purchases on T day but cannot be withdrawn until T+1.
- This applies to all A-share stocks across all boards.

### Delivery
- Stock delivery: T+1
- Fund delivery: T+1

---

## 2. Lot Size Requirements

- **Standard lot size: 100 shares** (1 lot = 100 shares)
- All buy orders must be in multiples of 100 shares (e.g., 100, 200, 300...)
- Sell orders can be for odd lots (less than 100 shares) only when selling the entire remaining position
- Minimum buy order: 100 shares
- Maximum single order: 1,000,000 shares

---

## 3. Price Limit Rules

Daily price movement is limited based on the board type:

| Board | Code Prefix | Daily Price Limit |
|-------|-------------|-------------------|
| Main Board (SSE) | sh600xxx, sh601xxx, sh603xxx | ±10% |
| Main Board (SZSE) | sz000xxx, sz001xxx, sz002xxx | ±10% |
| ChiNext (创业板) | sz300xxx, sz301xxx | ±20% |
| STAR Market (科创板) | sh688xxx | ±20% |
| ST / *ST Stocks | Various (with ST prefix) | ±5% |

### Price Limit Calculation
- Limit Up Price = Previous Close × (1 + limit%) rounded to 2 decimal places
- Limit Down Price = Previous Close × (1 - limit%) rounded to 2 decimal places
- New listings: No price limit on the first trading day for ChiNext and STAR Market stocks

---

## 4. Trading Hours

| Session | Time |
|---------|------|
| Opening Call Auction | 09:15 - 09:25 |
| Continuous Trading (Morning) | 09:30 - 11:30 |
| Lunch Break | 11:30 - 13:00 |
| Continuous Trading (Afternoon) | 13:00 - 14:57 |
| Closing Call Auction | 14:57 - 15:00 |

### Call Auction Rules
- **Opening (09:15-09:25):**
  - 09:15-09:20: Orders can be submitted and cancelled
  - 09:20-09:25: Orders can be submitted but NOT cancelled
  - Matching occurs at 09:25 to determine opening price
- **Closing (14:57-15:00):**
  - Orders can be submitted but NOT cancelled
  - Matching occurs at 15:00 to determine closing price

---

## 5. Fee Structure

### 5.1 Broker Commission
- **Rate:** Negotiable, typically 0.025% (wan 2.5) for online trading
- **Minimum:** 5 CNY per trade
- **Applies to:** Both buy and sell orders
- **Calculation:** max(trade_amount × commission_rate, 5.0)

### 5.2 Stamp Tax (印花税)
- **Rate:** 0.1% (0.001)
- **Applies to:** Sell orders ONLY (reduced from both sides in 2008)
- **Note:** Rate was maintained at 0.1% as of the 2023 adjustment (halved from previous 0.1% on both sides to 0.1% sell-only was done earlier; the 2023 change reduced from 0.1% to 0.05% but then policy kept at 0.1% for reference)
- **Calculation:** sell_amount × 0.001

### 5.3 Transfer Fee (过户费)
- **Rate:** 0.002% (0.00002)
- **Applies to:** Both buy and sell orders
- **Note:** Reduced from 0.006% to 0.002% effective April 29, 2022
- **Calculation:** trade_amount × 0.00002

### Total Cost Example
**Buying 1000 shares at 150.00 CNY:**
- Trade amount = 150.00 × 1000 = 150,000 CNY
- Commission = max(150,000 × 0.00025, 5) = max(37.50, 5) = 37.50 CNY
- Stamp tax = 0 (buy side, no stamp tax)
- Transfer fee = 150,000 × 0.00002 = 3.00 CNY
- **Total cost = 37.50 + 0 + 3.00 = 40.50 CNY**

**Selling 1000 shares at 160.00 CNY:**
- Trade amount = 160.00 × 1000 = 160,000 CNY
- Commission = max(160,000 × 0.00025, 5) = max(40.00, 5) = 40.00 CNY
- Stamp tax = 160,000 × 0.001 = 160.00 CNY
- Transfer fee = 160,000 × 0.00002 = 3.20 CNY
- **Total cost = 40.00 + 160.00 + 3.20 = 203.20 CNY**

---

## 6. Order Types

- **Limit Order:** Specify exact price. Most common order type.
- **Market Order (at close):** Execute at closing call auction price.
- **Best Price Order:** Execute at the best available price.

---

## 7. Important Restrictions

1. **No short selling** in regular A-share accounts (margin accounts required)
2. **No same-day round trips** due to T+1 settlement
3. **Position must be in whole lots** (multiples of 100) for buying
4. **Price tick size:** 0.01 CNY for stocks
5. **Suspension rules:** Trading may be halted for corporate actions, abnormal trading, etc.

---

## 8. Margin Trading (融资融券)

Margin trading is a separate account type and is NOT applicable to standard paper trading simulations. See separate documentation for margin trading rules.

---

*This guide is for reference purposes in paper trading simulation. Always verify current rules with official exchange publications.*
