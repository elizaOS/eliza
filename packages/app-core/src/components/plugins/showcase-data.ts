/** Synthetic showcase plugin that demonstrates all 23 field renderers. */

import type { PluginInfo } from "../../api";

export const SHOWCASE_PLUGIN: PluginInfo = {
  id: "__ui-showcase__",
  name: "UI Field Showcase",
  description:
    "Interactive reference of all 23 field renderers. Not a real plugin — expand to see every UI component in action.",
  enabled: false,
  configured: true,
  envKey: null,
  category: "feature",
  source: "bundled",
  validationErrors: [],
  validationWarnings: [],
  version: "1.0.0",
  icon: "🧩",
  parameters: [
    // 1. text
    {
      key: "DISPLAY_NAME",
      type: "string",
      description: "A simple single-line text input for names or short values.",
      required: true,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
    // 2. password
    {
      key: "SECRET_TOKEN",
      type: "string",
      description:
        "Masked password input with show/hide toggle and server-backed reveal.",
      required: true,
      sensitive: true,
      currentValue: null,
      isSet: false,
    },
    // 3. number
    {
      key: "SERVER_PORT",
      type: "number",
      description: "Numeric input with min/max range and step control.",
      required: false,
      sensitive: false,
      default: "3000",
      currentValue: null,
      isSet: false,
    },
    // 4. boolean
    {
      key: "ENABLE_LOGGING",
      type: "boolean",
      description: "Toggle switch — on/off. Auto-detected from ENABLE_ prefix.",
      required: false,
      sensitive: false,
      default: "true",
      currentValue: null,
      isSet: false,
    },
    // 5. url
    {
      key: "WEBHOOK_URL",
      type: "string",
      description:
        "URL input with format validation. Auto-detected from _URL suffix.",
      required: false,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
    // 6. select
    {
      key: "DEPLOY_REGION",
      type: "string",
      description:
        "Dropdown selector populated from hint.options. Auto-detected for region/zone keys.",
      required: false,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
    // 7. textarea
    {
      key: "SYSTEM_PROMPT",
      type: "string",
      description:
        "Multi-line text input for long values like prompts or templates. Auto-detected from _PROMPT suffix.",
      required: false,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
    // 8. email
    {
      key: "CONTACT_EMAIL",
      type: "string",
      description: "Email input with format validation. Renders type=email.",
      required: false,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
    // 9. color
    {
      key: "THEME_COLOR",
      type: "string",
      description: "Color picker with hex value text input side-by-side.",
      required: false,
      sensitive: false,
      default: "#4a90d9",
      currentValue: null,
      isSet: false,
    },
    // 10. radio
    {
      key: "AUTH_MODE",
      type: "string",
      description:
        "Radio button group — best for 2-3 mutually exclusive options. Uses 'basic' or 'oauth'.",
      required: false,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
    // 11. multiselect
    {
      key: "ENABLED_FEATURES",
      type: "string",
      description:
        "Checkbox group for selecting multiple values from a fixed set.",
      required: false,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
    // 12. date
    {
      key: "START_DATE",
      type: "string",
      description: "Date picker input. Auto-detected from _DATE suffix.",
      required: false,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
    // 13. datetime
    {
      key: "SCHEDULED_AT",
      type: "string",
      description: "Combined date and time picker for scheduling.",
      required: false,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
    // 14. json
    {
      key: "METADATA_CONFIG",
      type: "string",
      description:
        "JSON editor with syntax validation. Shows parse errors inline.",
      required: false,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
    // 15. code
    {
      key: "RESPONSE_TEMPLATE",
      type: "string",
      description:
        "Code editor with monospaced font for templates and snippets.",
      required: false,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
    // 16. array
    {
      key: "ALLOWED_ORIGINS",
      type: "string",
      description:
        "Comma-separated list of origins with add/remove UI for each item.",
      required: false,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
    // 17. keyvalue
    {
      key: "CUSTOM_HEADERS",
      type: "string",
      description: "Key-value pair editor with add/remove rows.",
      required: false,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
    // 18. file
    {
      key: "CERT_FILE",
      type: "string",
      description: "File path input for certificates, configs, or data files.",
      required: false,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
    // 19. custom
    {
      key: "CUSTOM_COMPONENT",
      type: "string",
      description: "Placeholder for plugin-provided custom React components.",
      required: false,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
    // 20. markdown
    {
      key: "RELEASE_NOTES",
      type: "string",
      description:
        "Markdown editor with Edit/Preview toggle for rich text content.",
      required: false,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
    // 21. checkbox-group
    {
      key: "NOTIFICATION_CHANNELS",
      type: "string",
      description:
        "Checkbox group with per-option descriptions — similar to multiselect but with checkbox UX.",
      required: false,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
    // 22. group
    {
      key: "CONNECTION_GROUP",
      type: "string",
      description:
        "Fieldset container for visually grouping related configuration fields.",
      required: false,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
    // 23. table
    {
      key: "ROUTE_TABLE",
      type: "string",
      description:
        "Tabular data editor with add/remove rows and column headers.",
      required: false,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
  ],
  configUiHints: {
    DISPLAY_NAME: {
      label: "Display Name",
      group: "Basic Fields",
      width: "half",
      help: "Renderer: text — single-line text input",
    },
    SECRET_TOKEN: {
      label: "Secret Token",
      group: "Basic Fields",
      width: "half",
      help: "Renderer: password — masked with show/hide toggle",
    },
    SERVER_PORT: {
      label: "Server Port",
      group: "Basic Fields",
      width: "third",
      min: 1,
      max: 65535,
      unit: "port",
      help: "Renderer: number — with min/max range and unit label",
    },
    ENABLE_LOGGING: {
      label: "Enable Logging",
      group: "Basic Fields",
      width: "third",
      help: "Renderer: boolean — pill-shaped toggle switch",
    },
    WEBHOOK_URL: {
      label: "Webhook URL",
      group: "Basic Fields",
      width: "full",
      placeholder: "https://example.com/webhook",
      help: "Renderer: url — URL input with format validation",
    },
    DEPLOY_REGION: {
      label: "Deploy Region",
      group: "Selection Fields",
      width: "half",
      type: "select",
      options: [
        { value: "us-east-1", label: "US East (Virginia)" },
        { value: "us-west-2", label: "US West (Oregon)" },
        { value: "eu-west-1", label: "EU (Ireland)" },
        { value: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
      ],
      help: "Renderer: select — dropdown with enhanced option labels",
    },
    SYSTEM_PROMPT: {
      label: "System Prompt",
      group: "Text Fields",
      width: "full",
      help: "Renderer: textarea — multi-line text input for long content",
    },
    CONTACT_EMAIL: {
      label: "Contact Email",
      group: "Text Fields",
      width: "half",
      type: "email",
      placeholder: "admin@example.com",
      help: "Renderer: email — email input with format validation",
    },
    THEME_COLOR: {
      label: "Theme Color",
      group: "Selection Fields",
      width: "third",
      type: "color",
      help: "Renderer: color — color picker swatch + hex input",
    },
    AUTH_MODE: {
      label: "Auth Mode",
      group: "Selection Fields",
      width: "half",
      type: "radio",
      options: [
        {
          value: "basic",
          label: "Basic Auth",
          description: "Username and password",
        },
        {
          value: "oauth",
          label: "OAuth 2.0",
          description: "Token-based authentication",
        },
        {
          value: "apikey",
          label: "API Key",
          description: "Header-based API key",
        },
      ],
      help: "Renderer: radio — radio button group with descriptions",
    },
    ENABLED_FEATURES: {
      label: "Enabled Features",
      group: "Selection Fields",
      width: "full",
      type: "multiselect",
      options: [
        { value: "auth", label: "Authentication" },
        { value: "logging", label: "Logging" },
        { value: "caching", label: "Caching" },
        { value: "webhooks", label: "Webhooks" },
        { value: "ratelimit", label: "Rate Limiting" },
      ],
      help: "Renderer: multiselect — checkbox group for multiple selections",
    },
    START_DATE: {
      label: "Start Date",
      group: "Date & Time",
      width: "half",
      type: "date",
      help: "Renderer: date — native date picker",
    },
    SCHEDULED_AT: {
      label: "Scheduled At",
      group: "Date & Time",
      width: "half",
      type: "datetime",
      help: "Renderer: datetime — date + time picker",
    },
    METADATA_CONFIG: {
      label: "Metadata Config",
      group: "Structured Data",
      width: "full",
      type: "json",
      help: "Renderer: json — JSON editor with inline validation",
    },
    RESPONSE_TEMPLATE: {
      label: "Response Template",
      group: "Structured Data",
      width: "full",
      type: "code",
      help: "Renderer: code — monospaced code editor",
    },
    ALLOWED_ORIGINS: {
      label: "Allowed Origins",
      group: "Structured Data",
      width: "full",
      type: "array",
      help: "Renderer: array — add/remove items list",
    },
    CUSTOM_HEADERS: {
      label: "Custom Headers",
      group: "Structured Data",
      width: "full",
      type: "keyvalue",
      help: "Renderer: keyvalue — key-value pair editor",
    },
    CERT_FILE: {
      label: "Certificate File",
      group: "File Paths",
      width: "full",
      type: "file",
      help: "Renderer: file — file path input",
    },
    CUSTOM_COMPONENT: {
      label: "Custom Component",
      group: "File Paths",
      width: "full",
      type: "custom",
      help: "Renderer: custom — placeholder for plugin-provided React components",
      advanced: true,
    },
    RELEASE_NOTES: {
      label: "Release Notes",
      group: "Text Fields",
      width: "full",
      type: "markdown",
      help: "Renderer: markdown — textarea with Edit/Preview toggle",
    },
    NOTIFICATION_CHANNELS: {
      label: "Notification Channels",
      group: "Selection Fields",
      width: "full",
      type: "checkbox-group",
      options: [
        {
          value: "email",
          label: "Email",
          description: "Send notifications via email",
        },
        {
          value: "slack",
          label: "Slack",
          description: "Post to Slack channels",
        },
        {
          value: "webhook",
          label: "Webhook",
          description: "HTTP POST to configured URL",
        },
        { value: "sms", label: "SMS", description: "Text message alerts" },
      ],
      help: "Renderer: checkbox-group — vertical checkbox list with descriptions",
    },
    CONNECTION_GROUP: {
      label: "Connection Settings",
      group: "Structured Data",
      width: "full",
      type: "group",
      help: "Renderer: group — fieldset container with legend",
    },
    ROUTE_TABLE: {
      label: "Route Table",
      group: "Structured Data",
      width: "full",
      type: "table",
      help: "Renderer: table — tabular data editor with add/remove rows",
    },
  },
};
