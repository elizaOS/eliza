# @elizaos/plugin-rolodex

A comprehensive contact and relationship management plugin for ElizaOS agents, providing CRM-like capabilities with automated follow-ups, relationship analytics, and cross-platform identity management.

## Features

### 🗂️ Contact Management

- Add and categorize contacts (friends, family, colleagues, VIPs, etc.)
- Store contact preferences (timezone, language, communication preferences)
- Tag contacts for easy organization
- Privacy controls (public, private, restricted)

### 📅 Follow-up Scheduling

- Schedule reminders to follow up with contacts
- Automated follow-up suggestions based on relationship patterns
- Recurring check-ins with priority levels
- Integration with ElizaOS task system

### 🔍 Intelligent Search

- Search contacts by name, category, or tags
- List specific groups (e.g., "show me all my VIP contacts")
- Filter by privacy level

### 📊 Relationship Analytics

- Track interaction frequency and patterns
- Calculate relationship strength scores
- Identify relationships that need attention
- Average response time tracking
- Topic analysis from conversations

### 🌐 Cross-Platform Identity Resolution

- Unified contact view across all platforms
- Behavioral pattern matching
- Confidence-based entity resolution

## Installation

```bash
npm install @elizaos/plugin-rolodex
```

## Configuration

Add the plugin to your ElizaOS agent configuration:

```typescript
import { rolodexPlugin } from '@elizaos/plugin-rolodex';

const agent = new Agent({
  plugins: [rolodexPlugin],
  // ... other configuration
});
```

## Usage

### Actions

#### ADD_CONTACT

Add a new contact to your rolodex:

- "Add John Smith to my contacts as a colleague"
- "Save this person as a friend in my rolodex"
- "Remember Alice as a VIP contact"

#### SEARCH_CONTACTS

Search and list contacts:

- "Show me all my friends"
- "List my VIP contacts"
- "Find contacts named John"
- "Who are my colleagues?"

#### SCHEDULE_FOLLOW_UP

Schedule follow-up reminders:

- "Remind me to follow up with John next week about the project"
- "Schedule a follow-up with Sarah tomorrow at 2pm"
- "Follow up with the VIP client in 3 days"

### Providers

The plugin includes providers that automatically inject contact and follow-up information into the agent's context:

- **CONTACTS**: Provides a summary of all contacts organized by category
- **FOLLOW_UPS**: Lists upcoming and overdue follow-ups
- **RELATIONSHIPS**: Enhanced relationship information with analytics
- **FACTS**: Contact-specific facts and preferences

### Services

#### RolodexService

Core contact management service with methods for:

- `addContact()`: Add new contacts
- `updateContact()`: Update contact information
- `searchContacts()`: Search with various criteria
- `analyzeRelationship()`: Get relationship analytics
- `getRelationshipInsights()`: Get actionable insights

#### FollowUpService

Follow-up scheduling and management:

- `scheduleFollowUp()`: Schedule a new follow-up
- `getUpcomingFollowUps()`: Get scheduled follow-ups
- `completeFollowUp()`: Mark as complete
- `snoozeFollowUp()`: Reschedule to a later time
- `getFollowUpSuggestions()`: AI-powered suggestions

## Architecture

### Data Storage

- Contacts are stored as components attached to entities
- Relationship data enhanced with strength scores and timestamps
- Tasks used for follow-up scheduling
- All data scoped to individual agents

### Privacy & Security

- Three privacy levels: public, private, restricted
- Agent-specific data isolation
- Permission-based access control

### Relationship Strength Calculation

The plugin calculates relationship strength based on:

- Interaction count (40% weight)
- Recency of interactions (30% weight)
- Message quality (20% weight)
- Relationship type bonus (10% weight)

## Examples

### Basic Contact Management

```typescript
// Agent receives: "Add Sarah Johnson as a friend"
// Response: "I've added Sarah Johnson to your contacts as a friend."

// Agent receives: "List my VIP contacts"
// Response: "Your VIP contacts: John Smith (CEO), Alice Chen (Key Client)"
```

### Follow-up Scheduling

```typescript
// Agent receives: "Remind me to follow up with John tomorrow about the proposal"
// Response: "I've scheduled a follow-up with John for tomorrow. Reason: about the proposal"

// Agent receives: "What follow-ups do I have?"
// Response: "You have 3 follow-ups scheduled:
//
// Overdue (1):
// - John Smith (2 days overdue) - Project discussion
//
// Upcoming (2):
// - Sarah Chen (tomorrow) - Coffee meeting
// - VIP Client (in 3 days) - Contract renewal"
```

### Relationship Insights

```typescript
// Through the relationship analytics system:
// - Identifies strong relationships (>70 strength score)
// - Flags relationships needing attention (no contact >30 days)
// - Tracks recent interactions (<7 days)
```

## Development

### Adding Custom Categories

```typescript
const rolodexService = runtime.getService('rolodex');
await rolodexService.addCategory({
  id: 'investor',
  name: 'Investor',
  color: '#FFD700',
});
```

### Extending Contact Information

Contacts support custom fields for flexibility:

```typescript
await rolodexService.addContact(
  entityId,
  ['business'],
  {
    timezone: 'America/New_York',
    language: 'en',
    notes: 'Met at tech conference 2024',
  },
  {
    company: 'TechCorp',
    position: 'CTO',
    linkedIn: 'https://linkedin.com/in/example',
  }
);
```

## Contributing

Contributions are welcome! Please see the main ElizaOS contributing guidelines.

## License

MIT License - see LICENSE file for details
