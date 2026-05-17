@testable import ElizaMacCore
import Foundation
import XCTest

final class RuntimeAPIClientTests: XCTestCase {
    override func tearDown() {
        RuntimeURLProtocolStub.responses = [:]
        RuntimeURLProtocolStub.requestedPaths = []
        RuntimeURLProtocolStub.requestedMethods = []
        RuntimeURLProtocolStub.requestedRPCMethods = []
        RuntimeURLProtocolStub.requestBodies = []
        super.tearDown()
    }

    func testFetchSnapshotReadsHealthAgentsAndLogs() async throws {
        RuntimeURLProtocolStub.responses = [
            "runtime.health": (200, rpcEnvelope("""
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
            """)),
            "runtime.agents": (200, rpcEnvelope("""
            {
              "agents": [
                { "id": "main", "name": "Eliza", "status": "running" }
              ]
            }
            """)),
            "runtime.logs": (200, rpcEnvelope("""
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
            """))
        ]

        let snapshot = try await RuntimeAPIClient(baseURL: runtimeBaseURL, session: stubbedSession).fetchSnapshot()

        XCTAssertTrue(snapshot.health.ready)
        XCTAssertEqual(snapshot.health.plugins.loaded, 12)
        XCTAssertEqual(snapshot.health.connectors["discord"], "connected")
        XCTAssertEqual(snapshot.agents.first?.name, "Eliza")
        XCTAssertEqual(snapshot.logs.entries.first?.message, "runtime ready")
        XCTAssertEqual(Set(RuntimeURLProtocolStub.requestedPaths), ["/api/swift/rpc"])
        XCTAssertEqual(Set(RuntimeURLProtocolStub.requestedRPCMethods), ["runtime.health", "runtime.agents", "runtime.logs"])
    }

    func testHTTPFailureSurfacesStatusAndPath() async throws {
        RuntimeURLProtocolStub.responses = [
            "runtime.health": (200, """
            {
              "ok": false,
              "status": 503,
              "error": "runtime unavailable",
              "result": null
            }
            """)
        ]

        do {
            _ = try await RuntimeAPIClient(baseURL: runtimeBaseURL, session: stubbedSession).fetchHealth()
            XCTFail("Expected RuntimeAPIError.httpStatus")
        } catch let error as RuntimeAPIError {
            XCTAssertEqual(error, .httpStatus(503, "runtime.health"))
        }
    }

    func testFetchWalletSnapshotReadsRuntimeWalletRoutes() async throws {
        RuntimeURLProtocolStub.responses = [
            "wallet.config": (200, rpcEnvelope("""
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
            """)),
            "wallet.addresses": (200, rpcEnvelope("""
            {
              "evmAddress": "0x1234",
              "solanaAddress": "So111"
            }
            """)),
            "wallet.balances": (200, rpcEnvelope("""
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
            """)),
            "wallet.stewardStatus": (200, rpcEnvelope("""
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
            """))
        ]

        let snapshot = try await RuntimeAPIClient(baseURL: runtimeBaseURL, session: stubbedSession).fetchWalletSnapshot()

        XCTAssertEqual(snapshot.config.evmAddress, "0x1234")
        XCTAssertEqual(snapshot.config.selectedRpcProviders?.bsc, "alchemy")
        XCTAssertEqual(snapshot.addresses.solanaAddress, "So111")
        XCTAssertEqual(snapshot.balances.evm?.chains.first?.nativeSymbol, "ETH")
        XCTAssertEqual(snapshot.steward.vaultHealth, "ok")
        XCTAssertEqual(Set(RuntimeURLProtocolStub.requestedPaths), ["/api/swift/rpc"])
        XCTAssertEqual(Set(RuntimeURLProtocolStub.requestedRPCMethods), ["wallet.config", "wallet.addresses", "wallet.balances", "wallet.stewardStatus"])
    }

