/** Proxies DoorDash MCP traffic to the operator-configured, user-isolated adapter. */

import { createMcpsTransportApp } from "../../../src/lib/mcp/mcps-transport-gateway";

export default createMcpsTransportApp("doordash");
