# DingTalk Custom Robot - Text Message Format

## Overview

DingTalk custom robots accept webhook POST requests with a JSON body. This document covers the **text** message type used for plain-text notifications.

## JSON Structure

```json
{
  "msgtype": "text",
  "text": {
    "content": "Your notification message here"
  },
  "at": {
    "atMobiles": ["1380000xxxx"],
    "isAtAll": false
  }
}
```

## Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `msgtype` | string | Yes | Must be `"text"` for text messages. |
| `text.content` | string | Yes | The notification body. Maximum length: **20000** characters. |
| `at.atMobiles` | array of strings | No | List of mobile numbers to @mention. |
| `at.isAtAll` | boolean | No | Set to `true` to @mention everyone. |

## Newline Handling

For text messages, newlines within the `content` field **must** be encoded as the literal two-character sequence `\n` inside the JSON string value. This is standard JSON string encoding.

**Correct:**
```json
{
  "msgtype": "text",
  "text": {
    "content": "Line 1\nLine 2\nLine 3"
  }
}
```

**Incorrect** (raw newlines break JSON parsing):
```json
{
  "msgtype": "text",
  "text": {
    "content": "Line 1
Line 2
Line 3"
  }
}
```

## Important Notes

1. The `at` field is **optional**. If you do not need @mentions, you can omit it entirely.
2. The `content` string must be valid within a JSON string — no unescaped double quotes, no raw control characters.
3. The `msgtype` field determines how DingTalk renders the message. Do **not** mix formatting rules between `text` and `markdown` message types — they are completely different.
4. Content is rendered as-is. Whitespace characters — including spaces and tabs within the string — are preserved in the displayed message.

## Example: Simple Alert Notification

```json
{
  "msgtype": "text",
  "text": {
    "content": "Alert: Server CPU usage exceeded 90%\nHost: web-server-01\nTime: 2024-01-15 10:30:00\nDetails: https://monitor.example.com/alert/123"
  }
}
```

## Rate Limits

- Each robot can send at most **20 messages per minute**.
- Messages exceeding the rate limit will receive HTTP 302 or a frequency-limit error response.
