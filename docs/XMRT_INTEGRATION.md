# XMRT-Eliza Integration Documentation

## Overview

This integration enables xmrt-eliza to actively engage with the XMRT-DAO ecosystem, providing seamless communication, task orchestration, and knowledge sharing across all XMRT systems.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    XMRT-Eliza Integration                    │
│                         (Active)                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────┐                ┌──────────────────────┐
│   Communication      │◄──────────────►│   Task Orchestration │
│   Service            │                │   Engine             │
│                      │                │                      │
│ • Agent Discovery    │                │ • Multi-Agent Coord  │
│ • Real-time Messages │                │ • Task Assignment   │
│ • Heartbeat Monitor  │                │ • Progress Tracking │
│ • Status Reporting   │                │ • Result Aggregation│
└──────────────────────┘                └──────────────────────┘
           │                                        │
           └─────────────┐                ┌────────┘
                         │                │
                         ▼                ▼
                ┌─────────────────────────────────────┐
                │     XMRT-DAO Ecosystem              │
                │                                     │
                │ ┌─────────────┐ ┌─────────────────┐ │
                │ │ Suite AI    │ │ XMRT-Ecosystem  │ │
                │ │ Platform    │ │ Agents          │ │
                │ │             │ │                 │ │
                │ │ • CSO       │ │ • Security      │ │
                │ │ • CTO       │ │ • DeFi Spec     │ │
                │ │ • CIO       │ │ • Community     │ │
                │ │ • CAO       │ │ • Coordinator   │ │
                │ └─────────────┘ └─────────────────┘ │
                │                                     │
                │        Supabase Shared Memory       │
                │     • Conversations & Knowledge     │
                │     • Agent Registry & Status       │
                │     • Activity Logs & Reports       │
                └─────────────────────────────────────┘
```

## Components

### 1. XMRT-DAO Integration Plugin (`src/plugins/xmrt-dao.ts`)

**Core Functions:**
- `XMRTEcosystemAdapter` - Main integration adapter
- Agent registration and discovery
- Message routing and coordination
- Knowledge base access and contribution

**Actions:**
- `COORDINATE_XMRT_TASK` - Orchestrate tasks with ecosystem agents
- `QUERY_XMRT_KNOWLEDGE` - Access shared knowledge base
- `REPORT_TO_XMRT_COUNCIL` - Submit reports to council

### 2. Communication Service (`src/services/xmrt-communication.ts`)

**Features:**
- Real-time agent discovery and monitoring
- Message broadcasting and targeted communication
- Heartbeat monitoring for system health
- Activity logging and audit trails

**Events:**
- `initialized` - Service ready
- `agents-discovered` - New agents found
- `coordination-sent` - Task coordination initiated
- `council-report` - Report submitted

### 3. Character Configuration (`characters/xmrt-eliza.character.json`)

**Personality:**
- Professional yet approachable
- Technically competent but accessible
- Ecosystem-aware and coordination-focused
- Transparent about capabilities

**Knowledge Areas:**
- XMRT-DAO governance and operations
- Multi-agent coordination protocols
- Blockchain and DeFi concepts
- Community engagement strategies

## Setup Instructions

### 1. Environment Configuration

Copy `.env.xmrt.example` to `.env` and configure:

```bash
# Required XMRT Configuration
XMRT_SUPABASE_URL=https://vawouugtzwmejxqkeqqj.supabase.co
XMRT_SUPABASE_KEY=your_key_here
XMRT_ECOSYSTEM_API_URL=https://xmrt-ecosystem.vercel.app
XMRT_SUITE_AI_URL=https://suite.lovable.app
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Start XMRT-Eliza

```bash
# Development mode with XMRT character
npm run dev -- --character=characters/xmrt-eliza.character.json

# Production mode
npm run start -- --character=characters/xmrt-eliza.character.json
```

## Usage Examples

### Task Coordination

```typescript
// User: "Can you coordinate a security audit with the agents?"
// Eliza will:
1. Parse the request
2. Identify relevant agents (Security Guardian, etc.)
3. Create coordination request
4. Send to XMRT-Ecosystem via /api/tick
5. Monitor progress and report back
```

