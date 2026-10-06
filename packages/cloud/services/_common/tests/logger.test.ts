import { afterEach, expect, spyOn, test } from "bun:test";
import { createServiceLogger } from "../src/logger";

const originalLevel = process.env.LOG_LEVEL;
afterEach(() => {
  if (originalLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLevel;
});

test("structured diagnostics preserve errors and tolerate cycles and bigint while redacting credentials", () => {
  const sink = spyOn(console, "error").mockImplementation(() => {});
  try {
    process.env.LOG_LEVEL = "debug";
    const metadata: Record<string, unknown> = {
      error: new Error("failed", { cause: new Error("upstream") }),
      count: 3n,
      credentials: { apiKey: "secret-value" },
    };
    metadata.self = metadata;
    createServiceLogger().error("operation failed", metadata);
    const entry = JSON.parse(String(sink.mock.calls[0][0]));
    expect(entry.error.message).toBe("failed");
    expect(entry.error.cause.message).toBe("upstream");
    expect(entry.count).toBe("3");
    expect(JSON.stringify(entry)).not.toContain("secret-value");
    expect(JSON.stringify(entry)).toContain("[Circular]");
    expect(entry.level).toBe("error");
  } finally {
    sink.mockRestore();
  }
});

test("existing field precedence and dynamic level filtering remain compatible", () => {
  const sink = spyOn(console, "log").mockImplementation(() => {});
  try {
    process.env.LOG_LEVEL = "error";
    const logger = createServiceLogger();
    logger.info("hidden");
    expect(sink).not.toHaveBeenCalled();
    process.env.LOG_LEVEL = "info";
    logger.info("base", { message: "metadata" });
    createServiceLogger({ metaFirst: true }).info("base", {
      message: "metadata",
    });
    expect(JSON.parse(String(sink.mock.calls[0][0])).message).toBe("metadata");
    expect(JSON.parse(String(sink.mock.calls[1][0])).message).toBe("base");
  } finally {
    sink.mockRestore();
  }
});
