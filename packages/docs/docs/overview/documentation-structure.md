# ElizaOS Documentation Structure

This document outlines the two-track documentation system for ElizaOS, designed to serve both non-technical users and developers effectively.

## 📚 Two-Track Documentation System

ElizaOS documentation is organized into two distinct tracks:

### 🎯 Track 1: Simple Docs (Vibecoders)
**For:** Non-technical users, content creators, and those who want to run agents quickly  
**Goal:** Get users running agents in 5 minutes without understanding internals

### 🔧 Track 2: Technical Docs (Developers)
**For:** Developers, contributors, and those building on ElizaOS  
**Goal:** Deep technical understanding for extending and customizing ElizaOS

## 🗺️ Documentation Map

### Simple Track Structure
```
docs/simple/
├── getting-started/
│   ├── quick-start.md          # 5-minute setup guide
│   ├── first-agent.md          # Creating your first agent
│   └── troubleshooting.md      # Common issues & solutions
├── templates/
│   ├── gallery.md              # Pre-built agent templates
│   ├── customization.md        # Simple customization options
│   └── examples/               # Ready-to-use examples
├── guides/
│   ├── character-creation.md   # Visual character builder guide
│   ├── plugin-usage.md         # Using existing plugins
│   └── deployment.md           # Simple deployment options
└── faq.md                      # Non-technical FAQ
```

### Technical Track Structure
```
docs/technical/
├── architecture/
│   ├── overview.md             # System architecture
│   ├── core-concepts.md        # Deep dive into core concepts
│   ├── state-management.md     # State & memory systems
│   └── plugin-system.md        # Plugin architecture
├── development/
│   ├── monorepo-guide.md       # Monorepo development
│   ├── standalone-guide.md     # Standalone project setup
│   ├── plugin-development.md   # Creating custom plugins
│   └── testing-guide.md        # Testing strategies
├── api-reference/
│   ├── core-api.md            # Core API documentation
│   ├── plugin-api.md          # Plugin API reference
│   └── service-api.md         # Service layer APIs
├── advanced/
│   ├── performance.md         # Performance optimization
│   ├── scaling.md             # Scaling strategies
│   └── security.md            # Security best practices
└── faq.md                     # Technical FAQ
```

## 🚦 User Journey Paths

### Path 1: Quick Start (Non-Technical)
1. Landing page → "I want to run an agent"
2. 5-minute quick start guide
3. Template gallery selection
4. Simple customization
5. Running the agent

### Path 2: Developer Journey
1. Landing page → "I want to build with ElizaOS"
2. Architecture overview
3. Development environment setup
4. Core concepts understanding
5. Building custom features

## 📋 Content Guidelines

### Simple Track Guidelines
- Use plain language, avoid technical jargon
- Include visual guides and screenshots
- Provide copy-paste solutions
- Focus on "what" not "why"
- Maximum 5-minute read time per page

### Technical Track Guidelines
- Include architectural diagrams
- Provide code examples with explanations
- Deep dive into implementation details
- Include performance considerations
- Link to source code references

## 🔄 Migration Plan

### Phase 1: Structure Creation
- Create directory structure for both tracks
- Set up navigation system
- Create landing page with path selection

### Phase 2: Content Migration
- Audit existing documentation
- Categorize content by track
- Rewrite content for appropriate audience
- Create missing documentation

### Phase 3: Enhancement
- Add interactive examples
- Create video tutorials
- Implement feedback system
- Set up automated testing for code examples

## 📊 Success Metrics

### Simple Track Metrics
- Time to first successful agent run: < 5 minutes
- Support ticket reduction: 50%
- User satisfaction: > 90%

### Technical Track Metrics
- Developer onboarding time: < 1 hour
- Contribution quality improvement: 30%
- Documentation completeness: 100% API coverage

## 🚀 Next Steps

1. Create directory structure
2. Implement navigation system
3. Create landing page
4. Begin content migration
5. Gather user feedback
6. Iterate and improve