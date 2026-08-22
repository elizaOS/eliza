# First-party interaction capability baseline

This generated matrix is the production declaration. Each runtime registration materializes the family for its concrete account and target; native claims are backed by adapter tests and every other block has an explicit semantic fallback.

| Connector | Account | Target | Block delivery | Callback bytes | Attachments |
| --- | --- | --- | --- | ---: | --- |
| discord | <account> | channel:<target> | choice:native→conversational→signed-hosted<br>form:conversational→signed-hosted<br>followups:native→conversational<br>task:native→signed-hosted→conversational<br>secret:sensitive-request | 100 | 10 × 10000000 |
| gmail | <account> | email:<target> | choice:conversational→signed-hosted<br>form:conversational→signed-hosted<br>followups:conversational<br>task:signed-hosted→conversational<br>secret:sensitive-request | 0 | none |
| google-chat | <account> | room:<target> | choice:conversational→signed-hosted<br>form:conversational→signed-hosted<br>followups:conversational<br>task:signed-hosted→conversational<br>secret:sensitive-request | 0 | 1 × 52428800 |
| imessage | <account> | user:<target> | choice:conversational→signed-hosted<br>form:conversational→signed-hosted<br>followups:conversational<br>task:signed-hosted→conversational<br>secret:sensitive-request | 0 | 1 × 52428800 |
| instagram | <account> | thread:<target> | choice:conversational→signed-hosted<br>form:conversational→signed-hosted<br>followups:conversational<br>task:signed-hosted→conversational<br>secret:sensitive-request | 0 | none |
| matrix | <account> | room:<target> | choice:conversational→signed-hosted<br>form:conversational→signed-hosted<br>followups:conversational<br>task:signed-hosted→conversational<br>secret:sensitive-request | 0 | none |
| slack | <account> | channel:<target> | choice:native→conversational→signed-hosted<br>form:conversational→signed-hosted<br>followups:native→conversational<br>task:native→signed-hosted→conversational<br>secret:sensitive-request | 2000 | 10 × 20000000 |
| telegram | <account> | room:<target> | choice:native→conversational→signed-hosted<br>form:conversational→signed-hosted<br>followups:native→conversational<br>task:native→signed-hosted→conversational<br>secret:sensitive-request | 64 | 10 × 20000000 |
| wechat | <account> | room:<target> | choice:conversational→signed-hosted<br>form:conversational→signed-hosted<br>followups:conversational<br>task:signed-hosted→conversational<br>secret:sensitive-request | 0 | none |
| whatsapp | <account> | phone:<target> | choice:native→conversational→signed-hosted<br>form:conversational→signed-hosted<br>followups:native→conversational<br>task:conversational→signed-hosted<br>secret:sensitive-request | 200 | 1 × 16000000 |
| x | <account> | user:<target> | choice:conversational→signed-hosted<br>form:conversational→signed-hosted<br>followups:conversational<br>task:signed-hosted→conversational<br>secret:sensitive-request | 0 | none |

## Explicit exclusions

- plugin-signal: Signal is intentionally unsupported and throws SIGNAL_DIRECT_TRANSPORT_UNAVAILABLE; it registers no message connector.
