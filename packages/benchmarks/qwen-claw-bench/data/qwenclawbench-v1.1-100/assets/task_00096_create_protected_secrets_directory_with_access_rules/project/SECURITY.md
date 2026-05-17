# Security Policy

## Reporting Vulnerabilities

Please report security issues to security@example.com. Do not open public issues.

## Credential Management

- All secrets must be stored in environment variables or a secrets manager
- Never hardcode credentials in source code
- Rotate all API keys every 90 days
- Use least-privilege access for all service accounts

## Access Control

- Production credentials: Lead engineers only
- Staging credentials: All engineers
- Development: Use personal sandbox credentials

## Incident Response

1. Revoke compromised credentials immediately
2. Notify the security team within 1 hour
3. Audit access logs for unauthorized usage
4. Document the incident and root cause
5. Implement preventive measures
