---
title: Eliza Labs Builder Demo Tutorial Series - Firecrawl Plugin
description: A tutorial on building a Firecrawl plugin for ElizaOS, demonstrating how to create agents that can crawl and analyze on-chain data.
keywords: [eliza-os, builder-demo, tutorial, firecrawl, blockchain, data-analysis]
date: 2025-03-19
---

# Eliza Labs Builder Demo Tutorial Series: Firecrawl Plugin

<div className="responsive-iframe">
  <iframe
    src="https://www.youtube.com/embed/aLjq_wJNa08"
    title="YouTube video player"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
    allowFullScreen
  />
</div>

- Date: 2025-03-19
- YouTube Link: https://www.youtube.com/watch?v=aLjq_wJNa08

## Introduction [0:00-3:15]

- Welcome to Eliza Labs Builder Demo Tutorial Series
- Guest: Taby Lobba, Software Engineer and Developer Relations Engineer at Fleek
- Focus: Introduction to the Firecrawl plugin for Eliza agents

## Firecrawl Plugin Overview [3:15-7:40]

- **Purpose**: Empowers AI agents with web scraping and search capabilities
- **Core Functionality**: Extracts data from websites and returns it in LLM-readable format
- **Key Features**:
  - Web script reader for single webpages
  - Web crawling for multiple pages
  - Search functionality
  - Simplified website data extraction

## Technical Implementation [7:40-13:30]

- Built as a service wrapper around the Firecrawl API
- **Requirements**: Only needs a Firecrawl API key
- **Implementation Details**:
  - Actions for "get script" and search functionality
  - Includes similarity triggers to help Eliza identify when to use the plugin
  - Uses detailed descriptions and templates to help agents interpret responses
  - Converts JSON responses into readable formats

## Integration and Usage [13:30-16:30]

- Add the plugin to the character file
- Configure with Firecrawl API key
- Works with various model providers (demo shows OpenAI)
- Compatible with different clients (demo shows Discord)

## Use Cases [16:30-19:15]

- **Research agents**: Can gather and process information from the web
- **Domain expert agents**: AI experts, sports experts, etc.
- **Study agents**: Collecting and summarizing information
- The plugin results feed into the agent runtime, allowing it to adapt responses

## Complementary Tools [19:15-22:45]

- Taby mentioned the Composeo plugin as a complementary tool
- Composeo enables agents with additional actions and function calling:
  - Gmail integration
  - Google Calendar integration
  - GitHub actions (repo creation, forking)
- Combined with Firecrawl, it creates agents that can both gather information and take action based on that information

The presentation concludes with thanks and appreciation from the host.
