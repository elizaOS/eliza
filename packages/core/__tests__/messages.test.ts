import {
    formatActors,
    formatMessages,
    getActorDetails,
    formatTimestamp,
} from "../src/messages.ts";
import type { IAgentRuntime, Actor, Content, Memory, UUID } from "../src/types.ts";
import { describe, test, expect, vi, beforeAll } from "vitest";

describe("Messages Library", () => {
    let runtime: IAgentRuntime;
    let actors: Actor[];
    let userId: UUID;

    beforeAll(() => {
        // Mock runtime with necessary methods
        runtime = {
            databaseAdapter: {
                // Using vi.fn() instead of jest.fn()
                getParticipantsForRoom: vi.fn(),
                getAccountById: vi.fn(),
            },
        } as unknown as IAgentRuntime;

        // Mock user data with proper UUID format
        userId = "123e4567-e89b-12d3-a456-426614174000" as UUID;
        actors = [
            {
                id: userId,
                name: "Test User",
                username: "testuser",
            },
        ];
    });

    test("getActorDetails should return actors based on roomId", async () => {
        const roomId: UUID = "123e4567-e89b-12d3-a456-426614174001" as UUID;

        // Using vi.mocked() type assertion instead of jest.Mock casting
        vi.mocked(
            runtime.databaseAdapter.getParticipantsForRoom
        ).mockResolvedValue([userId]);
        vi.mocked(runtime.databaseAdapter.getAccountById).mockResolvedValue({
            id: userId,
            name: "Test User",
            username: "testuser",
        });

        const result = await getActorDetails({ runtime, roomId });

        expect(result.length).toBeGreaterThan(0);
        expect(result[0].name).toBe("Test User");
    });

    test("formatActors should format actors into a readable string", () => {
        const formattedActors = formatActors({ actors });

        expect(formattedActors).toContain("Test User");
        expect(formattedActors).toContain("A test user");
        expect(formattedActors).toContain(
            "This is a test user for the system."
        );
    });

    test("formatMessages should format messages into a readable string", () => {
        const messages: Memory[] = [
            {
                content: { text: "Hello, world!" } as Content,
                userId: userId,
                roomId: "123e4567-e89b-12d3-a456-426614174002" as UUID,
                createdAt: new Date().getTime(),
                agentId: "" as UUID, // assuming agentId is an empty string here
            },
        ];

        const formattedMessages = formatMessages({ messages, actors });

        // Assertions
        expect(formattedMessages).toContain("Hello, world!");
        expect(formattedMessages).toContain("Test User");
    });

    test("formatTimestamp should return correct time string", () => {
        const timestamp = new Date().getTime() - 60000; // 1 minute ago
        const result = formatTimestamp(timestamp);

        // Assertions
        expect(result).toBe("1 minute ago");
    });

    test("formatMessages should include attachments if present", () => {
        const messages: Memory[] = [
            {
                content: {
                    text: "Check this attachment",
                    attachments: [
                        {
                            id: "123e4567-e89b-12d3-a456-426614174003" as UUID,
                            title: "Image",
                            url: "http://example.com/image.jpg",
                        },
                    ],
                } as Content,
                userId: userId,
                roomId: "123e4567-e89b-12d3-a456-426614174004" as UUID,
                createdAt: new Date().getTime(),
                agentId: "" as UUID, // assuming agentId is an empty string here
            },
        ];

        const formattedMessages = formatMessages({ messages, actors });

        // Assertions
        expect(formattedMessages).toContain("Check this attachment");
        expect(formattedMessages).toContain("Attachments: [");
    });

    test("formatMessages should handle empty attachments gracefully", () => {
        const messages: Memory[] = [
            {
                content: {
                    text: "No attachments here",
                } as Content,
                userId: userId,
                roomId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
                createdAt: new Date().getTime(),
                agentId: "" as UUID, // assuming agentId is an empty string here
            },
        ];

        const formattedMessages = formatMessages({ messages, actors });

        // Assertions
        expect(formattedMessages).toContain("No attachments here");
        expect(formattedMessages).not.toContain("Attachments");
    });
});

