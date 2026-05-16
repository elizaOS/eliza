@testable import ElizaMacCore
import Foundation
import XCTest

final class RuntimeAPIClientTests: XCTestCase {
    override func tearDown() {
        RuntimeURLProtocolStub.responses = [:]
        RuntimeURLProtocolStub.requestedPaths = []
        super.tearDown()
    }

    func testFetchSnapshotReadsHealthAgentsAndLogs() async throws {
        RuntimeURLProtocolStub.responses = [
            "/api/health": (200, """
            {
              "ready": true,
              "runtime": "ok",
              "database": "ok",
              "plugins": { "loaded": 12, "failed": 1 },
              "coordinator": "not_wired",
              "connectors": { "discord": "connected", "calendar": "configured" },
              "uptime": 91,
              "agentState": "running"
            }
            """),
            "/api/agents": (200, """
            {
              "agents": [
                { "id": "main", "name": "Eliza", "status": "running" }
              ]
            }
            """),
            "/api/logs": (200, """
            {
              "entries": [
                {
                  "timestamp": 1760000000000,
                  "level": "info",
                  "message": "runtime ready",
                  "source": "agent",
                  "tags": ["startup"]
                }
              ],
              "sources": ["agent"],
              "tags": ["startup"]
            }
            """)
        ]

        let snapshot = try await RuntimeAPIClient(baseURL: runtimeBaseURL, session: stubbedSession).fetchSnapshot()

        XCTAssertTrue(snapshot.health.ready)
        XCTAssertEqual(snapshot.health.plugins.loaded, 12)
        XCTAssertEqual(snapshot.health.connectors["discord"], "connected")
        XCTAssertEqual(snapshot.agents.first?.name, "Eliza")
        XCTAssertEqual(snapshot.logs.entries.first?.message, "runtime ready")
        XCTAssertEqual(Set(RuntimeURLProtocolStub.requestedPaths), ["/api/health", "/api/agents", "/api/logs"])
    }

    func testHTTPFailureSurfacesStatusAndPath() async throws {
        RuntimeURLProtocolStub.responses = [
            "/api/health": (503, "{}")
        ]

        do {
            _ = try await RuntimeAPIClient(baseURL: runtimeBaseURL, session: stubbedSession).fetchHealth()
            XCTFail("Expected RuntimeAPIError.httpStatus")
        } catch let error as RuntimeAPIError {
            XCTAssertEqual(error, .httpStatus(503, "/api/health"))
        }
    }

    func testFetchWalletSnapshotReadsRuntimeWalletRoutes() async throws {
        RuntimeURLProtocolStub.responses = [
            "/api/wallet/config": (200, """
            {
              "evmAddress": "0x1234",
              "solanaAddress": "So111",
              "selectedRpcProviders": { "evm": "eliza-cloud", "bsc": "alchemy", "solana": "helius-birdeye" },
              "walletNetwork": "mainnet",
              "legacyCustomChains": ["evm"],
              "alchemyKeySet": true,
              "infuraKeySet": false,
              "ankrKeySet": false,
              "heliusKeySet": true,
              "birdeyeKeySet": true,
              "evmChains": ["ethereum", "base"],
              "walletSource": "local",
              "automationMode": "full",
              "pluginEvmLoaded": true,
              "pluginEvmRequired": true,
              "executionReady": true,
              "executionBlockedReason": null,
              "evmSigningCapability": "local",
              "evmSigningReason": "local signer available",
              "solanaSigningAvailable": true,
              "wallets": [
                { "source": "local", "chain": "evm", "address": "0x1234", "provider": "local", "primary": true }
              ],
              "primary": { "evm": "local", "solana": "local" }
            }
            """),
            "/api/wallet/addresses": (200, """
            {
              "evmAddress": "0x1234",
              "solanaAddress": "So111"
            }
            """),
            "/api/wallet/balances": (200, """
            {
              "evm": {
                "address": "0x1234",
                "chains": [
                  {
                    "chain": "ethereum",
                    "chainId": 1,
                    "nativeBalance": "1.5",
                    "nativeSymbol": "ETH",
                    "nativeValueUsd": "4800",
                    "tokens": [],
                    "error": null
                  }
                ]
              },
              "solana": {
                "address": "So111",
                "solBalance": "2.25",
                "solValueUsd": "400",
                "tokens": []
              }
            }
            """),
            "/api/wallet/steward-status": (200, """
            {
              "configured": true,
              "available": true,
              "connected": true,
              "baseUrl": "http://127.0.0.1:8765",
              "agentId": "agent-main",
              "evmAddress": "0x1234",
              "walletAddresses": { "evm": "0x1234", "solana": "So111" },
              "agentName": "Eliza",
              "vaultHealth": "ok"
            }
            """)
        ]

        let snapshot = try await RuntimeAPIClient(baseURL: runtimeBaseURL, session: stubbedSession).fetchWalletSnapshot()

        XCTAssertEqual(snapshot.config.evmAddress, "0x1234")
        XCTAssertEqual(snapshot.config.selectedRpcProviders?.bsc, "alchemy")
        XCTAssertEqual(snapshot.addresses.solanaAddress, "So111")
        XCTAssertEqual(snapshot.balances.evm?.chains.first?.nativeSymbol, "ETH")
        XCTAssertEqual(snapshot.steward.vaultHealth, "ok")
        XCTAssertEqual(
            Set(RuntimeURLProtocolStub.requestedPaths),
            ["/api/wallet/config", "/api/wallet/addresses", "/api/wallet/balances", "/api/wallet/steward-status"]
        )
    }

    private var runtimeBaseURL: URL {
        URL(string: "http://127.0.0.1:31337")!
    }

    private var stubbedSession: URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RuntimeURLProtocolStub.self]
        return URLSession(configuration: configuration)
    }
}

private final class RuntimeURLProtocolStub: URLProtocol {
    static var responses: [String: (status: Int, body: String)] = [:]
    static var requestedPaths: [String] = []

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: RuntimeAPIError.invalidBaseURL("missing URL"))
            return
        }

        Self.requestedPaths.append(url.path)
        let response = Self.responses[url.path] ?? (404, "{}")
        let data = Data(response.body.utf8)
        let httpResponse = HTTPURLResponse(
            url: url,
            statusCode: response.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!

        client?.urlProtocol(self, didReceive: httpResponse, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
