# LLM API Provider Comparison

*Research notes — last updated 2024-01-08*

This document compares several LLM API providers we evaluated during the vendor selection phase. Included for reference only.

---

## Feature Comparison

| Feature                  | Provider A       | Provider B       | Provider C       | Provider D       |
|--------------------------|------------------|------------------|------------------|------------------|
| Pricing (input/1K tokens)| $0.008           | $0.012           | $0.006           | $0.010           |
| Pricing (output/1K tokens)| $0.012          | $0.016           | $0.008           | $0.015           |
| Max Context Length       | 8K tokens        | 32K tokens       | 16K tokens       | 8K tokens        |
| Streaming Support        | Yes              | Yes              | Yes              | Yes              |
| Languages Supported      | 50+              | 90+              | 30+              | 40+              |
| Fine-tuning Available    | Yes              | No               | Yes              | Yes              |
| SLA Uptime Guarantee     | 99.9%            | 99.95%           | 99.5%            | 99.9%            |
| Data Residency Options   | US, EU, Asia     | US, EU           | China only       | US, Asia         |
| Batch API                | Yes              | Yes              | No               | Yes              |
| Function Calling         | Yes              | Yes              | Limited          | No               |

## Latency Benchmarks (P50, measured 2024-01-05)

| Provider   | Token Generation (ms/token) | Time to First Token (ms) |
|------------|-----------------------------|--------------------------|
| Provider A | 35                          | 450                      |
| Provider B | 28                          | 380                      |
| Provider C | 42                          | 520                      |
| Provider D | 38                          | 490                      |

## Notes

- **Provider A** has the most mature SDK ecosystem but pricing is mid-range.
- **Provider B** offers the longest context window but lacks fine-tuning support.
- **Provider C** is the most cost-effective and meets our data residency requirements for the China market, which is a key factor.
- **Provider D** has competitive pricing but no function calling support, which limits advanced use cases.

## Recommendation

Based on data residency requirements and cost considerations, **Provider C** was selected for the initial integration. Provider B remains a strong candidate for international expansion.

---

*This comparison is for internal planning purposes only. Pricing and features are subject to change.*