    func testFetchRuntimeSetupSnapshotReadsPermissionsAndModes() async throws {
        RuntimeURLProtocolStub.responses = [
            "permissions.list": (200, rpcEnvelope("""
            {
              "accessibility": {
                "id": "accessibility",
                "status": "granted",
                "lastChecked": 1760000000000,
                "canRequest": true,
                "platform": "darwin"
              },
              "screen-recording": {
                "id": "screen-recording",
                "status": "denied",
                "lastChecked": 1760000000001,
                "canRequest": true,
                "platform": "darwin",
                "reason": "User has not granted Screen Recording."
              },
              "shell": {
                "id": "shell",
                "status": "granted",
                "lastChecked": 1760000000002,
                "canRequest": false,
                "platform": "darwin"
              },
              "_platform": "darwin",
              "_shellEnabled": true
            }
            """)),
            "permissions.automationMode": (200, rpcEnvelope("""
            {
              "mode": "full",
              "options": ["connectors-only", "full"]
            }
            """)),
            "permissions.tradeMode": (200, rpcEnvelope("""
            {
              "tradePermissionMode": "manual-local-key",
              "canUserLocalExecute": true,
              "canAgentAutoTrade": false
            }
            """))
        ]

        let snapshot = try await RuntimeAPIClient(baseURL: runtimeBaseURL, session: stubbedSession).fetchRuntimeSetupSnapshot()

        XCTAssertEqual(snapshot.permissions.platform, "darwin")
        XCTAssertTrue(snapshot.permissions.shellEnabled)
        XCTAssertEqual(snapshot.permissions.permissions["accessibility"]?.status, "granted")
        XCTAssertEqual(snapshot.permissions.permissions["screen-recording"]?.reason, "User has not granted Screen Recording.")
        XCTAssertEqual(snapshot.automationMode.mode, "full")
        XCTAssertEqual(snapshot.tradeMode.tradePermissionMode, "manual-local-key")
        XCTAssertTrue(snapshot.tradeMode.canUserLocalExecute)
        XCTAssertEqual(Set(RuntimeURLProtocolStub.requestedPaths), ["/api/swift/rpc"])
        XCTAssertEqual(Set(RuntimeURLProtocolStub.requestedRPCMethods), ["permissions.list", "permissions.automationMode", "permissions.tradeMode"])
    }

    func testCreateConversationAndSendMessageUseNativeRuntimeRoutes() async throws {
        RuntimeURLProtocolStub.responses = [
            "conversation.create": (200, rpcEnvelope("""
            {
              "conversation": {
                "id": "conv-1",
                "title": "Chat with Ada",
                "roomId": "room-1",
                "metadata": { "scope": "general", "pageId": "macos-chat" },
                "createdAt": "2026-05-17T00:00:00.000Z",
                "updatedAt": "2026-05-17T00:00:00.000Z"
              }
            }
            """)),
            "conversation.send": (200, rpcEnvelope("""
            {
              "text": "Hello Ada",
              "agentName": "Eliza"
            }
            """))
        ]

        let client = RuntimeAPIClient(baseURL: runtimeBaseURL, session: stubbedSession)
        let conversation = try await client.createConversation(title: "Chat with Ada")
        let reply = try await client.sendConversationMessage(
            conversationID: conversation.conversation.id,
            text: "Hello",
            userName: "Ada"
        )

        XCTAssertEqual(conversation.conversation.id, "conv-1")
        XCTAssertEqual(reply.text, "Hello Ada")
        XCTAssertEqual(RuntimeURLProtocolStub.requestedPaths, ["/api/swift/rpc", "/api/swift/rpc"])
        XCTAssertEqual(RuntimeURLProtocolStub.requestedMethods, ["POST", "POST"])
        XCTAssertEqual(RuntimeURLProtocolStub.requestedRPCMethods, ["conversation.create", "conversation.send"])
        XCTAssertTrue(RuntimeURLProtocolStub.requestBodies[0].contains("\"pageId\":\"macos-chat\""))
        XCTAssertTrue(RuntimeURLProtocolStub.requestBodies[0].contains("\"method\":\"conversation.create\""))
        XCTAssertTrue(RuntimeURLProtocolStub.requestBodies[1].contains("\"conversationID\":\"conv-1\""))
        XCTAssertTrue(RuntimeURLProtocolStub.requestBodies[1].contains("\"source\":\"swift-macos\""))
        XCTAssertTrue(RuntimeURLProtocolStub.requestBodies[1].contains("\"userName\":\"Ada\""))
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
    static var requestedMethods: [String] = []
    static var requestedRPCMethods: [String] = []
    static var requestBodies: [String] = []

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
        Self.requestedMethods.append(request.httpMethod ?? "GET")
        let bodyText = Self.requestBodyText(from: request)
        Self.requestBodies.append(bodyText)
        let rpcMethod = Self.rpcMethod(from: bodyText)
        if let rpcMethod {
            Self.requestedRPCMethods.append(rpcMethod)
        }
        let response = Self.responses[rpcMethod ?? url.path] ?? (404, "{}")
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

    private static func requestBodyText(from request: URLRequest) -> String {
        if let body = request.httpBody, let text = String(data: body, encoding: .utf8) {
            return text
        }

        guard let stream = request.httpBodyStream else {
            return ""
        }

        stream.open()
        defer {
            stream.close()
        }

        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 {
                break
            }
            data.append(buffer, count: read)
        }
        return String(data: data, encoding: .utf8) ?? ""
    }

    private static func rpcMethod(from body: String) -> String? {
        guard let data = body.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return object["method"] as? String
    }
}

private func rpcEnvelope(_ result: String) -> String {
    """
    {
      "ok": true,
      "status": 200,
      "result": \(result)
    }
    """
}
