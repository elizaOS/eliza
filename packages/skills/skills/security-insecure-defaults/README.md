# Insecure Defaults Detection

Security skill for detecting insecure default configurations that create vulnerabilities when applications run with missing or incomplete configuration.

## Overview

The `insecure-defaults` skill helps identify security vulnerabilities caused by:

- **Hardcoded fallback secrets** (JWT keys, API keys, session secrets)
- **Default credentials** (admin/admin, root/password)
- **Weak cryptographic defaults** (MD5, DES, ECB mode)
- **Permissive access control** (CORS *, public by default)
- **Missing security configuration** that causes fail-open behavior

**Critical Distinction:** This skill emphasizes **fail-secure vs. fail-open** behavior. Applications that crash without proper configuration are safe; applications that run with insecure defaults are vulnerable.

## Installation

```bash
cd parent-folder/skills
/plugin install ./plugins/insecure-defaults
```

Or from the plugin marketplace:
```bash
/plugin install insecure-defaults
```

## When to Use

Use this skill when:

- **Security auditing** production applications or services
- **Configuration review** of deployment manifests (Docker, Kubernetes, IaC)
- **Pre-production checks** before deploying new services
- **Code review** of authentication, authorization, or cryptographic code
- **Environment variable handling** analysis for secrets management
- **API security review** checking CORS, rate limiting, authentication
- **Third-party integration** review for hardcoded test credentials

## Usage

```
Audit this codebase for insecure defaults—focus on environment variable fallbacks and authentication configuration
```
