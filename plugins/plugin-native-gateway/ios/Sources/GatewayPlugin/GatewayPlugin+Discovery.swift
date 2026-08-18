import Foundation
import Capacitor
import Network

extension GatewayPlugin {
    @objc func startDiscovery(_ call: CAPPluginCall) {
        if isDiscovering {
            call.resolve(buildDiscoveryResult())
            return
        }
        let parameters = NWBrowser.Descriptor.bonjour(type: serviceType, domain: "local.")
        browser = NWBrowser(for: parameters, using: .tcp)
        browser?.browseResultsChangedHandler = { [weak self] _, changes in
            guard let self else { return }
            for change in changes {
                switch change {
                case .added(let result): self.handleServiceFound(result)
                case .removed(let result): self.handleServiceLost(result)
                default: break
                }
            }
        }
        browser?.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready: self?.isDiscovering = true
            case .failed(let error):
                print("[Gateway] Browser failed: \(error)")
                self?.isDiscovering = false
            case .cancelled: self?.isDiscovering = false
            default: break
            }
        }
        browser?.start(queue: .main)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            call.resolve(self?.buildDiscoveryResult() ?? [:])
        }
    }

    @objc func stopDiscovery(_ call: CAPPluginCall) {
        browser?.cancel()
        browser = nil
        isDiscovering = false
        call.resolve()
    }

    @objc func getDiscoveredGateways(_ call: CAPPluginCall) {
        call.resolve(buildDiscoveryResult())
    }

    func handleServiceFound(_ result: NWBrowser.Result) {
        guard case .service(let name, _, let domain, _) = result.endpoint else { return }
        let connection = NWConnection(to: result.endpoint, using: .tcp)
        connection.stateUpdateHandler = { [weak self] state in
            guard let self, case .ready = state else { return }
            defer { connection.cancel() }
            guard
                let endpoint = connection.currentPath?.remoteEndpoint,
                case .hostPort(let host, let port) = endpoint
            else { return }
            let hostString: String
            switch host {
            case .ipv4(let address): hostString = "\(address)"
            case .ipv6(let address): hostString = "\(address)"
            case .name(let hostname, _): hostString = hostname
            @unknown default: hostString = "unknown"
            }
            let identifier = self.stableId(name: name, domain: domain)
            let gateway: JSObject = [
                "stableId": identifier,
                "name": self.decodeServiceName(name),
                "host": hostString,
                "port": Int(port.rawValue),
                "gatewayPort": Int(port.rawValue),
                "tlsEnabled": false,
                "isLocal": true
            ]
            let isNew = self.discoveredGateways[identifier] == nil
            self.discoveredGateways[identifier] = gateway
            self.notifyListeners("discovery", data: [
                "type": isNew ? "found" : "updated",
                "gateway": gateway
            ])
        }
        connection.start(queue: .main)
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            if connection.state != .ready { connection.cancel() }
        }
    }

    func handleServiceLost(_ result: NWBrowser.Result) {
        guard case .service(let name, _, let domain, _) = result.endpoint else { return }
        let identifier = stableId(name: name, domain: domain)
        if let removed = discoveredGateways.removeValue(forKey: identifier) {
            notifyListeners("discovery", data: ["type": "lost", "gateway": removed])
        }
    }

    func stableId(name: String, domain: String) -> String {
        "\(serviceType)|.\(domain)|.\(name.lowercased().trimmingCharacters(in: .whitespaces))"
    }

    func decodeServiceName(_ raw: String) -> String {
        var result = raw
        let pattern = #"\\(\d{3})"#
        if let regex = try? NSRegularExpression(pattern: pattern) {
            let range = NSRange(result.startIndex..., in: result)
            for match in regex.matches(in: result, range: range).reversed() {
                guard
                    let codeRange = Range(match.range(at: 1), in: result),
                    let code = Int(result[codeRange]),
                    let scalar = Unicode.Scalar(code),
                    let fullRange = Range(match.range, in: result)
                else { continue }
                result.replaceSubrange(fullRange, with: String(Character(scalar)))
            }
        }
        return result
    }

    func buildDiscoveryResult() -> JSObject {
        let sortedGateways = discoveredGateways.values.sorted {
            ($0["name"] as? String ?? "").lowercased() <
                ($1["name"] as? String ?? "").lowercased()
        }
        return [
            "gateways": sortedGateways,
            "status": isDiscovering ? "Discovering..." : "Discovery stopped"
        ]
    }
}
