/**
 * Checked-in enforcement inventory for #23102 slice 1: the authoritative list
 * of privileged boundaries that the capability-grant system must eventually
 * enforce, with per-boundary status and owner. Slice 1 ships the inventory as
 * data; enforcement wiring (slices 2+) updates statuses here as boundaries
 * are connected to `authorizeCapability`. A test walks this list and fails
 * when a boundary is left unclassified, so no privileged boundary can
 * silently appear outside the inventory.
 */

import type { CapabilityBoundaryInventoryEntry } from "./types.ts";

export const CAPABILITY_BOUNDARY_INVENTORY: CapabilityBoundaryInventoryEntry[] =
	[
		{
			id: "connector.message.send",
			description:
				"Sending any outbound message through a connector account (channel/DM post).",
			status: "inventory-only",
			owner: null,
		},
		{
			id: "connector.account.read",
			description:
				"Reading a connector account's messages, presence, or membership.",
			status: "inventory-only",
			owner: null,
		},
		{
			id: "device.command",
			description:
				"Issuing a command to a paired device (smart home, remote runtime).",
			status: "inventory-only",
			owner: null,
		},
		{
			id: "filesystem.read",
			description: "Reading files from the host filesystem.",
			status: "inventory-only",
			owner: null,
		},
		{
			id: "filesystem.write",
			description: "Writing or deleting files on the host filesystem.",
			status: "inventory-only",
			owner: null,
		},
		{
			id: "shell.execute",
			description:
				"Executing a shell command (PTY) on the host or in a workspace sandbox.",
			status: "inventory-only",
			owner: null,
		},
		{
			id: "git.operation",
			description:
				"Running git mutations (commit, push, merge) on behalf of a principal.",
			status: "inventory-only",
			owner: null,
		},
		{
			id: "media.read",
			description:
				"Fetching or reading media/attachment bytes (content-addressed store).",
			status: "inventory-only",
			owner: null,
		},
		{
			id: "media.write",
			description:
				"Ingesting media/attachment bytes into the content-addressed store.",
			status: "inventory-only",
			owner: null,
		},
		{
			id: "provider.model.invoke",
			description:
				"Invoking a model/inference provider on behalf of a principal.",
			status: "inventory-only",
			owner: null,
		},
		{
			id: "api.route.admin",
			description:
				"Calling an administrative API route (settings, plugin, world management).",
			status: "inventory-only",
			owner: null,
		},
		{
			id: "coding.environment.use",
			description:
				"Using a coding environment or tool bridge (Claude Code, Codex) as the principal.",
			status: "inventory-only",
			owner: null,
		},
	];
