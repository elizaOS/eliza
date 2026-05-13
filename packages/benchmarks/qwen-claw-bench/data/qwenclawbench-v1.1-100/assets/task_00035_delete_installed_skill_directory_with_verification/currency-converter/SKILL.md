---
name: currency-converter
description: "Convert between currencies using live exchange rates from open APIs. Use when: user asks to convert money between currencies. No API key needed."
homepage: https://open.er-api.com
metadata:
  openclaw:
    emoji: "💱"
    requires:
      bins: ["curl"]
---

# Currency Converter Skill

Convert between currencies using live exchange rates.

## When to Use

✅ **USE this skill when:**

- "How much is 100 USD in EUR?"
- "Convert 5000 CNY to JPY"
- "What's the exchange rate for GBP to USD?"

## Commands

### Convert

```bash
curl -s "https://open.er-api.com/v6/latest/USD" | python3 -c "
import sys, json
data = json.load(sys.stdin)
rate = data['rates']['EUR']
amount = 100
print(f'{amount} USD = {amount * rate:.2f} EUR')
"
```

### Get Rate

```bash
curl -s "https://open.er-api.com/v6/latest/CNY" | python3 -c "
import sys, json; data = json.load(sys.stdin); print(f'1 CNY = {data[\"rates\"][\"USD\"]:.4f} USD')
"
```

## Supported Currencies

All ISO 4217 codes: USD, EUR, GBP, CNY, JPY, KRW, HKD, TWD, SGD, AUD, CAD, CHF, etc.

## Notes

- Uses open.er-api.com (free, no key required)
- Rates update daily
- Not suitable for trading decisions (use live market feeds)
