import { useState } from "react";
import { Activity, Cloud, Cpu, Zap } from "lucide-react";

import type { StoryDefinition } from "../Story.tsx";

import { BrandButton } from "@ui-src/cloud-ui/components/brand/brand-button.tsx";
import { BrandCard, AgentCard } from "@ui-src/cloud-ui/components/brand/brand-card.tsx";
import {
  BrandTabs,
  BrandTabsContent,
  BrandTabsList,
  BrandTabsTrigger,
  SimpleBrandTabs,
} from "@ui-src/cloud-ui/components/brand/brand-tabs.tsx";
import {
  BrandTabsResponsive,
  type TabItem,
} from "@ui-src/cloud-ui/components/brand/brand-tabs-responsive.tsx";
import { CornerBrackets } from "@ui-src/cloud-ui/components/brand/corner-brackets.tsx";
import { DashboardSection } from "@ui-src/cloud-ui/components/brand/dashboard-section.tsx";
import { DashboardStatCard } from "@ui-src/cloud-ui/components/brand/dashboard-stat-card.tsx";
import { ElizaCloudLockup } from "@ui-src/cloud-ui/components/brand/eliza-cloud-lockup.tsx";
import { ElizaLogo } from "@ui-src/cloud-ui/components/brand/eliza-logo.tsx";
import { HUDContainer } from "@ui-src/cloud-ui/components/brand/hud-container.tsx";
import {
  KeyMetricsGrid,
  type KeyMetric,
} from "@ui-src/cloud-ui/components/brand/key-metrics-grid.tsx";
import { LockOnButton } from "@ui-src/cloud-ui/components/brand/lock-on-button.tsx";
import { MiniStatCard } from "@ui-src/cloud-ui/components/brand/mini-stat-card.tsx";
import { PromptCard, PromptCardGrid } from "@ui-src/cloud-ui/components/brand/prompt-card.tsx";
import {
  SectionHeader,
  SectionLabel,
} from "@ui-src/cloud-ui/components/brand/section-header.tsx";

const sampleMetrics: KeyMetric[] = [
  {
    label: "Local inference",
    value: "1.2k tok/s",
    helper: "eliza-1 on Metal",
    delta: { value: "+18%", trend: "up", label: "vs last run" },
    icon: Cpu,
    accent: "violet",
  },
  {
    label: "Cloud spend",
    value: "$0.42",
    helper: "today",
    delta: { value: "-7%", trend: "down" },
    icon: Cloud,
    accent: "sky",
  },
  {
    label: "Active agents",
    value: "3",
    icon: Activity,
    accent: "emerald",
  },
];

const tabItems: TabItem[] = [
  { value: "local", label: "Local" },
  { value: "cloud", label: "Cloud" },
  { value: "mobile", label: "Mobile" },
];

function ResponsiveTabsExample({ id }: { id: string }) {
  const [value, setValue] = useState("local");
  return (
    <BrandTabsResponsive id={id} tabs={tabItems} value={value} onValueChange={setValue}>
      <BrandTabsContent value="local">Runs on this device.</BrandTabsContent>
      <BrandTabsContent value="cloud">Routed through Eliza Cloud.</BrandTabsContent>
      <BrandTabsContent value="mobile">iOS / Android agent.</BrandTabsContent>
    </BrandTabsResponsive>
  );
}

function SimpleTabsExample() {
  const [active, setActive] = useState("All");
  return (
    <SimpleBrandTabs
      tabs={["All", "Local", "Cloud", "Mobile"]}
      activeTab={active}
      onTabChange={setActive}
    />
  );
}

