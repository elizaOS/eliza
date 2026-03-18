---
name: security-modern-python
description: "Write and review secure modern Python code following current best practices. Use when auditing Python applications for security issues, implementing secure patterns with modern Python features (3.10+), reviewing Python web frameworks, or hardening Python deployments."
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
---

# Secure Modern Python

## When to Use

- Reviewing Python code for security vulnerabilities
- Writing secure Python web applications (Flask, Django, FastAPI)
- Implementing secure patterns with modern Python (3.10+) features
- Hardening Python packaging and dependency management
- Auditing Python code handling user input, secrets, or cryptography

## When NOT to Use

- Python 2 legacy code (different security considerations)
- Non-Python security reviews
- Infrastructure security without Python components

## Common Vulnerability Patterns

### Injection
```python
# BAD: SQL injection
cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")

# GOOD: Parameterized query
cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))
```

### Command Injection
```python
# BAD: Shell injection
os.system(f"convert {filename} output.png")

# GOOD: Use subprocess with list args, no shell
subprocess.run(["convert", filename, "output.png"], check=True)
```

### Path Traversal
```python
# BAD: Unvalidated path
path = os.path.join(BASE_DIR, user_input)

# GOOD: Resolve and check containment
path = Path(BASE_DIR).joinpath(user_input).resolve()
if not str(path).startswith(str(Path(BASE_DIR).resolve())):
    raise ValueError("Path traversal detected")
```

### Deserialization
```python
# BAD: Arbitrary code execution via pickle
data = pickle.loads(user_data)

# GOOD: Use safe formats
data = json.loads(user_data)
```

### Secrets Management
```python
# BAD: Hardcoded secrets
API_KEY = "sk-abc123"

# GOOD: Environment variables or secret store
API_KEY = os.environ["API_KEY"]

# GOOD: Constant-time comparison for secrets
import hmac
hmac.compare_digest(provided_token, expected_token)
```

## Modern Python Security Features

| Feature | Version | Security Benefit |
|---------|---------|-----------------|
| `match` statements | 3.10+ | Safer input dispatching |
| Type hints + mypy | 3.5+ | Catch type confusion bugs |
| `tomllib` | 3.11+ | Safe TOML parsing (read-only) |
| `hashlib.file_digest` | 3.11+ | Correct file hashing |
| Stricter `int()` | 3.11+ | Rejects underscore tricks |

## Dependency Security

```bash
# Audit installed packages
pip-audit

# Pin dependencies
pip freeze > requirements.txt
pip install pip-tools && pip-compile --generate-hashes

# Check for known vulnerabilities
safety check -r requirements.txt
```

## Checklist

1. All user input is validated and sanitized
2. SQL uses parameterized queries
3. Subprocess calls avoid `shell=True`
4. No use of `eval()`, `exec()`, or `pickle` with untrusted data
5. Secrets loaded from environment or secret store
6. Dependencies pinned with hashes
7. HTTPS enforced for all external API calls
8. Logging does not include sensitive data
