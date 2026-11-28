# Native website blocking

The native boundary covers Android VPN DNS consent and iOS Safari content-blocker settings. A host can also supply an authorized runtime or desktop engine.

## Story: See which websites my device is actually blocking

> As the owner, I want a restriction that matches the approved domains and a status that reflects which rules its engine applied.

### A block is authorized only by the selected engine and its normalized domain scope

Domain validation and normalization run at the boundary. The exact and proper-subdomain match cases are classified against a parsed domain. Explicit allow rules win. The adapter reports requested and blocked domain lists separately. A match counts as a block only while the engine reports an active policy.

```quint
type WebsiteEngine = AndroidVpn | AppleContentBlocker | DesktopHosts | DesktopNetworkExtension | WebsiteUnavailable
type WebsiteMode = ExactDomain | IncludeSubdomains
type DomainRelation = SameDomain | ProperSubdomain | DomainUnrelated
type WebsiteWindow = WebsiteNoExpiry | WebsiteExpiresAt({ deadline: int })
pure def activeWebsiteWindow(window: WebsiteWindow, nowMs: int): bool = match window {
  | WebsiteNoExpiry => true
  | WebsiteExpiresAt(interval) => nowMs >= 0 and nowMs < interval.deadline
}
pure def matchesDomain(mode: WebsiteMode, relationship: DomainRelation): bool =
  relationship == SameDomain or (mode == IncludeSubdomains and relationship == ProperSubdomain)
pure def mayInstallWebsitePolicy(engine: WebsiteEngine, granted: bool, requestedDomains: int, window: WebsiteWindow, nowMs: int): bool =
  engine != WebsiteUnavailable and granted and requestedDomains > 0 and activeWebsiteWindow(window, nowMs)
pure def blockWebsite(engineReportedActive: bool, allowed: bool, mode: WebsiteMode, relationship: DomainRelation, window: WebsiteWindow, nowMs: int): bool =
  engineReportedActive and not(allowed) and matchesDomain(mode, relationship) and activeWebsiteWindow(window, nowMs)
pure def lawAllowedDomainIsNeverBlocked(engineReportedActive: bool, mode: WebsiteMode, relationship: DomainRelation, window: WebsiteWindow, nowMs: int): bool =
  not(blockWebsite(engineReportedActive, true, mode, relationship, window, nowMs))
pure def lawExactDomainNeverIncludesSubdomains(relationship: DomainRelation): bool =
  matchesDomain(ExactDomain, relationship) == (relationship == SameDomain)
pure val windowValues = Set(WebsiteNoExpiry, WebsiteExpiresAt({ deadline: 5000 }), WebsiteExpiresAt({ deadline: 0 }))
pure val nowMsValues = Set(0, 4999, 5000, 10000)
```
