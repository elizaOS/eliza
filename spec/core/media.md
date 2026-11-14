# Media fetch and content handles

Sources are `media/{fetch,local-store,attachments,mime,outbound,image-description-cache}.ts` and `network/{ssrf,fetch-guard,node-pinned-fetch}.ts`. Keep their filename, MIME, decoder, image-cache, outgoing-media and metadata contracts from the baseline inventory. Runtime authority applies only to canonical content-addressed local handles. Remote media uses screened DNS results pinned through transport and redirects.

## Story: Fetch an attachment through its correct trust boundary

As a plugin, I want media bytes fetched with cancellation, byte limits and endpoint validation before the bytes reach a model.

### Fetching requires a screened endpoint and finishing requires complete bounded bytes

Local-looking malformed handles fail explicitly. A trusted handle has the exact local origin and `/api/media/<sha256>.<ext>` path with no credentials, query or fragment. Each remote redirect is screened and pinned again. MIME prefix and content-encoding requirements apply before body acceptance. The configured byte maximum applies to streamed bytes and error diagnostic bodies. Cancellation and deadline stop the fetch and release transport resources.

```quint
type MediaPhase = Unresolved | Screened | Reading | Complete | Failed | Cancelled
type MediaFetch = { phase: MediaPhase, pinned: bool, received: int, maximum: int, released: bool }
pure val initial: MediaFetch = { phase: Unresolved, pinned: false, received: 0, maximum: 0, released: false }
pure def canScreen(m: MediaFetch, endpointValid: bool, maximum: int): bool = m.phase == Unresolved and endpointValid and maximum >= 0
pure def screen(m: MediaFetch, endpointValid: bool, maximum: int): MediaFetch = { ...m, phase: Screened, pinned: true, maximum: maximum }
pure def canOpenBody(m: MediaFetch, policyValid: bool): bool = m.phase == Screened and m.pinned and policyValid
pure def openBody(m: MediaFetch, policyValid: bool): MediaFetch = { ...m, phase: Reading }
pure def canReceive(m: MediaFetch, bytes: int): bool = m.phase == Reading and bytes >= 0 and m.received + bytes <= m.maximum
pure def receive(m: MediaFetch, bytes: int): MediaFetch = { ...m, received: m.received + bytes }
pure def canFinish(m: MediaFetch): bool = m.phase == Reading
pure def finish(m: MediaFetch): MediaFetch = { ...m, phase: Complete, released: true }
pure def canFailFetch(m: MediaFetch): bool = m.phase != Complete and m.phase != Cancelled and m.phase != Failed
pure def failFetch(m: MediaFetch): MediaFetch = { ...m, phase: Failed, released: true }
pure def canCancel(m: MediaFetch): bool = m.phase != Complete and m.phase != Cancelled and m.phase != Failed
pure def cancel(m: MediaFetch): MediaFetch = { ...m, phase: Cancelled, released: true }
pure def alwaysBoundedBytes(m: MediaFetch): bool = m.received >= 0 and m.received <= m.maximum
pure def alwaysUnresolvedHasNoBody(m: MediaFetch): bool = m.phase == Unresolved implies m.received == 0
pure def alwaysTerminalTransportReleased(m: MediaFetch): bool = (m.phase == Complete or m.phase == Cancelled or m.phase == Failed) implies m.released
pure def alwaysReadingScreenedEndpoint(m: MediaFetch): bool = (m.phase == Reading or m.phase == Complete) implies m.pinned
pure def sometimesMediaComplete(m: MediaFetch): bool = m.phase == Complete
pure def sometimesMediaFailed(m: MediaFetch): bool = m.phase == Failed
pure def sometimesMediaCancelled(m: MediaFetch): bool = m.phase == Cancelled
```

### Transport host spelling preserves DNS and IP certificate semantics

The transport receives the exact bare hostname, and its default HTTP Host header retains the URL hostname spelling (bracketed for IPv6). TLS SNI is the exact bare hostname only for HTTPS DNS names. The certificate identity defaults to the same bare hostname when SNI is absent. The `PinnedTransportHost.qnt` success case assumes a certificate that matches that identity and a functioning pinned connection; the model does not guarantee a live connection or a valid certificate. URL parsing, IP classification, custom Host headers, and adapter execution remain boundary contracts.

```quint
type TransportHost = DnsName | IPv4 | IPv6
type HostSpelling = { kind: TransportHost, bare: str, urlHost: str }
type TransportNames = { hostname: str, defaultHostHeader: str, serverName: str, certificateIdentity: str }
pure def usesSni(kind: TransportHost, tls: bool): bool = tls and kind == DnsName
pure def bracketsHostHeader(kind: TransportHost): bool = kind == IPv6
pure def transportNames(host: HostSpelling, tls: bool): TransportNames = { hostname: host.bare, defaultHostHeader: host.urlHost, serverName: if (usesSni(host.kind, tls)) host.bare else "", certificateIdentity: if (tls) host.bare else "" }
pure def lawTransportNamesPreserveHost(host: HostSpelling, tls: bool): bool = transportNames(host, tls).hostname == host.bare and transportNames(host, tls).defaultHostHeader == host.urlHost
pure def lawCertificateIdentityIsBare(host: HostSpelling, tls: bool): bool = if (tls) transportNames(host, tls).certificateIdentity == host.bare else transportNames(host, tls).certificateIdentity == ""
pure def lawServerNameOnlyForTlsDns(host: HostSpelling, tls: bool): bool = transportNames(host, tls).serverName == (if (tls and host.kind == DnsName) host.bare else "")
pure def lawIpLiteralOmitsSni(kind: TransportHost, tls: bool): bool = kind != DnsName implies not(usesSni(kind, tls))
pure def lawIPv6HostHeader(kind: TransportHost): bool = kind == IPv6 implies bracketsHostHeader(kind)
pure val hostValues: Set[HostSpelling] = Set({ kind: DnsName, bare: "localhost", urlHost: "localhost" }, { kind: IPv4, bare: "127.0.0.1", urlHost: "127.0.0.1" }, { kind: IPv6, bare: "::1", urlHost: "[::1]" })
```

## Story: Infer media type with the established precedence

As an attachment consumer, I want a detected container type to retain a more specific filename format.

### Specific sniffed types win and generic containers defer to a known extension

Headers are normalized to the lower-case MIME value before parameters. Only the basename determines an extension, after extracting an HTTP URL pathname. A generic sniff is `application/zip`, `application/octet-stream` or absence. The ordered fallback is specific sniff, known extension, specific header, sniff, header, absence.

```quint
type MimeCandidate = { present: bool, generic: bool, value: str }
pure def chooseMime(sniff: MimeCandidate, extension: MimeCandidate, header: MimeCandidate): str = if (sniff.present and (not(sniff.generic) or not(extension.present))) sniff.value else if (extension.present) extension.value else if (header.present and not(header.generic)) header.value else if (sniff.present) sniff.value else if (header.present) header.value else ""
pure def lawSpecificSniffWins(sniffed: str, extension: str, header: str): bool = chooseMime({ present: true, generic: false, value: sniffed }, { present: true, generic: false, value: extension }, { present: true, generic: false, value: header }) == sniffed
pure def lawContainerDefersToExtension(sniffed: str, extension: str, header: str): bool = chooseMime({ present: true, generic: true, value: sniffed }, { present: true, generic: false, value: extension }, { present: true, generic: false, value: header }) == extension
pure def lawAbsentMimeStaysAbsent(candidate: str): bool = chooseMime({ present: false, generic: true, value: candidate }, { present: false, generic: true, value: candidate }, { present: false, generic: true, value: candidate }) == ""
