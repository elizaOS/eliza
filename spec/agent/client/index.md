# Agent client

What a consumer's renderer uses to talk to its agent. The agent package
exports this client; each consumer supplies its own presentation.

- [Runtime client](./runtimeClient.md): requests, account refresh, the
  running-bridge cache and the one `NOT_READY` retry
- [Conversation selection and loading](./conversationLoad.md)
- [Client conversation turns and Stop receipts](./conversation.md)
- [Reply streaming](./replyStreaming.md)
- [Task lifecycle requests](./taskLifecycle.md)
- [Observation support](./observationSupport.md)
- [Access walkthrough](./accessWalkthrough.md)
