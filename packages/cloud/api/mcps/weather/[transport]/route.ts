// Handles MCP cloud API mcps weather transport route traffic with transport-specific auth expectations.
import { createMcpsTransportApp } from "@/api-app/lib/mcp/mcps-transport-gateway";

export default createMcpsTransportApp("weather");
