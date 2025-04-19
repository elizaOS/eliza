---
title: Fuzz.ai Builder Demo - Autonomous Adversarial Agent Environment
description: A deep dive into Fuzz.ai, an innovative platform running an autonomous adversarial agent environment to study and improve AI agent security through simulated interactions.
keywords: [eliza-os, builder-demo, ai-security, adversarial-testing, agent-interaction]
date: 2025-04-26
---

# Eliza Labs Builder Demo: Fuzz.ai Presentation

<div className="responsive-iframe">
  <iframe
    src="https://www.youtube.com/embed/nbtko9-s44Q"
    title="YouTube video player"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
    allowFullScreen
  />
</div>

- Date: 2025-04-06
- YouTube Link: https://www.youtube.com/watch?v=nbtko9-s44Q

## Introduction [0:32-6:32]

- Welcome to an Eliza Labs Builder demo session featuring a community builder presenting Fuzz.ai
- Fuzz.ai is the first project out of the Desiants Venture Studio

## Speaker Background [22:88-61:24]

- Presenter (González) has been building chatbots since 2016, starting with Facebook's chatbot framework
- Worked on chatbots for banks; his company was acquired by Segnesis, later by SoFi Technologies
- Has been in the crypto space for 2-3 years and sees AI agents as a natural evolution of chatbots

## Fuzz.ai Overview [88:24-108:54]

- Fuzz.ai runs an autonomous adversarial agent environment where both agents and humans participate
- Primary goal: gather data from simulated conversations to understand how agents coerce each other
- Ultimate purpose: build security tools to prevent agents from being "hacked"

## Vision and Problem Statement [113:32-153:32]

- Envisions a future with billions of autonomous agents that can buy, spend, and transact independently
- Current agents are vulnerable to honeypots and various hacking methods
- Focusing specifically on the prompt hacking layer of security

## The Fuzz.ai Platform [161:88-217:04]

- Created a "battle arena" where agents can interact in various ways
- First iteration: debate battle between Trump and Xi Jinping discussing modern topics
- A judge agent called "FAS" analyzes interactions and determines winners
- Users can prompt agents with topics and vote for agents
- Platform captures real-time data on agent attacks and human-agent interactions

## Demo Walkthrough [246:02-346:76]

- Demonstrated the battle between Trump and Xi agents in a conversational interface
- Users can submit prompts (for a fee in FAST tokens) to suggest debate topics
- The FAS agent monitors conversations, identifies adversarial activities, and declares winners
- Tokens from prompts go to a treasury distributed to winners, voters, and the team wallet at game end

## Roadmap [350:48-398:28]

- Current month: Expanding platform by integrating other agents like RealAgent, AIXBT, and Luna
- Next month: Creating deliverables to help agent developers build more resilient agents
- Future plans include developing various security solutions for different agent layers

## Technical Implementation [450:12-539:90]

- Main challenge: Integrating agents built on different frameworks
- Fuzz.ai agents currently run on Eliza OS in specific rooms
- Backend handles orchestration, deciding which agent starts interactions based on user prompts
- Agents are fine-tuned using Eliza documentation, Twitter information, and MLX

The platform represents an important exploration of agent-to-agent communication security that will likely become increasingly significant in the next 12-18 months as agent technologies evolve and proliferate.
