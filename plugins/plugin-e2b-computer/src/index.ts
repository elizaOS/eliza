import type { Plugin, Service } from "@elizaos/core";
import { runE2BCodeAction } from "./actions/run-code.js";
import { E2BComputerService } from "./services/e2b-sandbox.js";

export {
  createDryRunDriver,
  E2BComputerService,
  resolveE2BDriver,
} from "./services/e2b-sandbox.js";
export { readE2BConfig } from "./config.js";
export { runE2BCodeAction } from "./actions/run-code.js";

/** Service class adapter for runtime.registerService */
class E2BComputerServiceClass {
  static serviceType = E2BComputerService.serviceType;
  capabilityDescription = "E2B sandbox computer";
  private inner: E2BComputerService;

  constructor(runtime: { getSetting: (k: string) => string | undefined | null }) {
    this.inner = new E2BComputerService((k) => runtime.getSetting(k));
  }

  static async start(runtime: {
    getSetting: (k: string) => string | undefined | null;
  }): Promise<E2BComputerServiceClass> {
    const s = new E2BComputerServiceClass(runtime);
    await s.inner.start();
    return s;
  }

  async stop(): Promise<void> {
    await this.inner.stop();
  }

  getInner(): E2BComputerService {
    return this.inner;
  }
}

export const e2bComputerPlugin: Plugin = {
  name: "@elizaos/plugin-e2b-computer",
  description:
    "E2B sandbox computer — isolated Python code execution for Cheshire/eliza agents. Dry-run without E2B_API_KEY.",
  actions: [runE2BCodeAction],
  providers: [],
  // Cast: Service abstract class shape varies by core version; adapter matches start/stop contract
  services: [E2BComputerServiceClass as unknown as typeof Service],
};

export default e2bComputerPlugin;
