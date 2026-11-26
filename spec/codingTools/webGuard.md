# Public web fetch and search guard

Enforces HTTPS-only, public-network-only outbound reads for `WEB_FETCH` and `WEB_SEARCH`.

## Story: Fetch and search the public web without leaking secrets or touching private networks

> As the owner, I want `WEB_FETCH` and `WEB_SEARCH` to respect their kill switches, require canonical public HTTPS targets without embedded credentials or private-network hosts, refuse plaintext redirect downgrades, and enforce a hard response byte ceiling.

### Public web requests require an active capability, HTTPS without credentials or private addresses, and bounded responses

A public web request is admitted only when the capability is active (kill switch not triggered), the target uses HTTPS with no embedded credentials, no custom port, no private or blocked hostname, no sensitive query parameters, and no plaintext redirect downgrade. Responses must enforce a positive byte ceiling (`maxBytes > 0`) and stay within `[0, maxBytes]`.

```quint
type WebRequestCheck = {
  killSwitchOff: bool,
  isHttps: bool,
  hasCredentials: bool,
  hasCustomPort: bool,
  isPrivateOrBlockedHost: bool,
  hasSensitiveQuery: bool,
  isRedirectDowngrade: bool,
  bodyBytes: int,
  maxBytes: int
}
pure def mayFetchPublicWeb(req: WebRequestCheck): bool =
  not(req.killSwitchOff) and
  req.isHttps and
  not(req.hasCredentials) and
  not(req.hasCustomPort) and
  not(req.isPrivateOrBlockedHost) and
  not(req.hasSensitiveQuery) and
  not(req.isRedirectDowngrade) and
  req.maxBytes > 0 and
  req.bodyBytes >= 0 and
  req.bodyBytes <= req.maxBytes
pure def lawPrivateHostBlocked(req: WebRequestCheck): bool =
  req.isPrivateOrBlockedHost implies not(mayFetchPublicWeb(req))
pure def lawPlaintextOrDowngradeBlocked(req: WebRequestCheck): bool =
  (not(req.isHttps) or req.isRedirectDowngrade) implies not(mayFetchPublicWeb(req))
pure def lawKillSwitchBlocksWeb(req: WebRequestCheck): bool =
  req.killSwitchOff implies not(mayFetchPublicWeb(req))
pure def lawOversizeWebResponseBlocked(req: WebRequestCheck): bool =
  (req.maxBytes > 0 and req.bodyBytes > req.maxBytes) implies not(mayFetchPublicWeb(req))
pure val reqValues = Set(
  { killSwitchOff: false, isHttps: true, hasCredentials: false, hasCustomPort: false, isPrivateOrBlockedHost: false, hasSensitiveQuery: false, isRedirectDowngrade: false, bodyBytes: 100, maxBytes: 1000 },
  { killSwitchOff: true, isHttps: true, hasCredentials: false, hasCustomPort: false, isPrivateOrBlockedHost: false, hasSensitiveQuery: false, isRedirectDowngrade: false, bodyBytes: 100, maxBytes: 1000 },
  { killSwitchOff: false, isHttps: false, hasCredentials: false, hasCustomPort: false, isPrivateOrBlockedHost: false, hasSensitiveQuery: false, isRedirectDowngrade: false, bodyBytes: 100, maxBytes: 1000 },
  { killSwitchOff: false, isHttps: true, hasCredentials: false, hasCustomPort: false, isPrivateOrBlockedHost: true, hasSensitiveQuery: false, isRedirectDowngrade: false, bodyBytes: 100, maxBytes: 1000 },
  { killSwitchOff: false, isHttps: true, hasCredentials: false, hasCustomPort: false, isPrivateOrBlockedHost: false, hasSensitiveQuery: false, isRedirectDowngrade: true, bodyBytes: 100, maxBytes: 1000 },
  { killSwitchOff: false, isHttps: true, hasCredentials: false, hasCustomPort: false, isPrivateOrBlockedHost: false, hasSensitiveQuery: false, isRedirectDowngrade: false, bodyBytes: 2000, maxBytes: 1000 }
)
```
