# Forms Plugin Scenario Demonstrations

This document demonstrates how the forms plugin handles the two key scenarios:
Weather Agent Creation and User Onboarding.

## Scenario 1: Weather Agent Creation

### Conversation Flow

**User**: "Can you make me an agent that can tell me the current weather
anywhere I ask?"

**Agent** (triggers CREATE_FORM action):

```
I'd be happy to help you create a weather agent! Let me gather some information to build the perfect agent for you.

📋 Starting Project Requirements Form

I need to collect the following information:
- **Project Name** (required): What would you like to name your weather agent?
- **Requirements** (required): Detailed description of what you want the agent to do
- **API Preferences** (optional): Any specific weather APIs you'd like to use?
- **Features** (optional): Additional features beyond basic weather queries?

From your request, I understand you want an agent that can provide current weather for any location. Let me start filling out the form with that information.
```

**User**: "Let's call it WeatherBot. It should support current weather,
forecasts, and weather alerts."

**Agent** (UPDATE_FORM action):

```
Great! I've updated the form with:
✅ Project Name: WeatherBot
✅ Requirements: Agent that can tell current weather anywhere, with support for forecasts and weather alerts

Remaining fields to complete:
- API Preferences (optional)
- Features (optional)

Would you like to specify any particular weather API (like OpenWeatherMap, WeatherAPI, etc.) or add any special features?
```

**User**: "Use OpenWeatherMap and add a feature to compare weather between
cities"

**Agent** (UPDATE_FORM action completes):

```
Perfect! I've completed the project requirements form:

✅ **Project Name**: WeatherBot
✅ **Requirements**: Agent that can tell current weather anywhere, with support for forecasts and weather alerts
✅ **API Preferences**: OpenWeatherMap
✅ **Features**: Compare weather between multiple cities

Based on these requirements, here's the project outline for your WeatherBot:

## WeatherBot - Project Outline

### Core Functionality:
1. **Current Weather Queries**: Get real-time weather for any city or coordinates
2. **Weather Forecasts**: 5-day forecasts with 3-hour intervals
3. **Weather Alerts**: Active weather warnings and alerts for specified locations
4. **City Comparison**: Compare weather conditions between multiple cities

### Technical Implementation:
- **API Integration**: OpenWeatherMap API for all weather data
- **Natural Language Processing**: Understanding various weather query formats
- **Response Formatting**: Clear, conversational weather reports
- **Error Handling**: Graceful handling of invalid locations or API issues

### Example Interactions:
- "What's the weather in New York?"
- "Compare weather between London and Paris"
- "Show me the 5-day forecast for Tokyo"
- "Are there any weather alerts in Florida?"

Would you like me to proceed with creating this weather agent?
```

**User**: "Yes, please proceed!"

**Agent**:

```
Excellent! I'll start building your WeatherBot agent. The form has been completed successfully, and I have all the information needed.

🚀 Starting development of WeatherBot...

(At this point, the form completion callback would trigger, potentially initiating an AutoCoder workflow or other agent creation process)
```

## Scenario 2: User Onboarding (Multi-step with Partial Data)

### Conversation Flow

**Agent** (System initialization):

```
Welcome to FitBot! I'm here to help you achieve your fitness goals.

To create a personalized workout plan, I need to collect some basic information about you. Let me start the onboarding process.

📋 Starting User Onboarding Form

I'll need the following information:
- **Name** (required)
- **Age** (required)
- **Height** in cm (required)
- **Weight** in kg (required)

Please tell me a bit about yourself to get started!
```

**User**: "I'm Alex and I'm 28 years old"

**Agent** (UPDATE_FORM with partial data):

```
Great to meet you, Alex! I've recorded:
✅ Name: Alex
✅ Age: 28

I still need to collect:
- Your height (in cm)
- Your weight (in kg)

These measurements will help me create a workout plan that's appropriate for your body type. Could you share your height and weight?
```

**User**: "I'm 175cm tall and weigh 75kg"

**Agent** (UPDATE_FORM completes the form):

```
Perfect! I've completed your profile:

✅ **Name**: Alex
✅ **Age**: 28
✅ **Height**: 175 cm
✅ **Weight**: 75 kg

Alright, let's get started! Based on your profile, I'll create a personalized fitness plan that takes into account your current physical stats.

(Form completion callback triggered with message: "Alright let's get started")

Here's what I can help you with:
1. Custom workout routines
2. Nutrition guidance
3. Progress tracking
4. Exercise form tips

What aspect of fitness would you like to focus on first?
```

## Implementation Details

### Form Structure for Weather Agent Creation

```typescript
{
  name: "Project Requirements",
  steps: [{
    id: "basic-info",
    name: "Basic Information",
    fields: [
      { id: "projectName", label: "Project Name", type: "text", required: true },
      { id: "requirements", label: "Requirements", type: "textarea", required: true },
      { id: "apiPreferences", label: "API Preferences", type: "text", optional: true },
      { id: "features", label: "Additional Features", type: "textarea", optional: true }
    ],
    onComplete: async (runtime, form) => {
      // Generate project outline and ask for approval
    }
  }],
  onComplete: async (runtime, form) => {
    // Trigger agent creation workflow
  }
}
```

### Form Structure for User Onboarding

```typescript
{
  name: "User Onboarding",
  steps: [{
    id: "basic-info",
    name: "Basic Information",
    fields: [
      { id: "name", label: "Name", type: "text", required: true },
      { id: "age", label: "Age", type: "number", required: true },
      { id: "height", label: "Height (cm)", type: "number", required: true },
      { id: "weight", label: "Weight (kg)", type: "number", required: true }
    ]
  }],
  onComplete: async (runtime, form) => {
    // Callback with "Alright let's get started"
    return "Alright let's get started";
  }
}
```

## Key Features Demonstrated

1. **Natural Language Extraction**: The plugin uses LLM to extract form values
   from conversational input
2. **Partial Updates**: Users can provide information incrementally
3. **Progress Tracking**: Clear indication of completed vs remaining fields
4. **Contextual Responses**: Agent acknowledges the information provided
5. **Flexible Input**: Handles various ways users might express the same
   information
6. **Form Callbacks**: Triggers workflows upon step/form completion

## Testing

To run these scenarios as tests:

```bash
# From the plugin-forms directory
bun test

# All 43 tests should pass, including:
# - Form creation tests
# - Multi-step progression tests
# - Natural language extraction tests
# - Callback execution tests
# - Secret field handling tests
```

## Integration with Other Plugins

The forms plugin can be integrated with other plugins like AutoCoder:

```typescript
// In the form completion callback
onComplete: async (runtime, form) => {
  const autocoderService = runtime.getService('autocoder');
  if (autocoderService && form.name === 'Project Requirements') {
    // Trigger AutoCoder with the collected requirements
    await autocoderService.createProject({
      name: form.getFieldValue('projectName'),
      requirements: form.getFieldValue('requirements'),
      // ... other fields
    });
  }
};
```
