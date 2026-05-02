---
title: "Twilio Plugin"
sidebarTitle: "Twilio"
description: "Twilio connector for Eliza — SMS and voice integration via the Twilio API."
---

The Twilio plugin connects Eliza agents to Twilio, enabling SMS messaging and voice interactions through Twilio phone numbers.

**Package:** `@elizaos/plugin-twilio`

> **Note:** Twilio is categorized as a **feature** plugin in the registry, not a connector. It provides SMS and voice call capabilities via the Twilio API.

## Installation

```bash
eliza plugins install @elizaos/plugin-twilio
```

## Setup

### 1. Get Your Twilio Credentials

1. Sign up at [twilio.com](https://www.twilio.com/)
2. From the Twilio Console dashboard, copy your **Account SID** and **Auth Token**
3. Purchase or configure a Twilio phone number

### 2. Configure Eliza

```json
{
  "connectors": {
    "twilio": {
      "accountSid": "YOUR_ACCOUNT_SID",
      "authToken": "YOUR_AUTH_TOKEN",
      "phoneNumber": "YOUR_PHONE_NUMBER"
    }
  }
}
```

Or via environment variables:

```bash
export TWILIO_ACCOUNT_SID=YOUR_ACCOUNT_SID
export TWILIO_AUTH_TOKEN=YOUR_AUTH_TOKEN
export TWILIO_PHONE_NUMBER=YOUR_PHONE_NUMBER
```

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `accountSid` | Yes | Twilio Account SID |
| `authToken` | Yes | Twilio Auth Token |
| `phoneNumber` | No | Twilio phone number (E.164 format) |
| `enabled` | No | Set `false` to disable (default: `true`) |
| `webhookUrl` | No | Webhook URL for inbound messages |
| `webhookPort` | No | Port for webhook listener |

### Voice Call Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `voiceCallEnabled` | No | Enable voice call capabilities |
| `voiceCallProvider` | No | Voice call provider selection |
| `voiceCallFromNumber` | No | Phone number for outbound calls |
| `voiceCallToNumber` | No | Default destination phone number |
| `voiceCallAllowFrom` | No | Comma-separated list of allowed caller numbers |
| `voiceCallPublicUrl` | No | Public URL for voice call webhooks |
| `voiceCallInboundPolicy` | No | Inbound call handling policy |
| `voiceCallInboundGreeting` | No | Greeting message for inbound callers |
| `voiceCallMaxConcurrentCalls` | No | Maximum number of concurrent calls |
| `voiceCallMaxDurationSeconds` | No | Maximum call duration in seconds |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TWILIO_ACCOUNT_SID` | Yes | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Yes | Twilio Auth Token (primary auto-enable trigger) |
| `TWILIO_PHONE_NUMBER` | No | Twilio phone number |
| `TWILIO_WEBHOOK_URL` | No | Webhook callback URL |
| `TWILIO_WEBHOOK_PORT` | No | Webhook listener port |
| `VOICE_CALL_ENABLED` | No | Enable voice call functionality |
| `VOICE_CALL_PROVIDER` | No | Voice call provider |
| `VOICE_CALL_TO_NUMBER` | No | Default outbound call number |
| `VOICE_CALL_FROM_NUMBER` | No | Outbound caller ID number |
| `VOICE_CALL_ALLOW_FROM` | No | Allowed inbound caller numbers |
| `VOICE_CALL_PUBLIC_URL` | No | Public URL for voice webhooks |
| `VOICE_CALL_WEBHOOK_PATH` | No | Voice webhook endpoint path |
| `VOICE_CALL_WEBHOOK_PORT` | No | Voice webhook listener port |
| `VOICE_CALL_INBOUND_POLICY` | No | Inbound call acceptance policy |
| `VOICE_CALL_INBOUND_GREETING` | No | Greeting message for inbound calls |
| `VOICE_CALL_MAX_CONCURRENT_CALLS` | No | Maximum concurrent calls |
| `VOICE_CALL_MAX_DURATION_SECONDS` | No | Maximum call duration in seconds |

## Related

- [Connectors Guide](/guides/connectors) — General connector documentation
