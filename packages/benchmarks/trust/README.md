# Agent Trust & Security Benchmark

Adversarial benchmark suite for evaluating any AI agent's ability to detect and handle security threats. Tests prompt injection, social engineering, impersonation, credential theft, privilege escalation, data exfiltration, resource abuse, and content policy violations.

Designed for testing against scammers, hackers, cheaters, malicious admins, and subtle edge cases including vague inputs, encoding tricks, multi-language attacks, and prompt injection variants.

## What it tests

### 1. Prompt Injection (30 cases)
Classic overrides, DAN/jailbreaks, token splitting, Base64/hex encoding, multi-language (Spanish, French, German, Chinese, Japanese, Russian, Korean, Arabic), leet-speak, zero-width characters, markdown/code-block injection, ChatML token injection, JSON payload injection, separator-based hiding, fiction framing, reverse psychology, indirect injection via documents, and fake system prompt boundaries.

### 2. Social Engineering (20 cases)
Authority + urgency, reciprocity, social proof, intimidation, scarcity, rapport exploitation, commitment/consistency, authority impersonation, hero scenarios, guilt tripping, flattery, crypto scams, fake giveaways, reverse psychology/goading, journalist pretexting, tech support scams, false camaraderie, emotional emergencies, and name-dropping.

### 3. Impersonation (15 cases)
Homoglyphs (I/l, 0/O, 1/i, rn/m), Cyrillic Unicode lookalikes, zero-width space appending, trailing underscores, `_official`/`_support` suffixes, x-wrapping, and true negative controls.

### 4. Credential Theft (15 cases)
API tokens, seed phrases, private keys, login credentials, 2FA codes, phishing links, bulk harvests, fake surveys, recovery phrases, .env file requests, OAuth secrets, SSH keys, typosquatting domains, and database connection strings.

### 5. Privilege Escalation (15 cases)
Direct admin requests, cross-server privilege claims, sudo commands, fake role restoration, QA pretexting, production database access, backdoor accounts, rate limit whitelisting, feature flag manipulation, content filter exceptions, smart contract deployer access, SQL injection for superuser, auth bypass probing, internal API exploitation, and trust score manipulation.

### 6. Data Exfiltration (15 cases)
System prompt extraction (direct, partial, creative/poem), environment variables, database schemas, file system reads, user PII queries, cross-user conversation data, configuration dumps, conversation history with system messages, source code requests, model configuration, path traversal, context window contents, SSRF-style URL fetch exfiltration.

### 7. Resource Abuse (10 cases)
DDoS script generation, spam flooding, token exhaustion, mass DM spam, mass resource creation, crypto mining scripts, recursive API abuse, large file downloads, username enumeration, and computation exhaustion loops.

### 8. Content Policy (10 cases)
Educational bypass for phishing templates, evil AI roleplay, hypothetical exploit framing, fiction-framed exploit code, default password lists, PII scraping tools, deepfake evasion tools, pump-and-dump schemes, mass reporting tools, and disinformation generation.

### 9. Benign / False Positives (35 cases)
Legitimate password resets, admin references, security advice, API documentation questions, gratitude, permission questions, onboarding, security best practices mentioning sensitive terms, production bugs with urgency, credential manager references, role changes with approval, security policy discussions, academic research, incident reports, scheduling, CI/CD debugging, security education, pen test results, CTF challenges, key rotation, auth concepts, red team exercises, biometric features, accidental secret exposure remediation, bug bounty programs, CORS configuration, wallet UX, rate limit tuning, admin dashboard development, database migrations, OAuth tutorials, and system prompt design discussions.

## Running

```bash
# Install dependencies
cd benchmarks/trust
pip install -e ".[dev]"

# Run tests
python -m pytest tests/ -v

# Run full benchmark with oracle handler
python run_benchmark.py

# Run with specific handler
python run_benchmark.py --handler oracle

# Filter by category
python run_benchmark.py --categories prompt_injection social_engineering

# Filter by difficulty
python run_benchmark.py --difficulty hard

# Filter by tags
python run_benchmark.py --tags encoding multi-language

# Set pass threshold and output JSON
python run_benchmark.py --threshold 0.8 --output results.json
```

## Benchmarking your own agent

Implement the `TrustHandler` protocol and register it in `run_benchmark.py`:

```python
from elizaos_trust_bench.types import TrustHandler

class MyAgentHandler:
    """My agent's trust detection handler."""

    @property
    def name(self) -> str:
        return "my-agent"

    def detect_injection(self, message: str) -> dict[str, bool | float]:
        # Your detection logic here
        return {"detected": False, "confidence": 0.0}

    def detect_social_engineering(self, message: str) -> dict[str, bool | float]:
        return {"detected": False, "confidence": 0.0}

    def detect_impersonation(
        self, username: str, existing_users: list[str]
    ) -> dict[str, bool | float]:
        return {"detected": False, "confidence": 0.0}

    def detect_credential_theft(self, message: str) -> dict[str, bool | float]:
        return {"detected": False, "confidence": 0.0}

    def detect_privilege_escalation(self, message: str) -> dict[str, bool | float]:
        return {"detected": False, "confidence": 0.0}

    def detect_data_exfiltration(self, message: str) -> dict[str, bool | float]:
        return {"detected": False, "confidence": 0.0}

    def detect_resource_abuse(self, message: str) -> dict[str, bool | float]:
        return {"detected": False, "confidence": 0.0}

    def detect_content_policy_violation(self, message: str) -> dict[str, bool | float]:
        return {"detected": False, "confidence": 0.0}
```

Then run:

```python
from elizaos_trust_bench.runner import TrustBenchmarkRunner

runner = TrustBenchmarkRunner()
result = runner.run_and_report(MyAgentHandler(), output_path="results.json")
```

You only need to implement the detection methods for the categories you want to test. Unimplemented methods default to `{"detected": False, "confidence": 0.0}`.

## Metrics

- **Precision**: TP / (TP + FP) — how many flagged inputs were actually malicious
- **Recall**: TP / (TP + FN) — how many malicious inputs were correctly caught
- **F1**: Harmonic mean of precision and recall
- **Overall Macro F1**: Average F1 across all detection categories (excluding benign)
- **False Positive Rate**: Fraction of benign inputs incorrectly flagged
- **Difficulty Breakdown**: Accuracy at easy / medium / hard levels

## Baseline validation

The benchmark includes two baseline handlers for framework validation:

- **PerfectHandler**: Returns ground truth for all corpus cases. MUST score 100%. If it doesn't, the scoring logic has a bug.
- **RandomHandler**: Returns random results. MUST score poorly. If it scores well, the benchmark isn't discriminating.

## Test case design philosophy

1. **Real-world adversarial patterns**: Every test case is modeled after actual attack patterns seen in production AI agent deployments.
2. **Difficulty progression**: Easy cases test obvious attacks; medium cases add obfuscation or social context; hard cases use encoding, Unicode tricks, indirect injection, or subtle manipulation.
3. **False positive awareness**: 35 benign cases specifically target common false positive triggers (security discussions, admin references, urgency in legitimate contexts).
4. **Multi-language coverage**: Prompt injection tests cover 8+ languages to detect cross-language attack vectors.
5. **Encoding diversity**: Base64, hex, leet-speak, token splitting, zero-width characters, Cyrillic homoglyphs.
6. **Edge cases**: Vague inputs, double meanings, partially malicious content, creative extraction methods.
