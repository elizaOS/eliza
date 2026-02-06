# @elizaos/plugin-trust

A comprehensive trust, security, and permission management plugin for ElizaOS, providing multi-dimensional trust scoring, context-aware permissions, and advanced security features.

## Features

- **Multi-dimensional Trust System**: Calculate and track trust scores across multiple dimensions (reliability, competence, integrity, benevolence, transparency)
- **Context-aware Permission Management**: Dynamic permission system that adapts based on trust levels and context
- **Security Module**: Advanced threat detection including prompt injection, credential theft, and phishing attempts
- **Permission Elevation System**: Temporary permission elevation based on trust and justification
- **Credential Protection**: Automatic detection and prevention of credential theft attempts
- **LLM-based Evaluation**: AI-powered security threat and trust action evaluation
- **Role Management**: Hierarchical role system with OWNER, ADMIN, and NONE roles
- **Settings Management**: Onboarding and configuration system for world/server settings
- **Trust Interaction Tracking**: Record and analyze trust-affecting behaviors
- **Security Event Monitoring**: Track and respond to security incidents with trust impact

## Installation

As this is a workspace package, it's installed as part of the ElizaOS monorepo:

```bash
bun install
```

## Configuration

The plugin requires the following environment variables:

```bash
# World Configuration (Optional)
WORLD_ID=your_world_id

# Security Settings (Optional)
TRUST_SCORE_THRESHOLD=60  # Minimum trust score for certain actions
SECURITY_ALERT_THRESHOLD=0.8  # Threshold for security alerts
CREDENTIAL_SCAN_ENABLED=true  # Enable credential theft scanning

# Permission Settings (Optional)
ELEVATION_DURATION_MINUTES=60  # Default elevation duration
MAX_ELEVATION_REQUESTS=5  # Max elevation requests per user per day
```

## Usage

```json
{
  "plugins": [
    ...otherPlugins,
    "@elizaos/plugin-trust"
  ]
}
```

### Available Actions

The plugin provides the following actions:

1. **UPDATE_ROLE** - Assign roles (Admin, Owner, None) to users in a channel
   - Similes: `CHANGE_ROLE`, `SET_PERMISSIONS`, `ASSIGN_ROLE`, `MAKE_ADMIN`
   
2. **UPDATE_SETTINGS** - Save configuration settings during onboarding
   - Similes: `UPDATE_SETTING`, `SAVE_SETTING`, `SET_CONFIGURATION`, `CONFIGURE`
   
3. **RECORD_TRUST_INTERACTION** - Record trust-affecting interactions between entities
   - Similes: `record trust event`, `log trust interaction`, `track behavior`
   
4. **EVALUATE_TRUST** - Evaluate trust score and profile for an entity
   - Similes: `check trust score`, `trust rating`, `show trust level`
   
5. **REQUEST_ELEVATION** - Request temporary elevation of permissions
   - Similes: `need temporary access`, `request higher privileges`, `elevate my permissions`

### Providers

The plugin includes four state providers:

1. **roleProvider** - Provides role information for entities in a world
2. **settingsProvider** - Provides current settings and configuration state
3. **trustProfileProvider** - Provides detailed trust profile information
4. **securityStatusProvider** - Provides current security status and threat level

### Evaluators

1. **reflectionEvaluator** - Analyzes interactions for trust-affecting behaviors
2. **trustChangeEvaluator** - Automatically detects and records trust changes based on behavior patterns

### Services

The plugin registers five core services:

1. **TrustEngine** (`trust-engine`)
   - Multi-dimensional trust scoring and evidence-based evaluation
   - Trust profile calculation and decision making
   - Interaction history tracking

2. **SecurityModule** (`security-module`)
   - Threat detection and assessment
   - Prompt injection detection
   - Phishing and impersonation detection
   - Security event logging with trust impact

3. **ContextualPermissionSystem** (`contextual-permissions`)
   - Dynamic permission checking based on trust and context
   - Permission elevation request handling
   - Role-based access control integration

