# @elizaos/plugin-form

**Guardrails for agent-guided user journeys.**

---

**Architecture & Design:** Odilitime  
**Copyright © 2025 Odilitime.** Licensed under MIT.  
See [Credits & Architecture](#credits--architecture) section below.

---

## The Insight

Agents are powerful but unpredictable. Without structure, they wander. They forget what they're collecting. They miss required information. They can't reliably guide users to outcomes.

**Forms are guardrails.** They give agents:

- **A path to follow** - structured steps toward an outcome
- **Conventions to honor** - required fields, validation rules, confirmation flows
- **Memory of progress** - what's been collected, what's missing, what needs confirmation
- **Recovery from interruption** - stash, restore, pick up where you left off

This plugin turns agents into **reliable process guides** that can shepherd users through registrations, orders, applications, onboarding flows - any structured journey to an outcome.

## How It Works

The user talks naturally. The agent stays on track:

```
User: "I'm John Smith, 28 years old, and you can reach me at john@example.com"
Agent: "Got it! I have your name as John Smith, age 28, and email john@example.com. 
        I still need your username. What would you like to use?"
```

The agent knows:
- ✅ What's been collected (name, age, email)
- ❌ What's still needed (username)
- 🎯 What to ask next
- 🛤️ How to get to the outcome (account creation)

## Use Cases: User Journeys

Forms enable any structured journey:

| Journey | Outcome | Guardrails Needed |
|---------|---------|-------------------|
| **User Registration** | Account created | Email, username, age verification |
| **Product Order** | Order placed | Product selection, billing, payment |
| **Support Ticket** | Issue logged | Category, description, contact info |
| **KYC/Onboarding** | User verified | Identity docs, address, compliance |
| **Booking/Reservation** | Appointment set | Date, time, preferences, contact |
| **Application** | Application submitted | Personal info, qualifications, documents |
| **Feedback Collection** | Insights captured | Rating, comments, follow-up consent |

Each journey has required stops. Forms ensure the agent visits them all.

## Features

- 🛤️ **Journey Guardrails** - Agents follow structured paths to outcomes
- 🗣️ **Natural Language** - Users talk naturally, agents extract structure
- 🔄 **Two-Tier Intent** - Fast English keywords + LLM fallback for any language
- ✨ **UX Magic** - Undo, skip, explain, example, progress, autofill
- ⏰ **Smart TTL** - Retention scales with user effort invested
- 🔌 **Extensible Types** - Register custom validators for your domain
- 📦 **Hooks System** - React to journey lifecycle events
- 💾 **Stash/Restore** - Pause journeys, resume later

## Installation

```bash
bun add @elizaos/plugin-form
```

## Quick Start

### 1. Add plugin to your agent

```typescript
import { formPlugin } from '@elizaos/plugin-form';

const character = {
  // ... your character config
  plugins: [formPlugin],
};
```

### 2. Define a form

```typescript
import { Form, C, FormService } from '@elizaos/plugin-form';

const registrationForm = Form.create('registration')
  .name('User Registration')
  .description('Create your account')
  .control(
    C.email('email')
      .required()
      .ask('What email should we use for your account?')
      .example('user@example.com')
  )
  .control(
    C.text('name')
      .required()
      .ask("What's your name?")
  )
  .control(
    C.number('age')
      .min(13)
      .ask('How old are you?')
  )
  .onSubmit('handle_registration')
  .build();
```

### 3. Register the form in your plugin

```typescript
import type { Plugin, IAgentRuntime } from '@elizaos/core';
import { FormService } from '@elizaos/plugin-form';

export const myPlugin: Plugin = {
  name: 'my-plugin',
  dependencies: ['form'], // Depend on form plugin
  
  async init(runtime: IAgentRuntime) {
    const formService = runtime.getService('FORM') as FormService;
    formService.registerForm(registrationForm);
  },
};
```

### 4. Start a form session

```typescript
// In an action or service:
const formService = runtime.getService('FORM') as FormService;
await formService.startSession('registration', entityId, roomId);
```

### 5. Handle submissions

```typescript
runtime.registerTaskWorker({
  name: 'handle_registration',
  validate: async () => true,
  execute: async (runtime, options) => {
    const { submission } = options;
    const { email, name, age } = submission.values;
    
    // Create user account, send welcome email, etc.
    console.log(`New user: ${name} (${email}), age ${age}`);
  },
});
```

## User Experience

Once a form is active, users can interact naturally:

| User Says | What Happens |
|-----------|--------------|
| "I'm John, 25 years old" | Extracts name=John, age=25 |
| "john@example.com" | Extracts email |
| "done" / "submit" | Submits the form |
| "save for later" | Stashes form, can switch topics |
| "resume my form" | Restores stashed form |
| "cancel" / "nevermind" | Abandons form |
| "undo" / "go back" | Reverts last change |
| "skip" | Skips optional field |
| "why?" | Explains why field is needed |
| "example?" | Shows example value |
| "how far?" | Shows completion progress |
| "same as last time" | Applies autofill |

## API Reference

### FormBuilder

Create forms with the fluent builder API:

```typescript
import { Form, C } from '@elizaos/plugin-form';

const form = Form.create('contact')
  // Metadata
  .name('Contact Form')
  .description('Get in touch with us')
  .version(1)
  
  // Controls
  .control(C.email('email').required())
  .control(C.text('message').required().maxLength(1000))
  .control(C.select('department', [
    { value: 'sales', label: 'Sales' },
    { value: 'support', label: 'Support' },
  ]))
  
  // Permissions
  .roles('user', 'admin')
  .allowMultiple()
  
  // UX options
  .noUndo()           // Disable undo
  .noSkip()           // Disable skip
  .maxUndoSteps(3)    // Limit undo history
  
  // TTL (retention)
  .ttl({ minDays: 7, maxDays: 30, effortMultiplier: 0.5 })
  
  // Nudge (reminders)
  .nudgeAfter(24)     // Hours before nudge
  .nudgeMessage('You have an unfinished contact form...')
  
  // Hooks
  .onStart('on_contact_start')
  .onFieldChange('on_contact_field_change')
  .onReady('on_contact_ready')
  .onSubmit('handle_contact_submission')
  .onCancel('on_contact_cancel')
  
  // Debug
  .debug()            // Enable extraction logging
  
  .build();
```

### ControlBuilder

Create field controls:

```typescript
import { C } from '@elizaos/plugin-form';

// Basic types
C.text('name')
C.email('email')
C.number('age')
C.boolean('subscribe')
C.date('birthdate')
C.file('resume')
C.select('country', [{ value: 'us', label: 'United States' }])

// Validation
C.text('username')
  .required()
  .minLength(3)
  .maxLength(20)
  .pattern('^[a-z0-9_]+$')

C.number('quantity')
  .min(1)
  .max(100)

// Agent hints
C.text('company')
  .label('Company Name')
  .description('The company you work for')
  .ask('What company do you work for?')
  .hint('employer', 'organization', 'workplace')
  .example('Acme Corp')
  .confirmThreshold(0.9)  // Require high confidence

// Behavior
C.text('password')
  .required()
  .sensitive()     // Don't echo back

C.text('internalId')
  .hidden()        // Extract silently, never ask

C.text('role')
  .readonly()      // Can't change after set

// File uploads
C.file('document')
  .accept(['application/pdf', 'image/*'])
  .maxSize(5 * 1024 * 1024)  // 5MB
  .maxFiles(3)

// Access control
C.number('discount')
  .roles('admin', 'sales')

// Conditional fields
C.text('state')
  .dependsOn('country', 'equals', 'us')

// Database mapping
C.text('firstName')
  .dbbind('first_name')

// UI hints (for future GUIs)
C.text('bio')
  .section('Profile')
  .order(1)
  .placeholder('Tell us about yourself...')
  .widget('textarea')
```

### FormService

The main service for managing forms:

```typescript
const formService = runtime.getService('FORM') as FormService;

// Form definitions
formService.registerForm(form);
formService.getForm('form-id');
formService.listForms();

// Sessions
await formService.startSession('form-id', entityId, roomId);
await formService.getActiveSession(entityId, roomId);
await formService.getStashedSessions(entityId);

// Field updates
await formService.updateField(sessionId, entityId, 'email', 'john@example.com', 0.95, 'extraction');
await formService.undoLastChange(sessionId, entityId);
await formService.skipField(sessionId, entityId, 'nickname');

// Lifecycle
await formService.submit(sessionId, entityId);
await formService.stash(sessionId, entityId);
await formService.restore(sessionId, entityId);
await formService.cancel(sessionId, entityId);

// Autofill
await formService.applyAutofill(session);

// Context
formService.getSessionContext(session);

// Custom types
formService.registerType('phone', {
  validate: (value) => ({
    valid: /^\+?[\d\s-()]+$/.test(String(value)),
    error: 'Invalid phone number',
  }),
  extractionPrompt: 'a phone number (digits, spaces, dashes allowed)',
});
```

### Hooks

React to form lifecycle events by registering task workers:

```typescript
// Called when session starts
runtime.registerTaskWorker({
  name: 'on_registration_start',
  execute: async (runtime, { session, form }) => {
    // Log, initialize context, etc.
  },
});

// Called when any field changes
runtime.registerTaskWorker({
  name: 'on_registration_field_change',
  execute: async (runtime, { session, field, value, oldValue }) => {
    // Validate cross-field dependencies, update derived values
  },
});

// Called when all required fields are filled
runtime.registerTaskWorker({
  name: 'on_registration_ready',
  execute: async (runtime, { session }) => {
    // Maybe auto-submit, or prepare preview
  },
});

// Called on successful submission
runtime.registerTaskWorker({
  name: 'handle_registration',
  execute: async (runtime, { session, submission }) => {
    const { email, name, age } = submission.values;
    // Create account, send email, etc.
  },
});

// Called when user cancels
runtime.registerTaskWorker({
  name: 'on_registration_cancel',
  execute: async (runtime, { session }) => {
    // Cleanup, log abandonment, etc.
  },
});

// Called when session expires
runtime.registerTaskWorker({
  name: 'on_registration_expire',
  execute: async (runtime, { session }) => {
    // Final cleanup
  },
});
```

## Custom Field Types

Register custom validators for domain-specific types:

```typescript
import { registerTypeHandler } from '@elizaos/plugin-form';

// Solana wallet address
registerTypeHandler('solana_address', {
  validate: (value) => {
    const valid = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(value));
    return { valid, error: valid ? undefined : 'Invalid Solana address' };
  },
  parse: (value) => value.trim(),
  format: (value) => `${String(value).slice(0, 4)}...${String(value).slice(-4)}`,
  extractionPrompt: 'a Solana wallet address (Base58 encoded, 32-44 characters)',
});

// Use in form
const form = Form.create('wallet')
  .control(
    C.field('walletAddress')
      .type('solana_address')
      .required()
      .label('Wallet Address')
  )
  .build();
```

## Widget Registry (ControlType System)

The Widget Registry is a powerful system for creating complex, service-backed control types. It enables plugins to register custom controls that go beyond simple validation.

### Three Types of Controls

| Type | Description | Example |
|------|-------------|---------|
| **Simple** | Validate/parse/format only | text, email, phone |
| **Composite** | Has subcontrols that roll up | address (street, city, zip) |
| **External** | Requires async external confirmation | payment, signature |

### Registering a Simple Type

```typescript
const formService = runtime.getService('FORM') as FormService;

formService.registerControlType({
  id: 'phone',
  validate: (value) => ({
    valid: /^\+?[\d\s-()]+$/.test(String(value)),
    error: 'Invalid phone number',
  }),
  parse: (value) => value.replace(/\s/g, ''),
  format: (value) => String(value),
  extractionPrompt: 'a phone number with optional country code',
});
```

### Registering a Composite Type

Composite types have subcontrols that must all be filled:

```typescript
formService.registerControlType({
  id: 'address',
  
  // Returns subcontrols for this type
  getSubControls: (control, runtime) => [
    { key: 'street', type: 'text', label: 'Street', required: true },
    { key: 'city', type: 'text', label: 'City', required: true },
    { key: 'state', type: 'text', label: 'State', required: true },
    { key: 'zip', type: 'text', label: 'ZIP Code', required: true },
  ],
  
  // Validate the combined address
  validate: (value) => ({ valid: true }),
});

// Use in form
const form = Form.create('shipping')
  .control(C.field('address').type('address').required())
  .build();
```

When users provide address parts, they're extracted as subfields:
```
User: "123 Main St, Springfield, IL 62701"
→ Extracts: address.street, address.city, address.state, address.zip
```

### Registering an External Type

External types require async confirmation from outside the conversation (blockchain transactions, signatures, etc.):

```typescript
formService.registerControlType({
  id: 'payment',
  
  getSubControls: (control, runtime) => [
    { key: 'amount', type: 'number', label: 'Amount', required: true },
    { key: 'currency', type: 'select', label: 'Currency', required: true,
      options: [{ value: 'SOL', label: 'Solana' }, { value: 'ETH', label: 'Ethereum' }]
    },
  ],
  
  // Called when all subcontrols are filled
  activate: async (context) => {
    const { session, subValues, runtime } = context;
    const paymentService = runtime.getService('PAYMENT');
    
    // Create pending payment, return instructions
    return paymentService.createPendingPayment({
      sessionId: session.id,
      amount: subValues.amount,
      currency: subValues.currency,
    });
    // Returns: { instructions: "Send 0.5 SOL to xyz...", reference: "abc123" }
  },
  
  // Called when user cancels
  deactivate: async (context) => {
    const paymentService = context.runtime.getService('PAYMENT');
    await paymentService.cancelPending(context.session.fields.payment?.externalState?.reference);
  },
  
  validate: (value) => ({
    valid: !!value?.confirmed,
    error: 'Payment not confirmed',
  }),
});
```

### External Confirmation Flow

External types follow an event-driven confirmation flow:

```
1. User fills subcontrols: "$50 in SOL"
2. Evaluator detects all subcontrols filled
3. Evaluator calls formService.activateExternalField()
4. Widget's activate() creates pending request, returns instructions
5. Agent shows instructions: "Send 0.5 SOL to xyz..."
6. (External) User sends blockchain transaction
7. PaymentService detects tx, calls formService.confirmExternalField()
8. Field status changes to 'filled'
9. Agent proceeds with form
```

### Confirming External Fields

When your service detects the external action completed:

```typescript
// In your payment service
async handlePaymentReceived(reference: string, txData: any) {
  const pending = this.getPendingByReference(reference);
  
  const formService = this.runtime.getService('FORM') as FormService;
  await formService.confirmExternalField(
    pending.sessionId,
    pending.entityId,
    pending.field,
    { confirmed: true, txId: txData.signature },
    { blockchain: 'solana', confirmedAt: Date.now() }
  );
}
```

### Widget Events

The evaluator emits events as it processes messages:

| Event | When | Payload |
|-------|------|---------|
| `FORM_FIELD_EXTRACTED` | Simple field value extracted | sessionId, field, value, confidence |
| `FORM_SUBFIELD_UPDATED` | Composite subfield updated | sessionId, parentField, subField, value |
| `FORM_SUBCONTROLS_FILLED` | All subcontrols filled | sessionId, field, subValues |
| `FORM_EXTERNAL_ACTIVATED` | External type activated | sessionId, field, activation |
| `FORM_FIELD_CONFIRMED` | External field confirmed | sessionId, field, value, externalData |
| `FORM_FIELD_CANCELLED` | External field cancelled | sessionId, field, reason |

Widgets react to events, they don't parse messages.

### Built-in Types

These types are pre-registered and protected from override:

| Type | Validation | Extraction Prompt |
|------|------------|-------------------|
| `text` | Pattern, length | "a text string" |
| `number` | Min/max value | "a number" |
| `email` | Email format | "an email address" |
| `boolean` | Yes/no values | "yes/no or true/false" |
| `select` | Must match option | "one of the options" |
| `date` | Valid date | "a date in YYYY-MM-DD" |
| `file` | Size, type limits | "a file attachment" |

Override built-in types with caution:

```typescript
formService.registerControlType(myCustomText, { allowOverride: true });
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      User Message                           │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                   FORM_CONTEXT Provider                      │
│  • Runs BEFORE agent responds                               │
│  • Injects: progress, filled fields, next field, etc.       │
│  • Shows pending external actions (payments, signatures)    │
│  • Agent knows what to ask                                  │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                     Agent (REPLY)                           │
│  • Uses form context to craft response                      │
│  • Asks for next field, confirms uncertain values           │
│  • Shows external action instructions when pending          │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                   form_evaluator                            │
│  • Runs AFTER each message                                  │
│  • Tier 1: Fast English keyword matching                    │
│  • Tier 2: LLM extraction for complex/non-English           │
│  • Handles subfields for composite types                    │
│  • Emits events (FORM_FIELD_EXTRACTED, etc.)               │
│  • Triggers activation for external types                   │
│  • Updates session state                                    │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                    FormService                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              ControlType Registry                     │  │
│  │  • Built-in: text, number, email, boolean, etc.      │  │
│  │  • Custom: phone, address, payment, signature        │  │
│  │  • Simple → Composite → External types               │  │
│  └──────────────────────────────────────────────────────┘  │
│  • Manages form definitions                                 │
│  • Manages sessions (create, update, stash, restore)        │
│  • Handles subfields for composite types                    │
│  • Activates/confirms/cancels external fields               │
│  • Executes lifecycle hooks                                 │
│  • Handles submissions                                      │
└─────────────────────────────────────────────────────────────┘
```

### Widget Registry Flow (External Types)

```
┌──────────────┐    ┌────────────────┐    ┌──────────────────┐
│    User      │    │   Evaluator    │    │  FormService     │
│  "$50 SOL"   │───▶│ Extract values │───▶│ updateSubField() │
└──────────────┘    │ Emit events    │    │ areSubFieldsFilled? │
                    └───────┬────────┘    └────────┬─────────┘
                            │                      │ Yes
                            │              ┌───────▼────────┐
                            │              │ activateExternal│
                            │              │ Field()         │
                            │              └───────┬─────────┘
                            │                      │
                    ┌───────▼──────────────────────▼─────────┐
                    │           ControlType.activate()        │
                    │  • Creates pending request              │
                    │  • Returns instructions + reference     │
                    └───────────────────────────┬────────────┘
                                                │
                    ┌───────────────────────────▼────────────┐
                    │        Agent Shows Instructions         │
                    │  "Send 0.5 SOL to xyz... ref: abc123"  │
                    └────────────────────────────────────────┘
                                    ...
┌──────────────┐    ┌────────────────┐    ┌──────────────────┐
│  Blockchain  │    │ PaymentService │    │  FormService     │
│  TX detected │───▶│ Match reference│───▶│confirmExternal() │
└──────────────┘    └────────────────┘    └──────────────────┘
                                                │
                    ┌───────────────────────────▼────────────┐
                    │        Field marked 'filled'           │
                    │        Form continues...                │
                    └────────────────────────────────────────┘
```

## Smart TTL

Form sessions are retained based on user effort:

| Time Spent | Retention |
|------------|-----------|
| 0-5 min    | 14 days (minimum) |
| 30 min     | ~15 days |
| 2 hours    | ~60 days |
| 4+ hours   | 90 days (maximum) |

Configure per-form:

```typescript
Form.create('important-form')
  .ttl({
    minDays: 30,         // Always keep at least 30 days
    maxDays: 180,        // Never more than 180 days
    effortMultiplier: 1, // 1 day per minute of effort
  })
```

## Debugging

Enable debug mode to see extraction reasoning:

```typescript
Form.create('debug-form')
  .debug()  // Logs LLM extraction reasoning
  .build();
```

---

## Credits & Architecture

### Design & Architecture

**Plugin-Form** was architected and designed by **Odilitime**.

#### Core Insight

**Forms as Agent Guardrails (2025)**

The foundational insight: forms aren't about data collection—they're about **keeping agents on track**. Without structure, agents wander, forget context, and fail to guide users to outcomes. This plugin provides the rails that make agents reliable process guides.

#### Core Innovations

**Agent-Native Form Architecture**
- Designed the evaluator-driven extraction pattern (vs action-per-field)
- Created the provider-based context injection for agent awareness
- Invented two-tier intent detection (fast English + LLM fallback)
- Result: Agents naturally guide users through journeys without explicit commands

**Conversational UX System**
- Designed natural language "UX magic" commands (undo, skip, explain, example, progress)
- Created confidence-based confirmation flow for uncertain extractions
- Invented the stash/restore pattern for journey interruption
- Result: Users interact naturally, agents stay on track

**Effort-Based TTL System**
- Designed smart retention that scales with user investment
- Created the effort tracking model (time spent, interaction count)
- Invented nudge system for stale journeys
- Result: Respects user work while managing storage

**Fluent Builder API**
- Designed type-safe form definition syntax
- Created the ControlBuilder/FormBuilder pattern
- Invented shorthand factories (C.email, C.number, etc.)
- Result: Forms are easy to define, hard to misconfigure

**Extensible Type System**
- Designed pluggable type handler registry
- Created validation/parsing/formatting/extraction pipeline per type
- Enabled domain-specific types (blockchain addresses, phone numbers)
- Result: Any domain can extend the form system

**Widget Registry (ControlType System)**
- Designed unified ControlType interface for simple, composite, and external types
- Created subfield extraction pattern for composite types
- Invented external type activation/confirmation flow for async processes
- Event-driven architecture: evaluator emits, widgets react
- Override protection for built-in types
- Result: Plugins can register complex, service-backed controls (payments, signatures)

#### Technical Architecture

- Evaluator + Provider pattern (not action-per-intent)
- Two-tier intent detection (regex fast path, LLM fallback)
- Component-based storage (room-scoped sessions)
- Confidence-scored extraction with confirmation flow
- Field-level history for undo functionality
- Hook system for consuming plugin integration
- Smart TTL with effort multipliers
- Nudge task worker for stale session recovery
- Widget registry with ControlType interface (simple → composite → external)
- Subfield state tracking for composite types
- External state machine (pending → confirmed/failed/expired)
- Event emission for reactive widget architecture

#### Philosophy & Principles

- "Forms are guardrails, not data collectors"
- "Agents follow paths, users reach outcomes"
- "Fast path first, LLM when needed"
- "Respect user effort in retention"
- "Extensibility through types, not code changes"
- "Provider gives context, agent handles conversation"

---

### Documentation & Knowledge Transfer

**All documentation authored by Odilitime:**
- Comprehensive README with architecture diagrams
- WHY comments throughout codebase explaining design decisions
- Module-level documentation on every file
- Four complete example plugins demonstrating patterns
- Type definitions with extensive JSDoc

**Code Quality:**
- Full TypeScript with strict typing
- Fluent builder API with method chaining
- Comprehensive defaults system
- Zero build errors
- Production-ready foundation

---

### License

Copyright © 2025 Odilitime

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---

### Recognition

**If this plugin makes your agent-guided journeys reliable, consider:**
- ⭐ Starring the repository
- 🗣️ Sharing your implementation patterns
- 💬 Contributing improvements back to the community
- 🙏 Acknowledging Odilitime's architectural work

---

**Designed and built by Odilitime. Making agents reliable guides through user journeys.**

