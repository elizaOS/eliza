---
title: Eliza Council
---

# Eliza Council

## Meeting 12-16-24

Here are the key notes from the Eliza Framework Council meeting:

Current Status & Priorities:

- The team has recently moved to a develop branch for better stability, with unstable code going to develop first before being reviewed and merged to main
- Current focus is on stability and reducing open PRs/issues
- Main branch is now more stable - cloning main should "just work" on any given day

Version 2 (V2) Plans:

- Major architectural changes planned for V2 including:
    - Unified message bus for better cross-client communication
    - Unified wallet abstraction to handle multiple chains/providers
    - Event-driven architecture for better plugin extensibility
    - Moving plugins to a community repo with standards for core plugins
    - Simplified client code (reducing to ~200 lines per client)
    - CLI tool for easier setup and plugin management
    - Improved developer experience targeting "5 minutes to get running"
    - Moving model providers to plugins
    - Better secrets management

Development Strategy:

- Will maintain V1 and V2 development simultaneously:
    - V1 team focusing on stability, merging PRs, documentation
    - V2 team working on new architecture and features
- Need to balance maintaining momentum/community engagement while improving architecture
- Plan to create CLI tool similar to "create-react-app" for easier project setup
- Considering moving from PNPM to Bun or Deno for better developer experience

Security & Infrastructure:

- Need better security reviews for PRs, especially for Web3-related code
- Planning to implement better secrets management (possibly using Doppler)
- Considering multiple staging environments (alpha, beta, develop, main)
- Discussion of using AWS Secrets Manager for credentials

Community & Documentation:

- Need better documentation for deployment processes
- Planning to add minimum spec requirements to readme
- Will create better guidelines for contributing
- Working on improving plugin discovery and distribution
- Next Agent Dev School will focus on deployment

Next Steps:

1. Continue focus on V1 stability
2. Document deployment processes
3. Begin V2 development with separate teams
4. Create CLI tool
5. Implement better security practices

The meeting highlighted the balance between maintaining current momentum while building a more robust foundation for the future.
