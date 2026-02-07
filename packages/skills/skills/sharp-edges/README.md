# Sharp Edges

Identifies error-prone APIs, dangerous configurations, and footgun designs that enable security mistakes through developer confusion, laziness, or malice.

## When to Use

- Reviewing API designs for security-relevant interfaces
- Auditing configuration schemas that expose security choices
- Evaluating cryptographic library ergonomics
- Assessing authentication/authorization APIs
- Any code review where developers make security-critical decisions

## What It Does

Analyzes code and designs through the lens of three adversaries:

1. **The Scoundrel**: Can a malicious developer or attacker disable security via configuration?
2. **The Lazy Developer**: Will copy-pasting the first example lead to insecure code?
3. **The Confused Developer**: Can parameters be swapped without type errors?

## Core Principle

**The pit of success**: Secure usage should be the path of least resistance. If developers must read documentation carefully or remember special rules to avoid vulnerabilities, the API has failed.

## Installation

```
/plugin install trailofbits/skills/plugins/sharp-edges
```

## Sharp Edge Categories

The skill identifies six categories of misuse-prone designs:

| Category | Example |
|----------|---------|
| Algorithm Selection | JWT `alg: none` attack; PHP `hash("crc32", $password)` |
| Dangerous Defaults | `session_timeout: 0` meaning infinite; empty password accepted |
| Primitive vs. Semantic APIs | `encrypt(msg, bytes, bytes)` where key/nonce can be swapped |
| Configuration Cliffs | `verify_ssl: false` disables all certificate validation |
| Silent Failures | Verification returns `False` instead of throwing; ignored return values |
| Stringly-Typed Security | Permissions as comma-separated strings; SQL from concatenation |

## Related Skills

- [constant-time-analysis](../constant-time-analysis) - Detect timing side-channels in cryptographic code
- [differential-review](../differential-review) - Security-focused code change review
- [audit-context-building](../audit-context-building) - Deep architectural analysis before auditing
