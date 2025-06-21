# ElizaOS Multi-Action Message Examples

This document provides examples of multi-action messages that demonstrate how ElizaOS can chain actions together to accomplish complex tasks.

## Core Actions Overview

- **REPLY** - Send a message response
- **FOLLOW_ROOM** - Start actively monitoring a room/channel
- **UNFOLLOW_ROOM** - Stop monitoring a room
- **IGNORE** - End conversation
- **NONE** - Acknowledge without action
- **MUTE_ROOM** - Temporarily silence notifications
- **UNMUTE_ROOM** - Resume notifications
- **CHOOSE_OPTION** - Select from pending options
- **UPDATE_SETTINGS** - Modify user preferences

## Multi-Action Examples

### 1. Settings Update Chain

**User**: "Set my notification preferences to email only and timezone to PST"

**Agent Response**:

```json
{
  "content": {
    "text": "I'll update your notification preferences and timezone settings.",
    "actions": ["REPLY", "UPDATE_SETTINGS", "CONFIRM_SETTINGS"],
    "actionPlan": {
      "id": "plan_123",
      "goal": "Update user notification and timezone preferences",
      "steps": [
        {
          "id": "step_1",
          "actionName": "REPLY",
          "parameters": {
            "message": "I'll update your notification preferences and timezone settings."
          }
        },
        {
          "id": "step_2",
          "actionName": "UPDATE_SETTINGS",
          "parameters": {
            "settings": {
              "notifications": { "email": true, "sms": false, "push": false },
              "timezone": "America/Los_Angeles"
            }
          },
          "dependencies": ["step_1"]
        },
        {
          "id": "step_3",
          "actionName": "CONFIRM_SETTINGS",
          "parameters": {
            "settingsToConfirm": ["notifications", "timezone"]
          },
          "dependencies": ["step_2"]
        }
      ],
      "executionModel": "sequential"
    }
  }
}
```

### 2. Room Management Chain

**User**: "Mute #general for 2 hours then remind me to check it"

**Agent Response**:

```json
{
  "content": {
    "text": "I'll mute #general for 2 hours and set a reminder.",
    "actions": ["REPLY", "MUTE_ROOM", "CREATE_REMINDER"],
    "actionPlan": {
      "steps": [
        {
          "actionName": "REPLY",
          "parameters": { "message": "Muting #general for 2 hours and setting a reminder." }
        },
        {
          "actionName": "MUTE_ROOM",
          "parameters": {
            "roomName": "general",
            "duration": 7200000,
            "reason": "User requested temporary mute"
          }
        },
        {
          "actionName": "CREATE_REMINDER",
          "parameters": {
            "message": "Check #general channel - mute period has ended",
            "scheduledFor": "{{now + 7200000}}",
            "metadata": { "relatedAction": "MUTE_ROOM", "roomName": "general" }
          }
        }
      ]
    }
  }
}
```

### 3. Task Selection Chain

**User**: "Show me my pending tasks and let me choose which to complete first"

**Agent Response**:

```json
{
  "content": {
    "text": "I'll show you your pending tasks.",
    "actions": ["REPLY", "LIST_TASKS", "PREPARE_CHOICE", "AWAIT_CHOICE"],
    "actionPlan": {
      "steps": [
        {
          "actionName": "LIST_TASKS",
          "parameters": { "filter": "pending", "format": "detailed" }
        },
        {
          "actionName": "PREPARE_CHOICE",
          "parameters": {
            "choiceContext": "task_prioritization",
            "options": "{{step_1.data.tasks}}"
          }
        },
        {
          "actionName": "AWAIT_CHOICE",
          "parameters": {
            "prompt": "Which task would you like to complete first?",
            "timeoutMs": 300000
          }
        }
      ]
    }
  }
}
```

### 4. Research and Report Chain

**User**: "Research the latest AI developments and create a summary report"

**Agent Response**:

