import Foundation

public enum RuntimeAPIError: Error, Equatable, LocalizedError {
    case invalidBaseURL(String)
    case invalidResponse(String)
    case httpStatus(Int, String)

    public var errorDescription: String? {
        switch self {
        case let .invalidBaseURL(value):
            "Invalid runtime API base URL: \(value)"
        case let .invalidResponse(path):
            "Runtime API returned a non-HTTP response for \(path)."
        case let .httpStatus(status, path):
            "Runtime API returned HTTP \(status) for \(path)."
        }
    }
}

public final class RuntimeAPIClient {
    private let baseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder

    public init(baseURL: URL, session: URLSession = .shared, decoder: JSONDecoder = JSONDecoder()) {
        self.baseURL = baseURL
        self.session = session
        self.decoder = decoder
    }

    public func fetchSnapshot() async throws -> RuntimeSnapshot {
        async let health = fetchHealth()
        async let agents = fetchAgents()
        async let logs = fetchLogs()

        return try await RuntimeSnapshot(
            health: health,
            agents: agents,
            logs: logs,
            fetchedAt: Date()
        )
    }

    public func fetchHealth() async throws -> RuntimeHealthSnapshot {
        try await request(RuntimeHealthSnapshot.self, path: "/api/health")
    }

    public func fetchAgents() async throws -> [RuntimeAgentSnapshot] {
        let response = try await request(RuntimeAgentsResponse.self, path: "/api/agents")
        return response.agents
    }

    public func fetchLogs() async throws -> RuntimeLogsResponse {
        try await request(RuntimeLogsResponse.self, path: "/api/logs")
    }

    private func request<Response: Decodable>(_ responseType: Response.Type, path: String) async throws -> Response {
        let endpoint = try endpoint(path: path)
        var request = URLRequest(url: endpoint)
        request.timeoutInterval = 5
        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw RuntimeAPIError.invalidResponse(path)
        }

        guard (200..<300).contains(httpResponse.statusCode) else {
            throw RuntimeAPIError.httpStatus(httpResponse.statusCode, path)
        }

        return try decoder.decode(responseType, from: data)
    }

    private func endpoint(path: String) throws -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw RuntimeAPIError.invalidBaseURL(baseURL.absoluteString)
        }

        let normalizedPath = path.hasPrefix("/") ? path : "/\(path)"
        let basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = basePath.isEmpty ? normalizedPath : "/\(basePath)\(normalizedPath)"
        components.queryItems = nil
        components.fragment = nil

        guard let url = components.url else {
            throw RuntimeAPIError.invalidBaseURL(baseURL.absoluteString)
        }

        return url
    }
}