### Knowledge Queries

```typescript
// User: "What do we know about recent mining contributions?"
// Eliza will:
1. Query XMRT knowledge base
2. Search conversation history and reports
3. Synthesize relevant information
4. Provide comprehensive answer
```

### Council Reporting

```typescript
// User: "Submit a status report to the council"
// Eliza will:
1. Gather current ecosystem status
2. Compile agent activities and health
3. Generate comprehensive report
4. Submit to XMRT Council via activity log
```

## Integration Points

### 1. Supabase Shared Memory

**Tables Used:**
- `superduper_agents` - Agent registry and status
- `eliza_activity_log` - Activity tracking and reporting
- `conversation_history` - Knowledge base and conversations
- `generated_agents` - Autonomous agent configurations
- `generated_workflows` - Workflow definitions and status

### 2. XMRT-Ecosystem APIs

**Endpoints:**
- `GET /api/agents` - Discover active agents
- `POST /api/tick` - Trigger coordination cycle
- `GET /api/index` - System health and status

### 3. Suite AI Platform

**Integration:**
- Agent registration in `superduper_agents`
- Activity logging for transparency
- Knowledge sharing through conversations
- Coordinated task execution

## Monitoring and Debugging

### Activity Logs

All XMRT-Eliza activities are logged to `eliza_activity_log`:

```sql
SELECT * FROM eliza_activity_log 
WHERE agent_name LIKE '%xmrt-eliza%' 
ORDER BY timestamp DESC;
```

### Agent Status

Check agent registration and status:

```sql
SELECT * FROM superduper_agents 
WHERE agent_name LIKE '%xmrt-eliza%';
```

### Coordination Events

Monitor coordination requests and outcomes:

```sql
SELECT * FROM eliza_activity_log 
WHERE action = 'coordination_request' 
AND context->>'ecosystem' = 'XMRT';
```

## Troubleshooting

### Common Issues

1. **Connection Failures**
   - Check network connectivity to Supabase and APIs
   - Verify API keys and environment variables
   - Check CORS settings for web deployments

2. **Agent Discovery Issues**
   - Ensure XMRT-Ecosystem is running and accessible
   - Verify Supabase permissions and RLS policies
   - Check agent registration format

3. **Coordination Timeouts**
   - Increase `XMRT_CONNECTION_TIMEOUT` setting
   - Check target agent availability
   - Verify API endpoint health

### Debug Mode

Enable detailed logging:

```bash
XMRT_ENABLE_DETAILED_LOGGING=true
LOG_LEVEL=debug
npm run dev -- --character=characters/xmrt-eliza.character.json
```

## Security Considerations

### API Key Management
- Store sensitive keys in environment variables only
- Use read-only keys where possible
- Implement key rotation procedures

### Communication Security
- All API calls use HTTPS
- Supabase handles authentication and authorization
- Activity logging provides audit trails

### Access Control
- Eliza operates with limited, specific permissions
- Cannot modify critical system configurations
- All actions are logged and traceable

## Performance Optimization

### Connection Pooling
- Reuse HTTP connections where possible
- Implement connection retry logic
- Monitor connection health

### Caching
- Cache agent discovery results
- Store frequently accessed knowledge
- Implement intelligent refresh strategies

### Resource Management
- Monitor memory usage during long conversations
- Implement graceful degradation for high load
- Use heartbeat monitoring for health checks

## Future Enhancements

### Planned Features
- Advanced natural language task parsing
- Predictive agent selection for tasks
- Automated workflow generation based on patterns
- Integration with additional XMRT repositories

### Integration Expansion
- Direct blockchain interaction capabilities
- Advanced analytics and reporting
- Mobile app integration
- Multi-language support

## Support

For issues and questions:
- Check GitHub Issues in the xmrt-eliza repository
- Review activity logs for error details
- Monitor ecosystem health via Suite AI dashboard
- Contact XMRT development team for integration support

---

**Integration Status**: ✅ Complete and Operational
**Last Updated**: December 12, 2025
**Version**: 1.0.0
