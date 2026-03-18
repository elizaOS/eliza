---
name: security-property-based-testing
description: "Apply property-based testing to find security vulnerabilities by generating adversarial inputs automatically. Use when writing property tests for security invariants, fuzz-testing parsers or validators, testing auth boundaries with generated inputs, or verifying cryptographic properties."
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
---

# Security Property-Based Testing

## When to Use

- Testing that security invariants hold across many generated inputs
- Fuzz-testing parsers, validators, and input handlers
- Verifying authentication/authorization boundaries
- Testing cryptographic implementations for correctness
- Finding edge cases in input validation logic

## When NOT to Use

- Testing specific known attack payloads (use unit tests)
- Load testing or performance testing
- UI testing or visual regression testing

## Core Concept

Property-based testing generates thousands of random inputs and verifies that security properties always hold:

```
For all inputs X: security_invariant(process(X)) == True
```

## Frameworks by Language

| Language | Framework | Install |
|----------|-----------|---------|
| Python | Hypothesis | `pip install hypothesis` |
| JavaScript/TS | fast-check | `npm install fast-check` |
| Rust | proptest | `cargo add proptest --dev` |
| Go | rapid | `go get pgregory.net/rapid` |
| Java | jqwik | Maven/Gradle dependency |

## Python (Hypothesis) Examples

### Input Validation
```python
from hypothesis import given, strategies as st

@given(st.text())
def test_sanitizer_removes_script_tags(input_str):
    """XSS property: output never contains <script>"""
    result = sanitize_html(input_str)
    assert "<script" not in result.lower()

@given(st.text())
def test_path_traversal_blocked(user_path):
    """Path traversal property: resolved path stays within base dir"""
    try:
        resolved = resolve_user_path(user_path)
        assert resolved.startswith(BASE_DIR)
    except ValidationError:
        pass  # Rejection is safe
```

### Auth Boundaries
```python
@given(st.sampled_from(["admin", "user", "guest"]),
       st.sampled_from(["/api/admin", "/api/user", "/api/public"]))
def test_auth_boundaries(role, endpoint):
    """Authorization property: guests cannot access admin endpoints"""
    response = make_request(role, endpoint)
    if endpoint.startswith("/api/admin") and role == "guest":
        assert response.status_code == 403
```

### Serialization Roundtrip
```python
@given(st.dictionaries(st.text(), st.text()))
def test_serialize_roundtrip_safe(data):
    """Serialization property: roundtrip preserves data without code execution"""
    serialized = safe_serialize(data)
    deserialized = safe_deserialize(serialized)
    assert deserialized == data
```

## JavaScript (fast-check) Examples

```javascript
const fc = require('fast-check');

test('SQL parameterization prevents injection', () => {
  fc.assert(fc.property(fc.string(), (userInput) => {
    const query = buildParameterizedQuery(userInput);
    // Property: query never contains unescaped user input directly
    expect(query.params).toContain(userInput);
    expect(query.sql).not.toContain(userInput);
  }));
});
```

## Security Properties to Test

| Property | Description |
|----------|-------------|
| No injection | Output never contains unescaped control characters |
| Path containment | File paths stay within allowed directory |
| Auth enforcement | Protected resources reject unauthorized access |
| Idempotent validation | Validating twice gives same result |
| No information leak | Error messages don't vary by secret values |
| Constant-time comparison | Comparison time doesn't depend on input |
| Roundtrip safety | Serialize/deserialize preserves data exactly |

## Best Practices

1. Start with the most security-critical invariants
2. Use custom strategies that generate attack-like inputs
3. Combine with coverage tracking to find untested paths
4. Save failing examples as regression unit tests
5. Run with high example counts in CI (at least 1000)
