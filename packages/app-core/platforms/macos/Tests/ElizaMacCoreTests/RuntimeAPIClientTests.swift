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
