# Function: composeContext()

> **composeContext**(`params`): `string`

Composes a context string by replacing placeholders in a template with values from a state object. Supports both simple string replacement and the Handlebars templating engine.

## Parameters

### **params**: `Object`

An object containing the following properties:

- **state**: `State`
  The state object containing key-value pairs for replacing placeholders in the template.

- **template**: `string | Function`
  A string or function returning a string containing placeholders in the format `{{placeholder}}`.

- **templatingEngine**: `"handlebars" | undefined` _(optional)_
  The templating engine to use. If set to `"handlebars"`, the Handlebars engine is used for template compilation. Defaults to `undefined` (simple string replacement).

## Returns

`string`

The context string with placeholders replaced by corresponding values from the state object. If a placeholder has no matching key in the state, it is replaced with an empty string.

## Examples

### Simple Example

```javascript
const state = { userName: "Alice", userAge: 30 };
const template = "Hello, {{userName}}! You are {{userAge}} years old.";

// Simple string replacement
const contextSimple = composeContext({ state, template });
// Output: "Hello, Alice! You are 30 years old."

// Handlebars templating
const contextHandlebars = composeContext({
    state,
    template,
    templatingEngine: "handlebars",
});
// Output: "Hello, Alice! You are 30 years old."
```

### Advanced Example

```javascript
const advancedTemplate = `
  {{#if userAge}}
    Hello, {{userName}}!
    {{#if (gt userAge 18)}}You are an adult.{{else}}You are a minor.{{/if}}
  {{else}}
    Hello! We don't know your age.
  {{/if}}

  {{#if favoriteColors.length}}
    Your favorite colors are:
    {{#each favoriteColors}}
      - {{this}}
    {{/each}}
  {{else}}
    You didn't specify any favorite colors.
  {{/if}}
`;

const advancedState = {
    userName: "Alice",
    userAge: 30,
    favoriteColors: ["blue", "green", "red"],
};

// Composing the context with Handlebars
const advancedContextHandlebars = composeContext({
    state: advancedState,
    template: advancedTemplate,
    templatingEngine: "handlebars",
});
// Output:
// Hello, Alice!
// You are an adult.
//
// Your favorite colors are:
// - blue
// - green
// - red
```
