# Security Notes

## Known Transitive Vulnerabilities

The following vulnerabilities exist in transitive dependencies and are mitigated as noted:

### axios (via twilio)
- **CVE**: GHSA-jr5f-v2jv-69x6, GHSA-4hjh-wcwx-xvwj
- **Severity**: High
- **Impact**: SSRF, DoS via large responses
- **Mitigation**: Twilio SDK only makes requests to Twilio APIs (trusted endpoints). Update twilio when patch available.

### cookie (via next-auth)
- **CVE**: GHSA-pxg6-pf52-xh8x
- **Severity**: Low
- **Impact**: Cookie parsing edge cases
- **Mitigation**: NextAuth handles cookie parsing internally. Monitor for updates.

## Security Configuration Checklist

Before deploying to production, verify:

- [ ] `NEXTAUTH_SECRET` is set to a cryptographically random 32+ character string
- [ ] `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are production keys
- [ ] `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID` are production credentials
- [ ] `DEV_LOGIN_ENABLED` is NOT set or set to "false"
- [ ] `POSTGRES_URL` points to a production database with TLS
- [ ] Rate limiting is configured appropriately for expected traffic

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXTAUTH_SECRET` | Yes (prod) | JWT signing secret |
| `NEXTAUTH_URL` | Yes (prod) | Public URL of the app |
| `POSTGRES_URL` | No | PostgreSQL connection string (uses PGlite if not set) |
| `STRIPE_SECRET_KEY` | Yes | Stripe API secret key |
| `STRIPE_WEBHOOK_SECRET` | Yes | Stripe webhook signing secret |
| `TWILIO_ACCOUNT_SID` | Yes | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Yes | Twilio auth token |
| `TWILIO_VERIFY_SERVICE_SID` | Yes | Twilio Verify service SID |
| `SOULMATES_ADMIN_PHONES` | No | Comma-separated admin phone numbers |
| `DEV_LOGIN_ENABLED` | No | Enable dev login bypass (dev only) |
| `DEV_LOGIN_PHONE` | No | Phone number for dev login |

## Monitoring

### Health Check Endpoint
- **URL**: `GET /api/health`
- **Returns**: JSON with database status, latency, version
- **Use for**: Load balancer health checks, uptime monitoring

### Logs
Structured JSON logs are written to stdout/stderr. Key log events:
- `User authenticated` - successful login
- `SMS verification failed` - failed SMS check
- `Database migration failed` - startup error
- `Rate limit cleanup failed` - non-critical background task error

## Incident Response

1. **Database Down**: Health check returns 503. Check POSTGRES_URL and database connectivity.
2. **Auth Failures**: Check Twilio dashboard for SMS delivery issues.
3. **Payment Issues**: Check Stripe dashboard for webhook failures.
