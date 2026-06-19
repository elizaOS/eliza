import type { Meta, StoryObj } from "@storybook/react";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import { DesktopWorkspaceDisplay } from "./DesktopWorkspaceDisplay";

const t = (key: string, options?: Record<string, unknown>) => {
  const labels: Record<string, string> = {
    "desktopworkspacesection.Diagnostics": "Diagnostics",
    "desktopworkspacesection.DiagnosticsDescription":
      "Runtime and environment details collected from this desktop workspace.",
  };
  return labels[key] ?? (options?.defaultValue as string) ?? key;
};

const populatedDiagnostics = `platform: darwin
arch: arm64
bunVersion: 1.1.30
renderer: native
display: 3024x1964 @2x
gpu: Apple M2 Pro
memory: 16 GB
agentStatus: running
apiBase: http://127.0.0.1:3000
uptime: 2h 14m`;

const meta = {
  title: "Settings/DesktopWorkspaceDisplay",
  component: DesktopWorkspaceDisplay,
  tags: ["autodocs"],
  decorators: [withMockApp],
  args: { t },
  parameters: { layout: "padded" },
} satisfies Meta<typeof DesktopWorkspaceDisplay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { diagnosticsText: populatedDiagnostics },
};

export const Empty: Story = {
  args: { diagnosticsText: "" },
};

export const ShortOutput: Story = {
  args: { diagnosticsText: "platform: linux\narch: x64" },
};

export const LongWrapping: Story = {
  args: {
    diagnosticsText: `apiBase: https://very-long-host.example.internal.cluster.local:8443/api/v1/diagnostics/desktop-workspace?verbose=true&includeEnv=true&token=abcdef0123456789abcdef0123456789
userAgent: Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Eliza/1.4.2 Safari/605.1.15`,
  },
};
