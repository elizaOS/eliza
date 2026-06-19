# Baidu Qianfan API — Integration Tips

Collected from team discussions and hands-on experience. Updated as of 2024-01.

---

## 1. Always Cache Access Tokens

Access tokens are valid for **30 days** (2,592,000 seconds). There is no need to request a new token for every API call. Store the token and its expiration timestamp, and only refresh when it is about to expire or when you receive a 111 (token expired) error.

```python
import time

token_cache = {"access_token": None, "expires_at": 0}

def get_cached_token(api_key, secret_key):
    if time.time() < token_cache["expires_at"] - 86400:  # refresh 1 day early
        return token_cache["access_token"]
    # ... request new token ...
```

## 2. Implement Exponential Backoff for Rate Limiting

When you receive error code 18 (QPS limit reached), do not retry immediately. Use exponential backoff:

- 1st retry: wait 500ms
- 2nd retry: wait 1000ms
- 3rd retry: wait 2000ms
- Max wait: 10 seconds

This prevents thundering herd problems and respects the API's rate limits.

## 3. Set Request Timeout to at Least 30 Seconds

Chat completion requests can take a while, especially for longer prompts or when the model generates lengthy responses. A timeout of **30 seconds** is the recommended minimum. For complex multi-turn conversations, consider increasing to 60 seconds.

## 4. Use Streaming Mode for Long Responses

For responses that may be lengthy, enable streaming by adding `"stream": true` to the request body. This returns results as Server-Sent Events (SSE), allowing you to display partial results to the user in real time.

```json
{
  "messages": [{"role": "user", "content": "Write a long essay..."}],
  "stream": true
}
```

## 5. Log `request_id` from Responses for Debugging

Every API response includes a `request_id` field in the JSON body. Always log this value. When filing support tickets or debugging issues, the `request_id` allows Baidu's support team to trace the exact request on their end.

## 6. Consider Using the Python SDK

The official Python SDK `qianfan` simplifies integration significantly:

```bash
pip install qianfan
```

```python
import qianfan

chat_comp = qianfan.ChatCompletion()
resp = chat_comp.do(messages=[{"role": "user", "content": "Hello!"}])
print(resp["result"])
```

The SDK handles token management, retries, and error handling automatically.

---

## Additional Notes

- The API supports both `application/json` content type for requests.
- Response encoding is UTF-8.
- For production use, store API Key and Secret Key in environment variables or a secrets manager — never hard-code them.
- Monitor your daily usage via the Baidu AI Cloud Console dashboard.
