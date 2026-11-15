// nodePinnedFetch turns a WHATWG URL host into node:http/https request
// options. The transport gets the bare name or address, the Host header keeps
// the URL form, and TLS offers a server name only for a DNS name.
module PinnedTransportHost {
  // hostKind: 0 the DNS name localhost, 1 the IPv4 literal 127.0.0.1,
  // 2 the IPv6 literal [::1] (WHATWG URL keeps the brackets).
  // scheme: 0 http, 1 https.
  // transportHost: 0 the bare name or address, 1 the bracketed URL form.
  // sni: 0 none, 1 the DNS name, 2 a bare IP address, 3 a bracketed one.
  // outcome: -1 not sent, 0 delivered, 2 certificate rejected.
  // The local certificate names localhost, 127.0.0.1 and ::1.
  var hostKind: int
  var scheme: int
  var phase: int
  var transportHost: int
  var sni: int
  var hostHeaderBracketed: bool
  var outcome: int

  pure def isIpLiteral(kind: int): bool = kind == 1 or kind == 2

  action init = {
    nondet chosenHost = Set(0, 1, 2).oneOf()
    nondet chosenScheme = Set(0, 1).oneOf()
    all {
      hostKind' = chosenHost, scheme' = chosenScheme, phase' = 0,
      transportHost' = 0, sni' = 0, hostHeaderBracketed' = false,
      outcome' = -1
    }
  }
  // nodePinnedFetch: strip the IPv6 brackets for the transport and set
  // servername only for an https DNS name.
  action build = all {
    phase == 0, phase' = 1, hostKind' = hostKind, scheme' = scheme,
    transportHost' = 0,
    sni' = if (scheme == 1 and not(isIpLiteral(hostKind))) 1 else 0,
    // node:http writes the Host header from the host it was given and
    // brackets an IPv6 address.
    hostHeaderBracketed' = hostKind == 2,
    outcome' = outcome
  }
  // node:https checks the certificate against servername when it is set,
  // else against the host. A bracketed address is neither a certificate IP
  // nor a certificate DNS name. The guard's pinned lookup connects either
  // form to the screened address.
  action connect = all {
    phase == 1, phase' = 2, hostKind' = hostKind, scheme' = scheme,
    transportHost' = transportHost, sni' = sni,
    hostHeaderBracketed' = hostHeaderBracketed,
    outcome' =
      if (scheme == 1 and (sni == 3 or (sni == 0 and transportHost == 1))) 2
      else 0
  }
  action stay = all {
    phase == 2, phase' = phase, hostKind' = hostKind, scheme' = scheme,
    transportHost' = transportHost, sni' = sni,
    hostHeaderBracketed' = hostHeaderBracketed, outcome' = outcome
  }
  action step = any { build, connect, stay }

  val Delivered = phase != 2 or outcome == 0
  val TransportGetsBareHost = phase == 0 or transportHost == 0
  val NoIpServerName = sni != 2 and sni != 3
  val DnsNameServerName =
    phase == 0 or scheme == 0 or isIpLiteral(hostKind) or sni == 1
  val HostHeaderKeepsUrlForm =
    phase == 0 or hostHeaderBracketed == (hostKind == 2)
}
