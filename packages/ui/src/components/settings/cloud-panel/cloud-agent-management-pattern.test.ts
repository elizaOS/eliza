/**
 * Verifies the structural ownership boundary for the shared cloud-agent lifecycle.
 * The two presentation adapters must delegate cloud mutations to one local pattern.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cloudPanelDirectory = fileURLToPath(new URL(".", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("cloud-agent management ownership", () => {
  it("keeps lifecycle mutations in one cloud-panel owner", () => {
    const owner = read("./cloud-agent-management-pattern.ts");
    const panelAdapter = read("./sections/AgentSection.tsx");
    const settingsAdapter = read("../CloudAgentsSection.tsx");

    expect(cloudPanelDirectory).toContain("cloud-panel");
    expect(owner).toContain("export function useCloudAgentManagement");
    expect(owner).toContain("client.selectOrProvisionCloudAgent");
    expect(owner).toContain("client.deleteCloudCompatAgent");
    expect(owner).toContain("client.suspendCloudCompatAgent");
    expect(owner).toContain("client.resumeCloudCompatAgent");

    for (const adapter of [panelAdapter, settingsAdapter]) {
      expect(adapter).toContain("useCloudAgentManagement");
      expect(adapter).not.toContain("client.selectOrProvisionCloudAgent");
      expect(adapter).not.toContain("client.deleteCloudCompatAgent");
      expect(adapter).not.toContain("client.suspendCloudCompatAgent");
      expect(adapter).not.toContain("client.resumeCloudCompatAgent");
    }
  });
});