4. **CredentialProtector** (`credential-protector`)
   - Credential theft detection and prevention
   - Sensitive data protection
   - Victim alerting system

5. **LLMEvaluator** (`llm-evaluator`)
   - AI-powered security threat evaluation
   - Behavioral analysis and anomaly detection
   - Trust action evaluation with reasoning

## Trust System

### Trust Dimensions

The trust system evaluates entities across five dimensions:
- **Reliability**: Consistency in behavior and keeping promises
- **Competence**: Skill and capability demonstrations
- **Integrity**: Ethical behavior and honesty
- **Benevolence**: Positive intentions and helpfulness
- **Transparency**: Openness and clarity in communication

### Trust Evidence Types

```typescript
enum TrustEvidenceType {
  PROMISE_KEPT = 'PROMISE_KEPT',
  PROMISE_BROKEN = 'PROMISE_BROKEN',
  HELPFUL_ACTION = 'HELPFUL_ACTION',
  HARMFUL_ACTION = 'HARMFUL_ACTION',
  VERIFICATION_SUCCESS = 'VERIFICATION_SUCCESS',
  VERIFICATION_FAILURE = 'VERIFICATION_FAILURE',
  COMMUNITY_CONTRIBUTION = 'COMMUNITY_CONTRIBUTION',
  SECURITY_VIOLATION = 'SECURITY_VIOLATION',
  SPAM_BEHAVIOR = 'SPAM_BEHAVIOR',
  SUSPICIOUS_ACTIVITY = 'SUSPICIOUS_ACTIVITY'
}
```

## Permission System

### Permission Types

The system supports various permission actions:
- `manage_roles`: Ability to change user roles
- `manage_settings`: Ability to modify world/server settings
- `moderate_content`: Content moderation capabilities
- `access_sensitive`: Access to sensitive information
- `execute_admin`: Execute administrative commands

### Permission Elevation

Users can request temporary permission elevation based on:
- Current trust score
- Justification provided
- Context of the request
- Historical behavior

## Security Features

### Threat Detection

The security module detects:
- Prompt injection attempts
- Credential theft attempts
- Phishing messages
- Impersonation attempts
- Multi-account abuse patterns
- Suspicious behavioral patterns

### Security Response

When threats are detected:
1. Security event is logged
2. Trust score is impacted
3. Potential victims are alerted
4. Access may be restricted

## Testing

The plugin includes comprehensive E2E tests accessible via:

```typescript
import { tests } from '@elizaos/plugin-trust';
```

Run tests with:
```bash
bun test
```

## Example Usage

### Evaluating Trust
```typescript
// User: "What is my trust score?"
// Agent: "Trust Level: Good (65/100) based on 42 interactions"

// User: "Show detailed trust profile for Alice"
// Agent provides detailed breakdown of trust dimensions
```

### Managing Roles
```typescript
// User: "Make @john an ADMIN"
// Agent: "Updated john's role to ADMIN."
```

### Requesting Elevation
```typescript
// User: "I need permission to manage roles to help moderate spam"
// Agent evaluates request based on trust and grants/denies
```

## Schema

The plugin uses Drizzle ORM with the following main tables:
- `trustInteractions`: Stores all trust-affecting interactions
- `trustProfiles`: Caches calculated trust profiles
- `securityEvents`: Logs security-related events
- `permissionGrants`: Tracks permission elevations

## Notes

- Trust scores range from 0-100 and affect available permissions
- The system maintains a complete audit trail of all trust-affecting actions
- Permission elevation is temporary and logged for security
- Trust profiles are recalculated based on recent interactions
- Security threats immediately impact trust scores
- The plugin integrates seamlessly with ElizaOS's world and role systems
- All actions respect the hierarchical role system (OWNER > ADMIN > NONE)

## Dependencies

- `@elizaos/core`: Core ElizaOS functionality
- `@elizaos/plugin-anthropic`: LLM evaluation capabilities
- `drizzle-orm`: Database ORM for trust data persistence
- `dedent`: String formatting for templates
