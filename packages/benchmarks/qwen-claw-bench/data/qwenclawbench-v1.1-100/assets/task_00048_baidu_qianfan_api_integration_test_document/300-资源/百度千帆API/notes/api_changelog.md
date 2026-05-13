# Baidu Qianfan API — Changelog & Endpoint Updates

This document tracks changes to the Baidu Qianfan API endpoints and authentication flow as observed by our team.

---

## 2023-01-15 — Token Endpoint Upgrade to v3.0

**IMPORTANT UPDATE:** The authentication token endpoint has been upgraded to version 3.0. All new integrations should use the updated endpoint:

```
https://aip.baidubce.com/oauth/3.0/token
```

The v3.0 endpoint supports enhanced security features including:
- Improved token rotation policies
- Extended token metadata in responses
- Better rate limiting headers

**Migration Note:** The previous v2.0 endpoint (`/oauth/2.0/token`) is scheduled for deprecation. Please update your configurations accordingly.

**Parameters remain the same:**
- `grant_type` — Use `client_credentials` for server-to-server
- `client_id` — Your API Key
- `client_secret` — Your Secret Key

---

## 2022-11-20 — ERNIE-Bot Model Update

The ERNIE-Bot model was updated to support longer context windows (up to 8K tokens). No endpoint changes required.

---

## 2022-06-01 — Chat Endpoint Deprecation Notice

The legacy chat endpoint has been deprecated:

```
/v1/wenxinworkshop/chat/eb-instant
```

All traffic should be migrated to the new unified chat completions endpoint:

```
/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/completions
```

The `eb-instant` endpoint will return HTTP 301 redirects starting 2022-09-01 and will be fully removed by 2022-12-31.

---

## 2022-03-10 — Initial API Integration

First integration with Baidu Qianfan API. Documented base URL and initial endpoint structure. Authentication flow tested successfully with OAuth 2.0 client credentials grant.

---

*Last reviewed: 2023-02-01*
