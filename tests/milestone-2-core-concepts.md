# Milestone 2: Core Concepts - Understanding the Basics

This milestone tests the core conceptual documentation to ensure a user can understand the fundamental building blocks of ElizaOS.

## 1. Project System (`core/project.md`)
- [ ] **Verify Project Structure Diagram**: Check that the ASCII diagram of the project structure is accurate.
- [ ] **Verify File Explanations**: Read through the "Key Directories and Files Explained" section and confirm that the descriptions match the reality of a newly created project.
- [ ] **Verify Configuration Example**: Check the `Project` configuration TypeScript example for correctness and clarity.

## 2. Character System (`core/characters.md`)
- [ ] **Verify Core Structure**: Compare the documented `Character` interface with the actual type definition in `packages/core/src/types/agent.ts`.
- [ ] **Test Message Examples**: Create a character file using the "Advanced Example" and ensure an agent can run with it.
- [ ] **Test `settings` object**: Create a character with custom settings (e.g., `ragKnowledge: true`) and verify the agent respects them at runtime.
- [ ] **Verify Migration Guide**: Take an old-format character file and follow the migration guide steps to update it.

## 3. Actions (`core/actions.md`)
- [ ] **Verify `Action` Interface**: Compare the documented interface with the definition in `packages/core/src/types/components.ts`.
- [ ] **Test Basic Action Template**: Copy the "Basic Action Template" into a new plugin, register it, and verify the agent can execute it.
- [ ] **Test `REPLY` Action Example**: Review the deep dive on the `REPLY` action and confirm its logic is still current with the source code.

## 4. Providers (`core/providers.md`)
- [ ] **Verify `Provider` Interface**: Compare the documented interface with the definition in `packages/core/src/types/components.ts`.
- [ ] **Test `timeProvider` Example**: Implement the `timeProvider` example in a plugin and verify it correctly injects the time.
- [ ] **Test `weatherProvider` Example**: Implement the `weatherProvider` and confirm it functions as described.

## 5. Evaluators (`core/evaluators.md`)
- [ ] **Verify `Evaluator` Interface**: Compare the documented interface with the definition in `packages/core/src/types/components.ts`.
- [ ] **Test Custom Evaluator Example**: Implement the `customEvaluator` example and verify it runs after a message is processed.

## 6. Services (`core/services.md`)
- [ ] **Verify `Service` Implementation**: Check the example `CustomService` for correctness against the `Service` class in `packages/core`.
- [ ] **Test `getService`**: Write a simple action that uses `runtime.getService()` to access a registered service.

## 7. Plugins (`core/plugins.md`)
- [ ] **Verify `Plugin` Interface**: Compare the documented interface with the definition in `packages/core`.
- [ ] **Test Plugin Structure Diagram**: Create a new plugin with `elizaos create -t plugin` and verify its structure matches the documentation. 