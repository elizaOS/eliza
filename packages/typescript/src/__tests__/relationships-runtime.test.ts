import { afterEach, describe, expect, it, vi } from "vitest";
import { addContactAction } from "../advanced-capabilities/actions/addContact.ts";
import { removeContactAction } from "../advanced-capabilities/actions/removeContact.ts";
import { scheduleFollowUpAction } from "../advanced-capabilities/actions/scheduleFollowUp.ts";
import { searchContactsAction } from "../advanced-capabilities/actions/searchContacts.ts";
import { updateContactAction } from "../advanced-capabilities/actions/updateContact.ts";
import { contactsProvider } from "../advanced-capabilities/providers/contacts.ts";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter.ts";
import { AgentRuntime } from "../runtime.ts";
import type { RelationshipsService } from "../services/relationships.ts";
import type { Memory, State } from "../types/index.ts";
import { asUUID, ModelType } from "../types/index.ts";
import { stringToUuid } from "../utils.ts";

const agentId = asUUID("91000000-0000-0000-0000-000000000001");
const senderId = asUUID("91000000-0000-0000-0000-000000000002");
const roomId = asUUID("91000000-0000-0000-0000-000000000003");
const contactId = asUUID("91000000-0000-0000-0000-000000000010");
const relationshipsWorldId = stringToUuid(`relationships-world-${agentId}`);
const unrelatedWorldId = asUUID("91000000-0000-0000-0000-000000000020");
const unrelatedRoomId = asUUID("91000000-0000-0000-0000-000000000021");

function createRuntime(adapter: InMemoryDatabaseAdapter): AgentRuntime {
	return new AgentRuntime({
		agentId,
		character: {
			id: agentId,
			name: "Relationships Runtime Test Agent",
			username: "relationships-runtime-test-agent",
			clients: [],
			settings: {},
		},
		adapter,
		enableKnowledge: false,
		enableTrajectories: false,
	});
}

function createMessage(
	id: string,
	text: string,
	messageRoomId: typeof roomId = roomId,
): Memory {
	return {
		id: asUUID(id),
		entityId: senderId,
		roomId: messageRoomId,
		content: {
			text,
		},
	};
}

function createState(): State {
	return {
		values: {},
		data: {},
		text: "",
	};
}

const runtimes: AgentRuntime[] = [];

afterEach(async () => {
	await Promise.all(
		runtimes.splice(0).map(async (runtime) => {
			await runtime.stop();
		}),
	);
});

