# @elizaos/plugin-di - Dependency Injection Plugin for Eliza

## Purpose

This plugin provides a dependency injection system for Eliza plugins, enabling decoupling of components for more modular and testable code.

## Key Features

- Dependency injection for actions, evaluators, providers, services, and clients
- Decorators: @injectable, @inject (from inversify), and @property
- Abstract classes: BaseInjectableAction and BaseInjectableEvaluator

## Integration

Uses the inversify library to provide the dependency injection system. Components must be registered with the global container before injection, either as singletons or request-scoped instances.

## Example Usage

Examples are available in the \_examples/plugin-with-di/ folder, demonstrating DI in actions, evaluators, providers, and services.

## Links

Documentation references examples at: ../\_examples/plugin-with-di/
