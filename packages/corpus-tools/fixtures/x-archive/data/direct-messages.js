window.YTD.direct_messages.part0 = [
  {
    dmConversation: {
      conversationId: "7777-8888",
      messages: [
        {
          messageCreate: {
            id: "5001",
            senderId: "8888",
            recipientId: "7777",
            text: "synthetic inbound dm",
            createdAt: "2024-08-20T15:00:00.000Z",
          },
        },
        {
          messageCreate: {
            id: "5002",
            senderId: "7777",
            recipientId: "8888",
            text: "synthetic outbound dm reply",
            createdAt: "2024-08-20T15:05:00.000Z",
          },
        },
        {
          messageCreate: {
            id: "4000",
            senderId: "8888",
            recipientId: "7777",
            text: "synthetic pre-cutoff dm that must be dropped",
            createdAt: "2024-01-15T10:00:00.000Z",
          },
        },
      ],
    },
  },
  {
    dmConversation: {
      conversationId: "7777-9999",
      messages: [
        {
          messageCreate: {
            id: "5003",
            senderId: "7777",
            recipientId: "9999",
            text: "synthetic dm opening a second conversation",
            createdAt: "2024-09-05T08:00:00.000Z",
          },
        },
      ],
    },
  },
];
