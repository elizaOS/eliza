---
title: "RLM Plugin"
sidebarTitle: "RLM"
description: "RLM (Recursive Language Model) plugin for Eliza — enables processing of arbitrary length input contexts."
---

The RLM plugin extends Eliza agents with the ability to process arbitrary length input contexts using recursive language model techniques.

**Package:** `@elizaos/plugin-rlm`

## Overview

RLM (Recursive Language Model) addresses the context window limitation of standard language models by recursively processing long inputs. This plugin integrates RLM capabilities into the elizaOS runtime, allowing agents to reason over documents and conversations that exceed typical context limits.

The plugin breaks long inputs into manageable segments, processes each recursively, and synthesizes a coherent result. This enables agents to work with full documents, lengthy conversation histories, and large datasets that would otherwise be truncated.

## Installation

```bash
eliza plugins install rlm
```

## Configuration

No environment variables or configuration required. The plugin works out of the box once installed.

## Usage

Once installed, the RLM plugin activates automatically when an agent receives input that exceeds the underlying model's context window. No special invocation is needed — the recursive processing is transparent to both the agent and the user.

This is particularly useful for document analysis, long conversation threads, and large codebases.
