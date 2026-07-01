# PII pseudonymization — live Cerebras trajectory (#10469 / #7007)

- Provider: **cerebras/gpt-oss-120b** (live, not a mock)
- Captured: 2026-07-01T10:22:13.978Z

## 1. Original prompt (contains real PII)
```
Draft a one-sentence reply to Dana Whitfield at Acme Robotics. Their office is at 1600 Amphitheatre Parkway, Mountain View, CA. Address them by name in the sentence.
```

## 2. Exact prompt the provider received (surrogates only — no real PII)
```
Draft a one-sentence reply to Marco Hoffman at Ridgeline Holdings. Their office is at 5591 Cypress Court. Address them by name in the sentence.
```

## 3. Surrogate mapping (turn-scoped, never sent)

| real | → surrogate | kind |
| --- | --- | --- |
| 1600 Amphitheatre Parkway, Mountain View, CA | 5591 Cypress Court | address |
| Dana Whitfield | Marco Hoffman | person |
| Acme Robotics | Ridgeline Holdings | org |

## 4. Live model response (reasoned over surrogates)
```
Dear Marco, thank you for your inquiry—please confirm that we should forward the requested materials to your Ridgeline Holdings office at 5591 Cypress Court.
```

## 5. Execution boundary — real values restored into the tool call
```json
{
  "model_emitted": {
    "to": "Marco Hoffman",
    "body": "Reaching out from Ridgeline Holdings."
  },
  "handler_received": {
    "to": "Dana Whitfield",
    "body": "Reaching out from Acme Robotics."
  }
}
```

The provider and this trajectory contain **zero** real names/orgs/addresses;
the `SEND_EMAIL` handler ran with the **real** recipient.
