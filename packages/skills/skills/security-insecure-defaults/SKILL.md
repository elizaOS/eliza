---
name: security-insecure-defaults
description: "Identify and fix insecure default configurations in applications, frameworks, and infrastructure. Use when auditing default settings, reviewing configuration files, checking for overly permissive defaults, or hardening deployments against configuration-based attacks."
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
---

# Insecure Defaults Detection

## When to Use

- Auditing application or framework default configurations
- Reviewing deployment configs (Docker, Kubernetes, cloud)
- Checking for debug modes, default credentials, or open endpoints in production
- Hardening new service deployments
- Reviewing infrastructure-as-code for permissive defaults

## When NOT to Use

- Runtime vulnerability scanning (use DAST tools)
- Source code logic bugs (use static analysis)
- Network-level security testing

## Common Insecure Defaults by Category

### Web Frameworks
| Default | Risk | Fix |
|---------|------|-----|
| `DEBUG=True` | Stack traces leak internals | Ensure `DEBUG=False` in production |
| Default `SECRET_KEY` | Session forgery, CSRF bypass | Generate cryptographically random key |
| CORS `Allow-Origin: *` | Cross-origin data theft | Restrict to known origins |
| No CSRF protection | State-changing request forgery | Enable CSRF middleware |
| Verbose error pages | Information disclosure | Use generic error pages in production |

### Databases
| Default | Risk | Fix |
|---------|------|-----|
| No authentication | Unauthorized access | Enable auth; set strong passwords |
| Bind to `0.0.0.0` | Network exposure | Bind to `127.0.0.1` or Unix socket |
| Default ports | Easy discovery | Use non-standard ports (defense in depth) |
| No encryption at rest | Data exposure if disk stolen | Enable encryption |

### Cloud / Infrastructure
| Default | Risk | Fix |
|---------|------|-----|
| Public S3 buckets | Data leak | Block public access at account level |
| Default VPC security groups | Overly permissive ingress | Least-privilege security groups |
| IMDSv1 enabled | SSRF to credential theft | Require IMDSv2 |
| No log retention | Forensic blind spots | Enable CloudTrail/audit logging |

## Detection Approach

```bash
# Search for common insecure defaults
grep -rn "DEBUG.*=.*True\|debug.*=.*true" --include="*.py" --include="*.yaml" .
grep -rn "SECRET_KEY.*=.*['\"]\(changeme\|secret\|default\)" .
grep -rn "0\.0\.0\.0\|ALLOW_ALL\|AllowAny\|\*\.\*\.\*\.\*" .
grep -rn "password.*=.*['\"]\(admin\|root\|password\|123\)" .
```

## Hardening Workflow

1. Inventory all configuration files and environment variables
2. Compare against framework security documentation
3. Check for debug/development settings in production configs
4. Verify secrets are externalized (not hardcoded)
5. Validate network binding and access control settings
6. Review cloud IAM policies for overly broad permissions
7. Document deviations from secure defaults with justification