describe("relationships runtime integration", () => {
	it("reloads stored contacts after restart using the real in-memory adapter", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const firstRuntime = createRuntime(adapter);
		runtimes.push(firstRuntime);

		await firstRuntime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});
		await firstRuntime.getServiceLoadPromise("relationships");
		await firstRuntime.createEntity({
			id: contactId,
			names: ["Mira"],
		});

		const relationshipsService = firstRuntime.getService(
			"relationships",
		) as RelationshipsService;
		await relationshipsService.addContact(contactId, ["friend"], undefined, {
			displayName: "Mira",
		});

		const secondRuntime = createRuntime(adapter);
		runtimes.push(secondRuntime);

		await secondRuntime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});
		await secondRuntime.getServiceLoadPromise("relationships");

		const reloadedRelationships = secondRuntime.getService(
			"relationships",
		) as RelationshipsService;
		const reloadedContact = await reloadedRelationships.getContact(contactId);
		const providerResult = await contactsProvider.get(
			secondRuntime,
			createMessage("91000000-0000-0000-0000-000000000101", "show contacts"),
			createState(),
		);

		expect(reloadedContact).toMatchObject({
			entityId: contactId,
			categories: ["friend"],
		});
		expect(
			await reloadedRelationships.searchContacts({ searchTerm: "mira" }),
		).toHaveLength(1);
		expect(providerResult.text).toContain("Mira");
	});

	it("keeps rolodex lookups scoped to the synthetic relationships world", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const firstRuntime = createRuntime(adapter);
		runtimes.push(firstRuntime);

		await firstRuntime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});
		await firstRuntime.getServiceLoadPromise("relationships");
		await firstRuntime.createEntity({
			id: contactId,
			names: ["Ada"],
		});
		await firstRuntime.createComponent({
			id: asUUID("91000000-0000-0000-0000-000000000022"),
			type: "contact_info",
			agentId,
			entityId: contactId,
			roomId: unrelatedRoomId,
			worldId: unrelatedWorldId,
			sourceEntityId: agentId,
			createdAt: Date.now() - 1000,
			data: {
				entityId: contactId,
				categories: ["colleague"],
				tags: ["legacy"],
				preferences: {},
				customFields: {
					displayName: "Wrong Ada",
				},
				privacyLevel: "public",
				lastModified: "2026-04-08T00:00:00.000Z",
			},
		});

		const firstRelationships = firstRuntime.getService(
			"relationships",
		) as RelationshipsService;
		await firstRelationships.addContact(contactId, ["friend"], undefined, {
			displayName: "Ada",
		});

		const secondRuntime = createRuntime(adapter);
		runtimes.push(secondRuntime);

		await secondRuntime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});
		await secondRuntime.getServiceLoadPromise("relationships");

		const reloadedRelationships = secondRuntime.getService(
			"relationships",
		) as RelationshipsService;
		const reloadedContact = await reloadedRelationships.getContact(contactId);
		const searchByEntityId = await reloadedRelationships.searchContacts({
			searchTerm: String(contactId),
		});

		expect(reloadedContact).toMatchObject({
			entityId: contactId,
			categories: ["friend"],
			customFields: {
				displayName: "Ada",
			},
		});
		expect(searchByEntityId).toHaveLength(1);

		await reloadedRelationships.updateContact(contactId, {
			tags: ["vip"],
		});
		const storedRelationshipsComponent = await secondRuntime.getComponent(
			contactId,
			"contact_info",
			relationshipsWorldId,
			agentId,
		);
		const unrelatedComponent = await secondRuntime.getComponent(
			contactId,
			"contact_info",
			unrelatedWorldId,
			agentId,
		);

		expect(storedRelationshipsComponent?.data).toMatchObject({
			categories: ["friend"],
			tags: ["vip"],
			customFields: {
				displayName: "Ada",
			},
		});
		expect(unrelatedComponent?.data).toMatchObject({
			categories: ["colleague"],
			tags: ["legacy"],
			customFields: {
				displayName: "Wrong Ada",
			},
		});

		await reloadedRelationships.removeContact(contactId);
		expect(
			await secondRuntime.getComponent(
				contactId,
				"contact_info",
				relationshipsWorldId,
				agentId,
			),
		).toBeNull();
		expect(
			await secondRuntime.getComponent(
				contactId,
				"contact_info",
				unrelatedWorldId,
				agentId,
			),
		).not.toBeNull();
	});

	it("creates entities for new contacts so add, provider, search, and follow-up flows resolve by name", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const runtime = createRuntime(adapter);
		runtimes.push(runtime);

		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});
		await runtime.getServiceLoadPromise("relationships");
		await runtime.getServiceLoadPromise("follow_up");

		const modelResponses = [
			`<response><contactName>Ada</contactName><entityId>${contactId}</entityId><categories>friend</categories></response>`,
			"<response><contactName>Ada</contactName><scheduledAt>2026-04-10T10:00:00.000Z</scheduledAt><reason>Check in</reason><priority>high</priority></response>",
			"<response><searchTerm>Ada</searchTerm><intent>list</intent></response>",
		];
		const modelHandler = vi.fn(async () => modelResponses.shift() ?? "");
		runtime.registerModel(ModelType.TEXT_SMALL, modelHandler, "mock");

		const addResult = await addContactAction.handler(
			runtime,
			createMessage(
				"91000000-0000-0000-0000-000000000111",
				"add Ada to my contacts",
			),
			createState(),
		);

		const createdEntity = await runtime.getEntityById(contactId);
		const relationshipsService = runtime.getService(
			"relationships",
		) as RelationshipsService;
		const createdContact = await relationshipsService.getContact(contactId);
		const providerResult = await contactsProvider.get(
			runtime,
			createMessage("91000000-0000-0000-0000-000000000112", "show contacts"),
			createState(),
		);
		const getRoomSpy = vi.spyOn(runtime, "getRoom");
		const followUpResult = await scheduleFollowUpAction.handler(
			runtime,
			createMessage(
				"91000000-0000-0000-0000-000000000113",
				"schedule a follow up with Ada tomorrow",
				asUUID("91000000-0000-0000-0000-000000000099"),
			),
			createState(),
		);
		const searchResult = await searchContactsAction.handler(
			runtime,
			createMessage(
				"91000000-0000-0000-0000-000000000114",
				"find Ada in my contacts",
			),
			createState(),
		);
		const followUpTasks = await runtime.getTasks({
			entityId: runtime.agentId,
			tags: ["follow-up"],
			agentIds: [runtime.agentId],
		});

		expect(addResult.success).toBe(true);
		expect(createdEntity?.names?.[0]).toBe("Ada");
		expect(createdContact?.customFields.displayName).toBe("Ada");
		expect(providerResult.text).toContain("Ada");
		expect(followUpResult?.success).toBe(true);
		expect(followUpResult?.data?.contactId).toBe(contactId);
		expect(followUpTasks).toHaveLength(1);
		expect(getRoomSpy).not.toHaveBeenCalled();
		expect(searchResult?.success).toBe(true);
		expect(searchResult?.text).toContain("Ada");
		expect(searchResult?.data?.contacts).toEqual([
			expect.objectContaining({
				id: contactId,
				name: "Ada",
			}),
		]);
		expect(modelHandler).toHaveBeenCalledTimes(3);
	});

	it("removes categories, tags, preferences, and custom fields instead of replacing them when requested", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const runtime = createRuntime(adapter);
		runtimes.push(runtime);

		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});
		await runtime.getServiceLoadPromise("relationships");

		await runtime.createEntity({
			id: contactId,
			names: ["Ada"],
		});

		const relationshipsService = runtime.getService(
			"relationships",
		) as RelationshipsService;
		await relationshipsService.addContact(
			contactId,
			["friend", "vip"],
			{ timezone: "UTC", language: "en" },
			{
				displayName: "Ada",
				nickname: "Addy",
			},
		);
		await relationshipsService.updateContact(contactId, {
			tags: ["bookclub", "close"],
		});

		runtime.registerModel(
			ModelType.TEXT_SMALL,
			vi.fn(async () =>
				[
					"<response>",
					"<contactName>Ada</contactName>",
					"<operation>remove_from</operation>",
					"<categories>vip</categories>",
					"<tags>bookclub</tags>",
					"<preferences>timezone:remove</preferences>",
					"<customFields>nickname:remove</customFields>",
					"</response>",
				].join(""),
			),
			"mock",
		);

		const result = await updateContactAction.handler(
			runtime,
			createMessage(
				"91000000-0000-0000-0000-000000000115",
				"remove vip, bookclub, timezone, and nickname from Ada",
			),
			createState(),
		);
		const updatedContact = await relationshipsService.getContact(contactId);

		expect(result?.success).toBe(true);
		expect(updatedContact).toMatchObject({
			entityId: contactId,
			categories: ["friend"],
			tags: ["close"],
			preferences: { language: "en" },
		});
		expect(updatedContact?.customFields).toMatchObject({
			displayName: "Ada",
		});
		expect(updatedContact?.customFields.nickname).toBeUndefined();
	});

	it("removes contacts through the action flow and clears them from search/provider output", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const runtime = createRuntime(adapter);
		runtimes.push(runtime);

		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});
		await runtime.getServiceLoadPromise("relationships");

		await runtime.createEntity({
			id: contactId,
			names: ["Ada"],
		});

		const relationshipsService = runtime.getService(
			"relationships",
		) as RelationshipsService;
		await relationshipsService.addContact(contactId, ["friend"], undefined, {
			displayName: "Ada",
		});

		runtime.registerModel(
			ModelType.TEXT_SMALL,
			vi.fn(async () =>
				[
					"<response>",
					"<contactName>Ada</contactName>",
					"<confirmed>yes</confirmed>",
					"</response>",
				].join(""),
			),
			"mock",
		);

		const result = await removeContactAction.handler(
			runtime,
			createMessage("91000000-0000-0000-0000-000000000116", "yes, remove Ada"),
			createState(),
		);
		const removedContact = await relationshipsService.getContact(contactId);
		const providerResult = await contactsProvider.get(
			runtime,
			createMessage("91000000-0000-0000-0000-000000000117", "show contacts"),
			createState(),
		);

		expect(result?.success).toBe(true);
		expect(removedContact).toBeNull();
		expect(
			await relationshipsService.searchContacts({ searchTerm: "Ada" }),
		).toHaveLength(0);
		expect(providerResult.text).toContain("No contacts in relationships.");
	});

	it("enforces contact privacy rules for agent, owner, and third parties", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const runtime = createRuntime(adapter);
		runtimes.push(runtime);

		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});
		await runtime.getServiceLoadPromise("relationships");

		await runtime.createEntity({
			id: contactId,
			names: ["Ada"],
		});

		const relationshipsService = runtime.getService(
			"relationships",
		) as RelationshipsService;
		const outsiderId = asUUID("91000000-0000-0000-0000-000000000222");
		await relationshipsService.addContact(contactId, ["friend"], undefined, {
			displayName: "Ada",
		});

		await relationshipsService.setContactPrivacy(contactId, "public");
		expect(
			await relationshipsService.canAccessContact(outsiderId, contactId),
		).toBe(true);

		await relationshipsService.setContactPrivacy(contactId, "private");
		expect(
			await relationshipsService.canAccessContact(runtime.agentId, contactId),
		).toBe(true);
		expect(
			await relationshipsService.canAccessContact(contactId, contactId),
		).toBe(true);
		expect(
			await relationshipsService.canAccessContact(outsiderId, contactId),
		).toBe(false);

		await relationshipsService.setContactPrivacy(contactId, "restricted");
		expect(
			await relationshipsService.canAccessContact(runtime.agentId, contactId),
		).toBe(true);
		expect(
			await relationshipsService.canAccessContact(contactId, contactId),
		).toBe(false);
		expect(
			await relationshipsService.canAccessContact(outsiderId, contactId),
		).toBe(false);
	});
});
