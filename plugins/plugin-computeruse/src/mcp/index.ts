/**
 * Computer-use MCP server seam (#9170). Public surface:
 *  - the pure tool catalog + dispatch (`tools.ts`),
 *  - the optional-SDK transport wiring (`server.ts`).
 */

export {
  connectComputerUseMcpStdio,
  createComputerUseMcpServer,
} from "./server.js";
export {
  COMPUTERUSE_MCP_TOOLS,
  type ComputerUseCommandRunner,
  type ComputerUseMcpTool,
  dispatchComputerUseMcpTool,
  findComputerUseMcpTool,
} from "./tools.js";