export const brandStories: StoryDefinition[] = [
  {
    name: "BrandButton",
    importPath: 'import { BrandButton } from "@elizaos/ui/cloud-ui/components/brand/brand-button"',
    render: () => (
      <>
        <BrandButton>Run in Cloud</BrandButton>
        <BrandButton variant="ghost">Cancel</BrandButton>
        <BrandButton variant="outline">Install elizaOS</BrandButton>
        <BrandButton variant="icon" aria-label="settings">
          <Zap />
        </BrandButton>
        <BrandButton size="sm">Small</BrandButton>
        <BrandButton size="lg">Large</BrandButton>
        <BrandButton disabled>Disabled</BrandButton>
      </>
    ),
  },
  {
    name: "BrandCard",
    importPath: 'import { BrandCard, AgentCard } from "@elizaos/ui/cloud-ui/components/brand/brand-card"',
    render: () => (
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "1fr 1fr", width: "100%" }}>
        <BrandCard hover>
          <h4 style={{ color: "#fff", margin: 0, marginBottom: 8 }}>Local Inference</h4>
          <p style={{ color: "rgba(255,255,255,.6)", margin: 0, fontSize: 13 }}>
            Connected.
          </p>
        </BrandCard>
        <AgentCard
          title="Eliza-1"
          description="Default local model."
          icon={<Cpu />}
          color="#FF5800"
          action={<BrandButton size="sm">Load</BrandButton>}
        />
      </div>
    ),
  },
  {
    name: "BrandTabs",
    importPath: 'import { BrandTabs, BrandTabsList, BrandTabsTrigger, BrandTabsContent } from "@elizaos/ui/cloud-ui/components/brand/brand-tabs"',
    render: () => (
      <BrandTabs defaultValue="local" style={{ width: 360 }}>
        <BrandTabsList>
          <BrandTabsTrigger value="local">Local</BrandTabsTrigger>
          <BrandTabsTrigger value="cloud">Cloud</BrandTabsTrigger>
        </BrandTabsList>
        <BrandTabsContent value="local">Runs on this device.</BrandTabsContent>
        <BrandTabsContent value="cloud">Routed through Eliza Cloud.</BrandTabsContent>
      </BrandTabs>
    ),
  },
  {
    name: "SimpleBrandTabs",
    importPath: 'import { SimpleBrandTabs } from "@elizaos/ui/cloud-ui/components/brand/brand-tabs"',
    render: () => <SimpleTabsExample />,
  },
  {
    name: "BrandTabsResponsive",
    importPath: 'import { BrandTabsResponsive } from "@elizaos/ui/cloud-ui/components/brand/brand-tabs-responsive"',
    render: () => <ResponsiveTabsExample id="story-brand-tabs-responsive" />,
  },
  {
    name: "CornerBrackets",
    importPath: 'import { CornerBrackets } from "@elizaos/ui/cloud-ui/components/brand/corner-brackets"',
    render: () => (
      <div
        style={{
          position: "relative",
          width: 220,
          height: 100,
          border: "1px solid rgba(255,255,255,0.15)",
          background: "rgba(0,0,0,0.4)",
        }}
      >
        <CornerBrackets size="md" color="#FFFFFF" />
      </div>
    ),
  },
  {
    name: "DashboardSection",
    importPath: 'import { DashboardSection } from "@elizaos/ui/cloud-ui/components/brand/dashboard-section"',
    render: () => (
      <DashboardSection
        label="Inference"
        title="Local-first by default"
        description="Eliza-1 runs on your device. Cloud fills the gaps."
        action={<BrandButton size="sm">Configure</BrandButton>}
      />
    ),
  },
  {
    name: "DashboardStatCard",
    importPath: 'import { DashboardStatCard } from "@elizaos/ui/cloud-ui/components/brand/dashboard-stat-card"',
    render: () => (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, width: "100%" }}>
        <DashboardStatCard label="Status" value="Connected." accent="emerald" />
        <DashboardStatCard label="Today" value="$0.42" accent="orange" helper="Cloud spend" />
        <DashboardStatCard label="Agents" value={3} accent="blue" />
      </div>
    ),
  },
  {
    name: "ElizaCloudLockup",
    importPath: 'import { ElizaCloudLockup } from "@elizaos/ui/cloud-ui/components/brand/eliza-cloud-lockup"',
    render: () => <ElizaCloudLockup />,
  },
  {
    name: "ElizaLogo",
    importPath: 'import { ElizaLogo } from "@elizaos/ui/cloud-ui/components/brand/eliza-logo"',
    render: () => <ElizaLogo />,
  },
  {
    name: "HUDContainer",
    importPath: 'import { HUDContainer } from "@elizaos/ui/cloud-ui/components/brand/hud-container"',
    render: () => (
      <HUDContainer className="p-6" cornerSize="md">
        <p style={{ color: "#fff", margin: 0 }}>Install elizaOS</p>
      </HUDContainer>
    ),
  },
  {
    name: "KeyMetricsGrid",
    importPath: 'import { KeyMetricsGrid } from "@elizaos/ui/cloud-ui/components/brand/key-metrics-grid"',
    render: () => (
      <div style={{ width: "100%" }}>
        <KeyMetricsGrid metrics={sampleMetrics} columns={3} />
      </div>
    ),
  },
  {
    name: "LockOnButton",
    importPath: 'import { LockOnButton } from "@elizaos/ui/cloud-ui/components/brand/lock-on-button"',
    render: () => (
      <>
        <LockOnButton variant="primary">Lock on</LockOnButton>
        <LockOnButton variant="outline">Outline</LockOnButton>
        <LockOnButton variant="ghost">Ghost</LockOnButton>
        <LockOnButton variant="hud" icon={<Zap />}>
          HUD
        </LockOnButton>
        <LockOnButton size="sm">Small</LockOnButton>
        <LockOnButton size="lg">Large</LockOnButton>
        <LockOnButton disabled>Disabled</LockOnButton>
      </>
    ),
  },
  {
    name: "MiniStatCard",
    importPath: 'import { MiniStatCard } from "@elizaos/ui/cloud-ui/components/brand/mini-stat-card"',
    render: () => (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        <MiniStatCard label="Tok/s" value="1.2k" />
        <MiniStatCard label="Models" value="4" color="text-[#FF5800]" />
        <MiniStatCard label="Agents" value="3" />
      </div>
    ),
  },
  {
    name: "PromptCard + PromptCardGrid",
    importPath: 'import { PromptCard, PromptCardGrid } from "@elizaos/ui/cloud-ui/components/brand/prompt-card"',
    render: () => (
      <div style={{ width: "100%" }}>
        <PromptCardGrid
          prompts={[
            "Run a local benchmark",
            "Connect Eliza Cloud",
            "Install a new model",
            "Spawn a coding agent",
          ]}
        />
        <div style={{ marginTop: 16, maxWidth: 320 }}>
          <PromptCard prompt="Standalone prompt card" />
        </div>
      </div>
    ),
  },
  {
    name: "SectionHeader + SectionLabel",
    importPath: 'import { SectionHeader, SectionLabel } from "@elizaos/ui/cloud-ui/components/brand/section-header"',
    render: () => (
      <div style={{ display: "grid", gap: 16, width: "100%" }}>
        <SectionLabel>Connected.</SectionLabel>
        <SectionHeader
          label="Inference"
          title="Local-first."
          description="Eliza-1 ships on every device."
        />
      </div>
    ),
  },
];
