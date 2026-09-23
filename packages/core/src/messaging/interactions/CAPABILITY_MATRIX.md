# First-party interaction capability baseline

This generated baseline is conservative. Each runtime registration materializes the family for its concrete account and target; #24288 may advertise stronger limits only with adapter tests.

| Connector | Account | Target | Block delivery | Callback bytes | Attachments |
| --- | --- | --- | --- | ---: | --- |
| discord | <account> | channel:<target> | choice:native→conversational→signed-hosted<br>form:conversational→signed-hosted<br>followups:native→conversational<br>task:native→signed-hosted→conversational<br>secret:sensitive-request | 64 | none |
| gmail | <account> | email:<target> | choice:conversational→signed-hosted<br>form:conversational→signed-hosted<br>followups:conversational<br>task:signed-hosted→conversational<br>secret:sensitive-request | 0 | none |
| google-chat | <account> | room:<target> | choice:conversational→signed-hosted<br>form:conversational→signed-hosted<br>followups:conversational<br>task:signed-hosted→conversational<br>secret:sensitive-request | 0 | none |
| imessage | <account> | user:<target> | choice:conversational→signed-hosted<br>form:conversational→signed-hosted<br>followups:conversational<br>task:signed-hosted→conversational<br>secret:sensitive-request | 0 | none |
| instagram | <account> | thread:<target> | choice:conversational→signed-hosted<br>form:conversational→signed-hosted<br>followups:conversational<br>task:signed-hosted→conversational<br>secret:sensitive-request | 0 | none |
| matrix | <account> | room:<target> | choice:conversational→signed-hosted<br>form:conversational→signed-hosted<br>followups:conversational<br>task:signed-hosted→conversational<br>secret:sensitive-request | 0 | none |
| slack | <account> | channel:<target> | choice:conversational→signed-hosted<br>form:conversational→signed-hosted<br>followups:conversational<br>task:signed-hosted→conversational<br>secret:sensitive-request | 0 | none |
| telegram | <account> | room:<target> | choice:native→conversational→signed-hosted<br>form:conversational→signed-hosted<br>followups:native→conversational<br>task:native→signed-hosted→conversational<br>secret:sensitive-request | 64 | none |
| wechat | <account> | room:<target> | choice:conversational→signed-hosted<br>form:conversational→signed-hosted<br>followups:conversational<br>task:signed-hosted→conversational<br>secret:sensitive-request | 0 | none |
| whatsapp | <account> | phone:<target> | choice:conversational→signed-hosted<br>form:conversational→signed-hosted<br>followups:conversational<br>task:signed-hosted→conversational<br>secret:sensitive-request | 0 | none |
| x | <account> | user:<target> | choice:conversational→signed-hosted<br>form:conversational→signed-hosted<br>followups:conversational<br>task:signed-hosted→conversational<br>secret:sensitive-request | 0 | none |

## Read-only registrations

These registrations expose history and search only. They cannot deliver interaction blocks or collect replies through this connector.

| Connector | Registration | Target | Outbound interaction delivery |
| --- | --- | --- | --- |
| telegram | plugin-telegram/src/account-client-service.ts | user:<target> | unsupported |
| telegram | plugin-telegram/src/account-client-service.ts | channel:<target> | unsupported |
| telegram | plugin-telegram/src/account-client-service.ts | thread:<target> | unsupported |
