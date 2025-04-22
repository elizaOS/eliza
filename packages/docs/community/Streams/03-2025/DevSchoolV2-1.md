---
title: 'Dev School V2 Session 1: Introduction to ElizaOS v1.0.0-beta'
description: 'A comprehensive introduction to ElizaOS v1.0.0-beta (V2), covering basic usage, project creation, plugin development, and codebase contribution.'
date: 2025-03-25
authors: [team]
keywords:
  [dev school, v2, tutorial, introduction, development, beta, plugin development, project creation]
---

# Eliza OS v1.0.0-beta (V2) Introduction

<div className="responsive-iframe">
  <iframe
    src="https://www.youtube.com/embed/ArptLpQiKfI"
    title="YouTube video player"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
    allowFullScreen
  />
</div>

- Date: 2025-03-25
- YouTube Link: https://www.youtube.com/watch?v=ArptLpQiKfI

## Overview

[2:10-45:18] The presentation introduces Eliza OS v1.0.0-beta (also referred to as V2), which represents a complete overhaul of the system compared to the previous version. The speaker explains that the previous version was essentially a research project that tested hypotheses, while this new version addresses many missing pieces and improves the overall developer and user experience.

## Four User Perspectives Covered

[56:18-121:98] The presentation covers four different perspectives for using Eliza OS:

1. Basic user who wants to use an agent without programming
2. Plugin developer updating from previous version
3. Advanced user building custom projects
4. Contributor who wants to improve the Eliza OS codebase

## Getting Started with Basic Usage

[247:12-359:82] The simplest way to get started is using the CLI:

- Command: `npx elizos-cli@beta start` (or without @beta in future releases)
- This starts the system and launches a dashboard where users can create and interact with agents
- Creating a new agent is done through a simple interface where you can define personality, interests, and tone

## Creating Projects

[599:54-702:92] For those wanting to build applications or customized agents:

- Command: `npm create eliza@beta`
- Choose between PG Light (local) or Postgres database
- Creates a project structure with source files, data folder, and test plugin
- Character files are now TypeScript instead of JSON for better error handling and dynamic loading

## Plugin Development

[1078:32-1130:48] For plugin developers:

- Same initial command: `npm create eliza@beta`
- Select "plugin" instead of "project"
- Creates a plugin structure with actions, providers, and services
- Plugins can be published to the registry with `npx elizos publish`

## Contributing to the Codebase

[1286:66-1353:00] For contributors:

- Clone the repository: `git clone https://github.com/eliza-/eliza`
- Checkout the v2-develop branch: `git checkout v2-develop`
- Use `bun install` instead of npm install for workspace management
- Codebase organized into sections: app, CLI, client, core, etc.

## New Technical Features

[2104:52-2263:70] Key technical improvements include:

- Dynamic runtime provider system (replacing the hardcoded approach)
- Multi-action decision-making (agents can perform sequences of actions)
- Simplified API with most functionality accessible through the runtime
- All model services moved to plugins for greater flexibility
- New entity system replacing the previous accounts system

## Upcoming Features

[364:42-380:96] Features coming soon include:

- Multi-agent chat rooms
- Support for all models from the previous version
- Downloadable desktop application
- MCP (presumably Model Control Protocol) support in next two weeks

The presentation emphasizes that this is a beta release with some bugs still being addressed, but the team wanted to get the new version into users' hands as quickly as possible.
