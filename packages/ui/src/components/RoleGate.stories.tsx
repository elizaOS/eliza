import type { RoleGateRole } from "@elizaos/core";
import type { Meta, StoryObj } from "@storybook/react";
import { RoleProvider, useRole } from "../hooks/useRole.tsx";
import { RoleGate } from "./RoleGate.tsx";

/**
 * Demonstrates the canonical UI role-gating primitive (#9948): one `RoleProvider`
 * at the shell, `<RoleGate minRole=…>` around developer/owner-only surfaces, and
 * `useRole()` for imperative checks.
 */
function Demo({ role }: { role: RoleGateRole }) {
  return (
    <RoleProvider role={role}>
      <RoleCard />
    </RoleProvider>
  );
}

function RoleCard() {
  const { role, isOwner, isAdmin } = useRole();
  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        color: "#e5e5e5",
        background: "#111",
        padding: 24,
        borderRadius: 12,
        width: 360,
      }}
    >
      <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 12 }}>
        current role: <strong style={{ color: "#ff5800" }}>{role}</strong> ·
        owner={String(isOwner)} · admin={String(isAdmin)}
      </div>
      <RoleGate
        minRole="USER"
        fallback={<Row label="Everyday settings" denied />}
      >
        <Row label="Everyday settings" />
      </RoleGate>
      <RoleGate minRole="ADMIN" fallback={<Row label="Admin tools" denied />}>
        <Row label="Admin tools" />
      </RoleGate>
      <RoleGate
        minRole="OWNER"
        fallback={<Row label="Wallet / API keys (developer)" denied />}
      >
        <Row label="Wallet / API keys (developer)" />
      </RoleGate>
    </div>
  );
}

function Row({ label, denied }: { label: string; denied?: boolean }) {
  return (
    <div
      style={{
        padding: "8px 12px",
        marginBottom: 6,
        borderRadius: 8,
        background: denied ? "#1a1a1a" : "#222",
        color: denied ? "#555" : "#e5e5e5",
        textDecoration: denied ? "line-through" : "none",
      }}
    >
      {label}
      {denied ? " — hidden" : ""}
    </div>
  );
}

const meta: Meta<typeof Demo> = {
  title: "Primitives/RoleGate",
  component: Demo,
};
export default meta;

type Story = StoryObj<typeof Demo>;

export const Owner: Story = { args: { role: "OWNER" } };
export const Admin: Story = { args: { role: "ADMIN" } };
export const User: Story = { args: { role: "USER" } };
export const Guest: Story = { args: { role: "GUEST" } };