```json
{
  "content": {
    "text": "I'll research recent AI developments and prepare a summary for you.",
    "actions": ["REPLY", "RESEARCH_TOPIC", "ANALYZE_FINDINGS", "GENERATE_REPORT", "SAVE_DOCUMENT"],
    "actionPlan": {
      "goal": "Research AI developments and create summary report",
      "steps": [
        {
          "actionName": "RESEARCH_TOPIC",
          "parameters": {
            "topic": "latest AI developments",
            "sources": ["academic", "news", "industry"],
            "timeframe": "last_30_days"
          }
        },
        {
          "actionName": "ANALYZE_FINDINGS",
          "parameters": {
            "data": "{{step_1.data.findings}}",
            "analysisType": "trends_and_breakthroughs"
          }
        },
        {
          "actionName": "GENERATE_REPORT",
          "parameters": {
            "template": "executive_summary",
            "sections": ["key_findings", "trends", "implications"],
            "data": "{{step_2.data.analysis}}"
          }
        },
        {
          "actionName": "SAVE_DOCUMENT",
          "parameters": {
            "filename": "ai_developments_summary_{{date}}",
            "format": "markdown",
            "content": "{{step_3.data.report}}"
          }
        }
      ]
    }
  }
}
```

### 5. Channel Monitoring Setup

**User**: "Follow #announcements and #dev-updates, but mute #random"

**Agent Response**:

```json
{
  "content": {
    "text": "I'll set up your channel preferences.",
    "actions": ["REPLY", "FOLLOW_ROOM", "FOLLOW_ROOM", "MUTE_ROOM"],
    "actionPlan": {
      "steps": [
        {
          "actionName": "REPLY",
          "parameters": { "message": "Setting up your channel monitoring preferences..." }
        },
        {
          "actionName": "FOLLOW_ROOM",
          "parameters": {
            "roomName": "announcements",
            "priority": "high"
          }
        },
        {
          "actionName": "FOLLOW_ROOM",
          "parameters": {
            "roomName": "dev-updates",
            "priority": "medium"
          }
        },
        {
          "actionName": "MUTE_ROOM",
          "parameters": {
            "roomName": "random",
            "reason": "User preference"
          }
        }
      ],
      "executionModel": "parallel"
    }
  }
}
```

### 6. Conversation Handoff Chain

**User**: "I need to go, but please follow up on this issue tomorrow"

**Agent Response**:

```json
{
  "content": {
    "text": "I'll make a note to follow up tomorrow. Have a good day!",
    "actions": ["REPLY", "CREATE_TASK", "SCHEDULE_FOLLOWUP", "NONE"],
    "actionPlan": {
      "steps": [
        {
          "actionName": "REPLY",
          "parameters": { "message": "I'll make a note to follow up tomorrow. Have a good day!" }
        },
        {
          "actionName": "CREATE_TASK",
          "parameters": {
            "title": "Follow up on user issue",
            "description": "{{conversation_context}}",
            "dueDate": "{{tomorrow}}",
            "priority": "medium"
          }
        },
        {
          "actionName": "SCHEDULE_FOLLOWUP",
          "parameters": {
            "time": "{{tomorrow_9am}}",
            "message": "Following up on yesterday's issue...",
            "roomId": "{{current_room}}"
          }
        },
        {
          "actionName": "NONE",
          "parameters": {}
        }
      ]
    }
  }
}
```

### 7. Error Recovery Chain

**User**: "The last command didn't work"

**Agent Response**:

```json
{
  "content": {
    "text": "Let me check what went wrong and try an alternative approach.",
    "actions": ["REPLY", "CHECK_LOGS", "DIAGNOSE_ERROR", "EXECUTE_FALLBACK"],
    "actionPlan": {
      "steps": [
        {
          "actionName": "CHECK_LOGS",
          "parameters": {
            "timeframe": "last_5_minutes",
            "filter": "errors"
          }
        },
        {
          "actionName": "DIAGNOSE_ERROR",
          "parameters": {
            "logs": "{{step_1.data.logs}}",
            "context": "{{last_action_context}}"
          }
        },
        {
          "actionName": "EXECUTE_FALLBACK",
          "parameters": {
            "originalAction": "{{step_2.data.failedAction}}",
            "fallbackStrategy": "{{step_2.data.recommendedFallback}}"
          }
        }
      ]
    }
  }
}
```

