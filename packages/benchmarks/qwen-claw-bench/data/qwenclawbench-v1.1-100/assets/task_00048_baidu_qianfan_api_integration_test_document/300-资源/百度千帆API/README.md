# Baidu Qianfan API Integration

## Project Overview

This project integrates the Baidu Qianfan large language model platform into our backend services. The Qianfan platform provides access to ERNIE-Bot and other foundation models via a REST API.

## API Base URL

All API requests are made against the following base URL:

```
https://aip.baidubce.com
```

## Authentication

Baidu Qianfan uses OAuth 2.0 for authentication. Before making any API calls, you must obtain an access token.

**Token Endpoint:**

```
https://aip.baidubce.com/oauth/2.0/token
```

**Required Parameters:**

| Parameter      | Value                  | Description                        |
|----------------|------------------------|------------------------------------|
| `grant_type`   | `client_credentials`   | Fixed value for server-to-server   |
| `client_id`    | Your API Key           | Obtained from Qianfan console      |
| `client_secret`| Your Secret Key        | Obtained from Qianfan console      |

**Example Token Request:**

```
POST https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=YOUR_API_KEY&client_secret=YOUR_SECRET_KEY
```

The response will include an `access_token` field and an `expires_in` field (typically 2592000 seconds, i.e., 30 days).

## Required Credentials

To use the API, you need:

1. **API Key** — Acts as the `client_id` in OAuth requests
2. **Secret Key** — Acts as the `client_secret` in OAuth requests

Both can be obtained by creating an application in the [Baidu AI Cloud Console](https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application).

## ERNIE-Bot Chat Completion Endpoint

```
https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/completions
```

Pass the access token as a query parameter: `?access_token=YOUR_ACCESS_TOKEN`

**Request Body (JSON):**

```json
{
  "messages": [
    {
      "role": "user",
      "content": "Hello, how are you?"
    }
  ]
}
```

## Quick Start

1. Obtain API Key and Secret Key from the Baidu AI Cloud Console.
2. Request an access token using the token endpoint.
3. Call the ERNIE-Bot chat completion endpoint with the access token.
4. See `code/sample_request.py` for a code example.

## References

- [Qianfan API Documentation](https://cloud.baidu.com/doc/WENXINWORKSHOP/index.html)
- [Error Code Reference](notes/error_codes.json)
- [Integration Tips](notes/integration_tips.md)
