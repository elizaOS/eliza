# Psychometric Standards for Test Development
## Reference Document — Classical Test Theory Framework

**Source:** Adapted from APA Standards for Educational and Psychological Testing  
**Version:** 2024 Reference Edition

---

### 1. Classical Test Theory (CTT) Overview

Classical Test Theory posits that an observed test score (X) is composed of a true score (T) and measurement error (E): X = T + E. The reliability of a test is defined as the ratio of true score variance to observed score variance. For high-stakes assessments, reliability coefficients should exceed 0.90, while for research purposes, values above 0.70 are generally acceptable.

### 2. Reliability Standards

**Cronbach's Alpha** is the most widely used measure of internal consistency. The following thresholds are recommended:

| Alpha Range | Interpretation |
|-------------|---------------|
| ≥ 0.90 | Excellent — suitable for high-stakes individual decisions |
| 0.80 – 0.89 | Good — suitable for group comparisons and research |
| 0.70 – 0.79 | Acceptable — adequate for exploratory research |
| 0.60 – 0.69 | Questionable — use with caution |
| < 0.60 | Poor — not recommended for any purpose |

**Test-Retest Reliability** should be assessed with a minimum interval of 2 weeks and maximum of 4 weeks. Correlation coefficients below 0.70 suggest instability in the construct being measured.

### 3. Item Analysis Standards

**Item-Total Correlation:** Each item should correlate at least r = 0.20 with the total test score (after removing the item). Items with correlations below 0.15 should be flagged for review or removal. Optimal item-total correlations fall between 0.30 and 0.70.

**Item Difficulty (p-value):** For maximum discrimination, items should have difficulty values between 0.30 and 0.70. Items with p > 0.90 (too easy) or p < 0.10 (too hard) contribute minimal information and should be revised.

**Distractor Analysis:** For multiple-choice items, each distractor should attract at least 5% of respondents. Non-functioning distractors reduce the effective number of options and inflate guessing parameters.

### 4. Sample Size Requirements

Reliable item parameter estimation requires adequate sample sizes:

- **Classical item statistics:** Minimum N = 100 per item; recommended N = 200+
- **IRT 1-parameter (Rasch):** Minimum N = 100; recommended N = 200
- **IRT 2-parameter:** Minimum N = 250; recommended N = 500
- **IRT 3-parameter:** Minimum N = 500; recommended N = 1000
- **Factor analysis for dimensionality:** Minimum N = 300; recommended 10:1 ratio of respondents to items

These sample sizes assume human test-takers with independent responses. The applicability to language model evaluation, where a single model produces deterministic or near-deterministic responses, requires careful consideration. Traditional sampling theory may not directly apply when the "respondent" is a fixed computational system rather than a sample from a population.

### 5. Validity Evidence

Five sources of validity evidence should be considered:

1. **Content validity:** Expert review of item-construct alignment
2. **Response process validity:** Think-aloud protocols or attention checks
3. **Internal structure:** Factor analysis confirming dimensionality
4. **Relations to other variables:** Convergent and discriminant validity
5. **Consequences:** Impact of score use on stakeholders

### 6. Standard Error of Measurement

The SEM provides a confidence band around individual scores: SEM = SD × √(1 - reliability). For a test with SD = 15 and reliability = 0.90, SEM = 4.74, yielding a 95% confidence interval of approximately ±9.3 points.

### 7. Fairness and Bias

Differential Item Functioning (DIF) analysis should be conducted across relevant subgroups. Items showing significant DIF (effect size > 0.25) should be reviewed for potential bias. In the context of LLM evaluation, DIF analysis across model families may reveal items that unfairly advantage specific architectures.

---

*Note: These standards were developed primarily for human educational and psychological testing. Adaptation for automated system evaluation requires methodological consideration of the fundamental differences between human respondent populations and deterministic computational systems.*
