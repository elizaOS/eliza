# BlueBubbles Local Bridge

This bridge runs on the Mac signed into Messages for the iPhone/Apple ID whose
real number should reach Eliza. It receives BlueBubbles webhooks, forwards
inbound messages to Eliza Cloud, resolves each sender to that sender's agent,
and sends the reply back through BlueBubbles. Apple and BlueBubbles credentials
stay on the Mac.

## Register the phone

From an authenticated Eliza Cloud client, create a sender-owned gateway. The
registering account owns the revocable bridge credential; it is not the agent
destination for everyone who texts the number:

```http
POST /api/v1/phone-gateways/bluebubbles
Content-Type: application/json

{
  "routingMode": "sender-owned",
  "phoneNumber": "+14155550123",
  "friendlyName": "iPhone gateway"
}
```

The response includes `relayEnvironment`. Save those four values in the Mac's
`.eliza-local/bluebubbles-bridge.env`; the gateway token is returned only once
and Cloud stores only its SHA-256 digest. A registered relay uses:

```sh
BLUEBUBBLES_BRIDGE_ID=bb-...
BLUEBUBBLES_GATEWAY_TOKEN=bbg_...
BLUEBUBBLES_GATEWAY_PHONE_NUMBER=+14155550123
ELIZA_CLOUD_BLUEBUBBLES_URL=https://api.eliza.app/api/webhooks/bluebubbles/bb-...
```

`BLUEBUBBLES_GATEWAY_SECRET` remains supported only for the existing shared
gateway compatibility route. New devices should use per-device registration.

Once `/health` reports `gatewayAuthMode: "registered-device"` and outbound
readiness is true, first drive the complete software path with an injected
inbound event from a phone already linked to a Cloud account. This proves
registration, sender-owned Cloud routing, that user's agent, and the real
Messages egress without claiming the inbound phone boundary:

```sh
bun run --cwd packages/app-core sms-gateway:verify:bluebubbles-registered -- \
  --sender +14155550999 \
  --agent-id <registered-agent-uuid>
```

For literal physical proof, wait for a message actually received by
BlueBubbles. The verifier prints the unique text that must be sent from the
second phone to the registered gateway number and watches the relay's bounded
local evidence stream:

```sh
bun run --cwd packages/app-core sms-gateway:verify:bluebubbles-registered -- \
  --sender +14155550999 \
  --agent-id <registered-agent-uuid> \
  --wait-real \
  --timeout-seconds 180
```

When `--agent-id` is supplied, both modes fail unless the message reaches that
sender's expected agent and its reply is sent immediately through Messages. A
queued reply is not counted as success. Only `--wait-real` proves the inbound
event originated at BlueBubbles rather than the verifier.

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
curl http://127.0.0.1:8795/inbound-events
curl http://127.0.0.1:8795/pending-replies
```

Manual retry is intentionally explicit because a broken Messages automation
state can otherwise spawn long-running send attempts:

```sh
curl -X POST 'http://127.0.0.1:8795/pending-replies/retry?limit=1'
```

## Gateway identity isolation

The relay forwards only `new-message` events that BlueBubbles can prove were
addressed to `BLUEBUBBLES_GATEWAY_PHONE_NUMBER`. BlueBubbles notification
payloads do not always include the receiving identity, so the relay retrieves
the full message and checks the chat's `lastAddressedHandle` before contacting
Eliza Cloud. A missing or different receiving identity is ignored fail-closed.

This check is mandatory when the Mac's Messages account has personal phone
numbers or email addresses in addition to the gateway number. It prevents
unrelated personal conversations on the same account from reaching an agent or
receiving an automated reply. For stronger operational isolation, dedicate the
Mac user and Apple Account to the gateway number.

## Outbound Requirements

Inbound routing is considered healthy when BlueBubbles has the webhook
`http://127.0.0.1:8795/webhooks/bluebubbles` registered for `new-message`
events and the cloud webhook accepts the forwarded payload. The relay creates
this local webhook through the authenticated BlueBubbles API on startup when it
is missing; `/doctor` reports a blocked check if automatic registration fails.

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
  "gatewayPhoneNumber": "+14155550123",
  "gatewayPhoneLabel": "iPhone gateway"
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
Shortcut. A bare phone-number `recipient` validates the iMessage path; pass an
explicit `SMS;-;<number>` `chatGuid` when validating SMS fallback.