### 8. Complex Choice Workflow

**User**: "Help me decide between option A and B based on my preferences"

**Agent Response**:

```json
{
  "content": {
    "text": "I'll help you make an informed decision.",
    "actions": [
      "REPLY",
      "GATHER_PREFERENCES",
      "ANALYZE_OPTIONS",
      "PRESENT_COMPARISON",
      "AWAIT_CHOICE"
    ],
    "actionPlan": {
      "steps": [
        {
          "actionName": "GATHER_PREFERENCES",
          "parameters": {
            "questions": ["What's most important to you?", "Any constraints?"],
            "context": "decision_making"
          }
        },
        {
          "actionName": "ANALYZE_OPTIONS",
          "parameters": {
            "options": ["A", "B"],
            "criteria": "{{step_1.data.preferences}}",
            "weights": "{{step_1.data.importance}}"
          }
        },
        {
          "actionName": "PRESENT_COMPARISON",
          "parameters": {
            "format": "pros_cons_table",
            "analysis": "{{step_2.data.comparison}}"
          }
        },
        {
          "actionName": "AWAIT_CHOICE",
          "parameters": {
            "prompt": "Based on this analysis, which option would you prefer?",
            "options": ["A", "B", "Need more info"]
          }
        }
      ]
    }
  }
}
```

## Action State Propagation

Each action in a chain can pass state to subsequent actions:

```json
{
  "actionResults": [
    {
      "success": true,
      "data": {
        "actionName": "RESEARCH_TOPIC",
        "findings": ["item1", "item2"]
      },
      "state": {
        "researchComplete": true,
        "topicId": "ai_developments_2024"
      }
    },
    {
      "success": true,
      "data": {
        "actionName": "ANALYZE_FINDINGS",
        "analysis": { "trends": [...], "insights": [...] }
      },
      "state": {
        "analysisComplete": true,
        "previousTopicId": "ai_developments_2024"
      }
    }
  ]
}
```

## ActionStateProvider Output Example

When the ActionStateProvider is queried during action chain execution:

```
## Previous Action Results
Step 1: ✓ REPLY - User greeted
Step 2: ✓ FOLLOW_ROOM - Started following #general
Step 3: ✗ MUTE_ROOM - Error: Insufficient permissions

## Working Memory
lastReply: "Hello! I'll help you set up your preferences."
roomsFollowed: ["general"]
errorCount: 1

## Active Plan
Goal: Set up user channel preferences
Steps: 4
Status: running
```

## Best Practices for Multi-Action Chains

1. **Start with REPLY**: When user interaction is needed, begin chains with REPLY to acknowledge the request
2. **Order Dependencies**: Ensure actions that depend on others are properly sequenced
3. **Handle Failures**: Include fallback actions for critical operations
4. **State Passing**: Use returned state to share context between actions
5. **Parallel Execution**: Use parallel execution model when actions are independent
6. **End Appropriately**: Use NONE for continuation, IGNORE for conversation end

## Error Handling in Chains

Actions should handle errors gracefully and determine whether to continue the chain:

```json
{
  "success": false,
  "error": {
    "message": "Insufficient permissions",
    "code": "PERMISSION_DENIED",
    "critical": false
  },
  "data": {
    "actionName": "MUTE_ROOM",
    "attemptedRoom": "general"
  },
  "nextActions": ["REQUEST_PERMISSION", "NOTIFY_ADMIN"]
}
```

This allows the runtime to decide whether to abort the chain or attempt recovery actions.
