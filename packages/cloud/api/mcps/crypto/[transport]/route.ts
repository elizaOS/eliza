// Handles MCP cloud API mcps crypto transport route traffic with transport-specific auth expectations.
import { createMcpsTransportApp } from "@/api-app/lib/mcp/mcps-transport-gateway";

export default createMcpsTransportApp("crypto");
