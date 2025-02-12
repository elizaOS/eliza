import { formatPosts } from "../src/posts.ts";
import type { Actor, Memory } from "../src/types.ts";

// Mocked data with consistent conversation IDs
const mockActors: Actor[] = [
    {
        id: "f9c8b107-953b-473d-8c87-2894c6e3fe25",
        name: "Alice",
        username: "alice123",
    },
    {
        id: "e4928cd1-8007-40b1-93ff-7c5da3c39e36",
        name: "Bob",
        username: "bob456",
    },
    {
        id: "b62e64da-5699-4c8e-b58c-8d447b2f2014",
        name: "Charlie",
        username: "charlie789",
    },
];

const mockMessages: Memory[] = [
    {
        id: "0db429f4-9ad9-44db-b2c6-0cf6d6cb2dfe",
        userId: "f9c8b107-953b-473d-8c87-2894c6e3fe25",
        roomId: "aae8df56-e890-4876-a3ba-2cbfc94cbd97",
        createdAt: 2000,
        content: {
            text: "Hi Bob, how are you?",
            inReplyTo: "f9c8b107-953b-473d-8c87-2894c6e3fe25",
        },
        agentId: "f9c8b107-953b-473d-8c87-2894c6e3fe25",
    },
    {
        id: "cdb70b0f-bcfe-44ea-b940-1d7e7e981768",
        userId: "e4928cd1-8007-40b1-93ff-7c5da3c39e36",
        roomId: "aae8df56-e890-4876-a3ba-2cbfc94cbd97",
        createdAt: 2500,
        content: {
            text: "Hi Alice, how are you?",
            inReplyTo: "f9c8b107-953b-473d-8c87-2894c6e3fe25",
        },
        agentId: "e4928cd1-8007-40b1-93ff-7c5da3c39e36",
    },
    {
        id: "88297c98-3d95-4ab5-9c88-b7f01e10f7a7",
        userId: "b62e64da-5699-4c8e-b58c-8d447b2f2014",
        roomId: "c57bc580-dabf-4e56-9526-1ca1982f1d0c",
        createdAt: 1500,
        content: { text: "Hello, how’s it going?", inReplyTo: null },
        agentId: "b62e64da-5699-4c8e-b58c-8d447b2f2014",
    },
    {
        id: "f9c8f0f5-2aef-4a07-96d8-43b980cb7325",
        userId: "f9c8b107-953b-473d-8c87-2894c6e3fe25",
        roomId: "aae8df56-e890-4876-a3ba-2cbfc94cbd97",
        createdAt: 3000,
        content: {
            text: "Let’s catch up later.",
            inReplyTo: "e4928cd1-8007-40b1-93ff-7c5da3c39e36",
        },
        agentId: "f9c8b107-953b-473d-8c87-2894c6e3fe25",
    },
];

// Unit tests for formatPosts
test("formats posts correctly with conversation header", () => {
    const result = formatPosts({
        messages: mockMessages,
        actors: mockActors,
        conversationHeader: true,
    });

    expect(result).toContain("Name: Alice (@alice123)");
    expect(result).toContain("ID: 0db429f4-9ad9-44db-b2c6-0cf6d6cb2dfe");
    expect(result).toContain(
        "In reply to: f9c8b107-953b-473d-8c87-2894c6e3fe25"
    );
    expect(result).toContain("Text:\nHi Bob, how are you?");
});

test("formats posts correctly with multiple rooms", () => {
    const result = formatPosts({
        messages: mockMessages,
        actors: mockActors,
        conversationHeader: true,
    });

    expect(result).toContain("Name: Alice (@alice123)");
    expect(result).toContain("Text:\nHello, how’s it going?");
});

test("handles empty messages array", () => {
    const result = formatPosts({
        messages: [],
        actors: mockActors,
        conversationHeader: true,
    });

    expect(result).toBe("");
});
