public struct RuntimeCommand: Equatable, Sendable {
    public let executable: String
    public let arguments: [String]
    public let workingDirectory: String
    public let environment: [String: String]

    public init(
        executable: String,
        arguments: [String],
        workingDirectory: String,
        environment: [String: String]
    ) {
        self.executable = executable
        self.arguments = arguments
        self.workingDirectory = workingDirectory
        self.environment = environment
    }
}

public enum RuntimeCommandBuilder {
    public static func startCommand(
        configuration: RuntimeConfiguration,
        bunExecutable: String = BunExecutableResolver.resolve()
    ) -> RuntimeCommand {
        let usesEnv = bunExecutable == "/usr/bin/env"
        var environment = [
            "ELIZA_API_PORT": String(configuration.apiPort),
            "ELIZA_NAMESPACE": "eliza",
            "ELIZA_PORT": String(configuration.apiPort)
        ]

        if !configuration.userName.isEmpty {
            environment["ELIZA_USER_NAME"] = configuration.userName
            environment["ELIZA_PROFILE_NAME"] = configuration.userName
        }

        return RuntimeCommand(
            executable: bunExecutable,
            arguments: usesEnv ? ["bun", "run", "start"] : ["run", "start"],
            workingDirectory: configuration.repositoryRoot,
            environment: environment
        )
    }
}
