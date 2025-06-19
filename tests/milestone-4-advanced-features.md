# Milestone 4: Advanced Features - Power User Tools

This milestone tests advanced features and ensures power users can extend and deploy ElizaOS effectively.

## 1. Plugin System
- [ ] **Plugin Creation**: Create a new plugin using `elizaos create -t plugin`.
- [ ] **Local Installation**: Install the local plugin into a project (`elizaos plugins add ../path/to/plugin`).
- [ ] **Plugin Execution**: Verify the new plugin's actions/providers are available to the agent.
- [ ] **Plugin Publishing**: Run `elizaos publish --test` on the new plugin and verify it passes all checks.

## 2. REST API (`rest/` docs)
- [ ] **API Health Check**: Access the `/health` endpoint and verify a `200 OK` response.
- [ ] **List Agents**: Call the `GET /api/agents` endpoint and verify it returns a list of running agents.
- [ ] **Get Agent Details**: Call `GET /api/agents/{agentName}` and verify it returns the correct agent configuration.
- [ ] **Send Message**: Use `POST /api/messages` to send a message to an agent and verify it responds.
- [ ] **Authentication**: If API keys are enabled, test a request with and without a valid key.

## 3. TEE (Trusted Execution Environment) Projects
- [ ] **TEE Project Creation**: Run `elizaos create -t tee my-tee-project`.
- [ ] **Docker Build**: Run `docker-compose build` within the TEE project and verify it completes successfully.
- [ ] **Docker Run**: Run `docker-compose up` and verify the agent starts correctly within the container.
- [ ] **Secure Execution**: Test an action that requires a secret and verify it can be accessed securely within the TEE.

## 4. Knowledge & RAG (`core/knowledge.md`)
- [ ] **Create `knowledge` directory**: In a new project, create the `knowledge` directory.
- [ ] **Add a Document**: Add a simple `.txt` or `.md` file with a unique fact into the `knowledge` directory.
- [ ] **Enable RAG**: Ensure `ragKnowledge: true` is set in the character file.
- [ ] **Test Knowledge Retrieval**: Start the agent and ask it a question that can only be answered using the unique fact from your document. Verify it answers correctly. 