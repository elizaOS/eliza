# BlueBubbles Local Bridge

This bridge runs on the Mac attached to the shared Eliza Cloud gateway number
`+14159611510`. It receives BlueBubbles webhooks, forwards inbound messages to
Eliza Cloud, and sends any cloud reply back through BlueBubbles.

## Runtime

LaunchAgent:

```sh
~/Library/LaunchAgents/ai.elizacloud.bluebubbles-bridge.plist
```

Local endpoints:

```sh
curl http://127.0.0.1:8795/health
curl http://127.0.0.1:8795/diagnostics
curl http://127.0.0.1:8795/doctor
curl http://127.0.0.1:8795/pending-replies
```

Manual retry is intentionally explicit because a broken Messages automation
state can otherwise spawn long-running send attempts:

```sh
curl -X POST 'http://127.0.0.1:8795/pending-replies/retry?limit=1'
```

## Outbound Requirements

Inbound routing is considered healthy when BlueBubbles has the webhook
`http://127.0.0.1:8795/webhooks/bluebubbles` registered for `new-message`
events and the cloud webhook accepts the forwarded payload.

Outbound routing is only healthy when one send path is available:

- `apple-script`: Messages AppleEvents must respond and BlueBubbles must be
  allowed to automate Messages.
- `private-api`: BlueBubbles private API must be enabled, the helper must be
  connected, and SIP must be disabled.
- `shortcuts`: set `BLUEBUBBLES_SEND_METHOD=shortcuts` and install a shortcut
  named `Eliza Cloud Send Message` or the value of `BLUEBUBBLES_SHORTCUT_NAME`.
  The bridge passes a JSON file as Shortcut Input:

```json
{
  "chatGuid": "SMS;-;+14155550123",
  "recipient": "+14155550123",
  "message": "Reply text",
  "gatewayPhoneNumber": "+14159611510",
  "gatewayPhoneLabel": "Eliza Cloud Gateway (+14159611510)"
}
```

The shortcut can use `recipient` directly with the native Messages **Send
Message** action. `chatGuid` is included for diagnostics and parity with the
BlueBubbles API path.

The bridge exposes this under `outboundReadiness` in `/health` and
`/diagnostics`. `/diagnostics` also includes `senderOptions`, which evaluates
all three egress modes even when only one mode is active. `/doctor` summarizes
the same checks as pass/blocked and lists the next action. Do not drain queued
replies until `outboundReadiness.ready` is true.

Validate a real send path without draining queued replies:

```sh
curl -X POST http://127.0.0.1:8795/outbound/validate \
  -H 'content-type: application/json' \
  -d '{
    "recipient": "+14153024399",
    "message": "Eliza Cloud outbound validation",
    "method": "shortcuts"
  }'
```

`method` is optional and defaults to `BLUEBUBBLES_SEND_METHOD`. Set it to
`apple-script`, `private-api`, or `shortcuts` to test a specific egress path
after repairing Messages automation, the BlueBubbles private API helper, or the
Shortcut.
