# Agent client

What a consumer's renderer uses to talk to its agent: the request client,
its status cache, conversation selection and loading, the turn controller
and its Stop receipts, reply streaming, task lifecycle requests and the
negotiation of optional observation fields. The agent package exports this
client; each consumer supplies its own presentation.

- [Runtime client](./runtimeClient.md): JSON requests and account refresh
- [Status cache](./statusCache.md): reuse of a running bridge and the one `NOT_READY` retry
- [Conversation selection and loading](./conversationLoad.md)
- [Client conversation turns and Stop receipts](./conversation.md)
- [Reply streaming](./replyStreaming.md)
- [Task lifecycle requests](./taskLifecycle.md)
- [Observation support](./observationSupport.md)