describe("Messages", () => {
    const mockActors: Actor[] = [
        {
            id: "123e4567-e89b-12d3-a456-426614174006" as UUID,
            name: "Alice",
            username: "alice",
        },
        {
            id: "123e4567-e89b-12d3-a456-426614174007" as UUID,
            name: "Bob",
            username: "bob",
        },
    ];

    const mockMessages: Memory[] = [
        {
            id: "123e4567-e89b-12d3-a456-426614174008" as UUID,
            roomId: "123e4567-e89b-12d3-a456-426614174009" as UUID,
            userId: mockActors[0].id,
            createdAt: Date.now() - 5000, // 5 seconds ago
            content: {
                text: "Hello everyone!",
                action: "wave",
            } as Content,
            agentId: "123e4567-e89b-12d3-a456-426614174001",
        },
        {
            id: "123e4567-e89b-12d3-a456-426614174010" as UUID,
            roomId: "123e4567-e89b-12d3-a456-426614174009" as UUID,
            userId: mockActors[1].id,
            createdAt: Date.now() - 60000, // 1 minute ago
            content: {
                text: "Hi Alice!",
                attachments: [
                    {
                        id: "123e4567-e89b-12d3-a456-426614174011" as UUID,
                        title: "Document",
                        url: "https://example.com/doc.pdf",
                    },
                ],
            } as Content,
            agentId: "123e4567-e89b-12d3-a456-426614174001",
        },
    ];

    describe("getActorDetails", () => {
        it("should retrieve actor details from database", async () => {
            const mockRuntime = {
                databaseAdapter: {
                    getParticipantsForRoom: vi
                        .fn()
                        .mockResolvedValue([
                            mockActors[0].id,
                            mockActors[1].id,
                        ]),
                    getAccountById: vi.fn().mockImplementation((id) => {
                        const actor = mockActors.find((a) => a.id === id);
                        return Promise.resolve(actor);
                    }),
                },
            };

            const actors = await getActorDetails({
                runtime: mockRuntime as any,
                roomId: "123e4567-e89b-12d3-a456-426614174009" as UUID,
            });

            expect(actors).toHaveLength(2);
            expect(actors[0].name).toBe("Alice");
            expect(actors[1].name).toBe("Bob");
            expect(
                mockRuntime.databaseAdapter.getParticipantsForRoom
            ).toHaveBeenCalled();
        });

        it("should filter out null actors", async () => {
            const invalidId = "123e4567-e89b-12d3-a456-426614174012" as UUID;
            const mockRuntime = {
                databaseAdapter: {
                    getParticipantsForRoom: vi
                        .fn()
                        .mockResolvedValue([mockActors[0].id, invalidId]),
                    getAccountById: vi.fn().mockImplementation((id) => {
                        const actor = mockActors.find((a) => a.id === id);
                        return Promise.resolve(actor || null);
                    }),
                },
            };

            const actors = await getActorDetails({
                runtime: mockRuntime as any,
                roomId: "123e4567-e89b-12d3-a456-426614174009" as UUID,
            });

            expect(actors).toHaveLength(1);
            expect(actors[0].name).toBe("Alice");
        });
    });

    describe("formatActors", () => {
        it("should format actors with complete details", () => {
            const formatted = formatActors({ actors: mockActors });
            expect(formatted).toContain("Alice: Software Engineer");
            expect(formatted).toContain(
                "Full-stack developer with 5 years experience"
            );
            expect(formatted).toContain("Bob: Product Manager");
            expect(formatted).toContain("Experienced in agile methodologies");
        });

        it("should handle actors without details", () => {
            const actorsWithoutDetails: Actor[] = [
                {
                    id: "123e4567-e89b-12d3-a456-426614174013" as UUID,
                    name: "Charlie",
                    username: "charlie",
                },
            ];
            const formatted = formatActors({ actors: actorsWithoutDetails });
            expect(formatted).toBe("Charlie: Tag\nSummary");
        });

        it("should handle empty actors array", () => {
            const formatted = formatActors({ actors: [] });
            expect(formatted).toBe("");
        });
    });

    describe("formatMessages", () => {
        it("should format messages with all details", () => {
            const formatted = formatMessages({
                messages: mockMessages,
                actors: mockActors,
            });
            const lines = formatted.split("\n");
            expect(lines[1]).toContain("Alice");
            expect(lines[1]).toContain("(wave)");
            expect(lines[1]).toContain("(just now)");
        });

        it("should handle messages from unknown users", () => {
            const messagesWithUnknownUser: Memory[] = [
                {
                    id: "123e4567-e89b-12d3-a456-426614174014" as UUID,
                    roomId: "123e4567-e89b-12d3-a456-426614174009" as UUID,
                    userId: "123e4567-e89b-12d3-a456-426614174015" as UUID,
                    createdAt: Date.now(),
                    content: { text: "Test message" } as Content,
                    agentId: "123e4567-e89b-12d3-a456-426614174001",
                },
            ];

            const formatted = formatMessages({
                messages: messagesWithUnknownUser,
                actors: mockActors,
            });
            expect(formatted).toContain("Unknown User: Test message");
        });

        it("should handle messages with no action", () => {
            const messagesWithoutAction: Memory[] = [
                {
                    id: "123e4567-e89b-12d3-a456-426614174016" as UUID,
                    roomId: "123e4567-e89b-12d3-a456-426614174009" as UUID,
                    userId: mockActors[0].id,
                    createdAt: Date.now(),
                    content: { text: "Simple message" } as Content,
                    agentId: "123e4567-e89b-12d3-a456-426614174001",
                },
            ];

            const formatted = formatMessages({
                messages: messagesWithoutAction,
                actors: mockActors,
            });
            expect(formatted).not.toContain("()");
            expect(formatted).toContain("Simple message");
        });

        it("should handle empty messages array", () => {
            const formatted = formatMessages({
                messages: [],
                actors: mockActors,
            });
            expect(formatted).toBe("");
        });
    });

    describe("formatTimestamp", () => {
        it("should handle exact time boundaries", () => {
            const now = Date.now();
            expect(formatTimestamp(now)).toContain("just now");
        });
    });
});
