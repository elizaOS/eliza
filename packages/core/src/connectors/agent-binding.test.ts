/**
 * Contract tests for projecting a runtime-scoped connector account into the
 * credential-free binding consumed by product connectors and policy code.
 */
import { describe, expect, it } from "vitest";
import type { UUID } from "../types";
import type { ConnectorAccount } from "./account-manager";
import { projectAgentConnectorBinding } from "./agent-binding";

describe("projectAgentConnectorBinding", () => {
	it("projects a direct credential-free binding without leaking credential metadata", () => {
		const agentId = "10000000-0000-0000-0000-000000000001" as UUID;
		const account = {
			id: "3a899cd0-170f-4b3e-932e-46ec68119b35",
			provider: "google",
			label: "Owner Google",
			role: "OWNER",
			purpose: ["reading", "automation"],
			accessGate: "manual_approval",
			status: "connected",
			externalId: "google-subject-1",
			displayHandle: "owner@example.com",
			ownerBindingId: "owner-binding-1",
			ownerIdentityId: "owner-identity-1",
			scopes: ["gmail.readonly", "calendar.readonly"],
			capabilities: ["google.gmail.search", "google.calendar.list"],
			selectedProducts: ["gmail", "calendar"],
			isDefault: true,
			createdAt: 10,
			updatedAt: 20,
			metadata: { vaultRef: "must-not-leak" },
		} satisfies ConnectorAccount;

		const binding = projectAgentConnectorBinding(agentId, account);

		expect(binding).toEqual({
			id: account.id,
			agentId,
			provider: "google",
			label: "Owner Google",
			role: "OWNER",
			purposes: ["reading", "automation"],
			accessGate: "manual_approval",
			status: "connected",
			selectedProducts: ["gmail", "calendar"],
			allowedCapabilities: ["google.gmail.search", "google.calendar.list"],
			grantedScopes: ["gmail.readonly", "calendar.readonly"],
			externalIdentity: {
				id: "google-subject-1",
				displayHandle: "owner@example.com",
			},
			ownerBinding: {
				id: "owner-binding-1",
				identityId: "owner-identity-1",
			},
			isDefault: true,
			createdAt: 10,
			updatedAt: 20,
		});
		expect(binding).not.toHaveProperty("metadata");
	});

	it("uses conservative local defaults for an existing connector account", () => {
		const agentId = "10000000-0000-0000-0000-000000000001" as UUID;
		const account = {
			id: "legacy-account",
			provider: "github",
			role: "AGENT",
			purpose: ["automation"],
			accessGate: "open",
			status: "connected",
			createdAt: 1,
			updatedAt: 2,
		} satisfies ConnectorAccount;

		expect(projectAgentConnectorBinding(agentId, account)).toMatchObject({
			selectedProducts: [],
			allowedCapabilities: [],
			grantedScopes: [],
			isDefault: false,
		});
		expect(projectAgentConnectorBinding(agentId, account)).not.toHaveProperty(
			"oauthMode",
		);
		expect(projectAgentConnectorBinding(agentId, account)).not.toHaveProperty(
			"executionTarget",
		);
	});
});
