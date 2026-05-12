import { vi } from "vitest";

vi.mock("@elizaos/core", () => {
	class Service {
		public runtime: { getSetting: (key: string) => unknown } | undefined;
		constructor(runtime?: { getSetting: (key: string) => unknown }) {
			if (runtime) this.runtime = runtime;
		}
		static serviceType: string;
		capabilityDescription = "";
		async stop(): Promise<void> {}
		static async start(_runtime: unknown): Promise<unknown> {
			throw new Error("Service.start() must be implemented by subclass");
		}
	}

	return {
		Service,
		ServiceType: {
			REMOTE_FILES: "aws_s3",
		},
		logger: {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			log: vi.fn(),
			success: vi.fn(),
			warn: vi.fn(),
		},
	};
});
