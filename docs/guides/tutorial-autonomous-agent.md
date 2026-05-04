---
title: "Tutorial: Autonomous Agent"
sidebarTitle: "Autonomous Agent"
description: "Learn how to set up and configure autonomous agents for scheduled, automated task execution with comprehensive safety controls and monitoring."
---

## What is Autonomous Mode?

Autonomous mode enables agents to execute tasks automatically on a schedule without manual intervention. Instead of responding to user requests in real-time, autonomous agents run in the background at specified intervals, making decisions and taking actions based on predefined triggers and configurations.

<Info>
Autonomous agents are ideal for recurring tasks like data synchronization, scheduled reports, routine maintenance, and periodic monitoring.
</Info>

### Common Use Cases

<Steps>
  <Step title="Scheduled Data Processing">
    Automatically fetch data from external sources, process it, and store results at regular intervals.
  </Step>
  <Step title="Periodic Monitoring">
    Monitor system health, API endpoints, or application metrics on a schedule and alert when thresholds are exceeded.
  </Step>
  <Step title="Batch Operations">
    Execute batch jobs that would be inefficient to run in real-time, such as generating reports or cleaning up outdated records.
  </Step>
  <Step title="Event-Driven Automation">
    Trigger autonomous execution based on specific events or conditions detected in your systems.
  </Step>
  <Step title="Maintenance Tasks">
    Automate routine maintenance like cache invalidation, log rotation, or database optimization.
  </Step>
</Steps>

## Enabling Autonomous Mode

### Via Dashboard

Enabling autonomous mode for an agent is straightforward through the Eliza dashboard:

<Steps>
  <Step title="Navigate to Agent Settings">
    Open your agent in the Eliza dashboard and select the **Settings** tab.
  </Step>
  <Step title="Enable Autonomy">
    Toggle the **Enable Autonomous Execution** switch to activate autonomous mode.
  </Step>
  <Step title="Configure Trigger Type">
    Select your desired trigger type: **Interval**, **Cron**, or **Once**.
  </Step>
  <Step title="Set Trigger Parameters">
    Configure the specific parameters for your chosen trigger type (see Trigger Types section below).
  </Step>
  <Step title="Review Safety Settings">
    Adjust safety controls like max runs, rate limits, and resource monitoring as needed.
  </Step>
  <Step title="Save Configuration">
    Click **Save** to activate autonomous execution.
  </Step>
</Steps>

### Via API

You can also enable autonomous mode programmatically using the local Eliza API:

<CodeGroup>
```bash curl
# Enable autonomy
curl -X POST http://localhost:31337/api/agent/autonomy \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'

# Create a trigger for scheduled execution
curl -X POST http://localhost:31337/api/triggers \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true
  }'
```

```json JSON Response
{
  "ok": true,
  "autonomy": true,
  "thinking": false
}
```
</CodeGroup>

To check the current autonomy state:

```bash
curl http://localhost:31337/api/agent/autonomy
```

See the [Autonomy API reference](/rest/autonomy) for full endpoint documentation.

<Warning>
Store sensitive configuration in `~/.eliza/eliza.json` or environment variables. Never hardcode credentials in your code.
</Warning>

## Trigger Types

Autonomous agents support three trigger types to fit different scheduling needs. See the [Triggers guide](/guides/triggers) for full details.

### Interval Triggers

Execute the agent at fixed time intervals. The `intervalMs` field specifies milliseconds between runs (minimum: 60,000 ms, maximum: 2,678,400,000 ms).

<CodeGroup>
```json Run Every Hour
{
  "triggerType": "interval",
  "intervalMs": 3600000,
  "instructions": "Check system health and report anomalies",
  "wakeMode": "inject_now"
}
```

```json Run Every 30 Minutes
{
  "triggerType": "interval",
  "intervalMs": 1800000,
  "instructions": "Summarize the latest activity in all channels",
  "wakeMode": "inject_now"
}
```
</CodeGroup>

<Info>
Interval triggers are best for tasks that should run at regular, predictable intervals regardless of the time of day.
</Info>

### Cron Triggers

Use standard 5-field cron expressions for more complex scheduling patterns. An optional `timezone` field supports IANA timezone names.

<CodeGroup>
```json Weekdays at 9 AM Pacific
{
  "triggerType": "cron",
  "cronExpression": "0 9 * * 1-5",
  "timezone": "America/Los_Angeles",
  "instructions": "Generate the daily business report",
  "wakeMode": "inject_now"
}
```

```json Every 15 Minutes During Business Hours
{
  "triggerType": "cron",
  "cronExpression": "*/15 9-17 * * 1-5",
  "timezone": "America/Chicago",
  "instructions": "Check price feeds",
  "wakeMode": "inject_now"
}
```
</CodeGroup>

<Tip>
Cron triggers respect timezone settings, so you can schedule tasks to run at specific local times across different regions.
</Tip>

### Once Triggers

Execute a single time at a specified ISO 8601 timestamp. The task is automatically deleted after execution.

<CodeGroup>
```json One-Time Execution
{
  "triggerType": "once",
  "scheduledAtIso": "2026-03-25T15:30:00Z",
  "instructions": "Send the quarterly report summary",
  "wakeMode": "inject_now"
}
```
</CodeGroup>

<Warning>
Once triggers are one-time only. After execution, the trigger is automatically deleted. Create a new trigger for additional runs.
</Warning>

## Safety Controls

Eliza provides comprehensive safety controls to prevent runaway autonomous agents and ensure predictable resource usage.

<Steps>
  <Step title="Max Runs Per Period">
    Set maximum execution limits per hour, day, or week to prevent excessive resource consumption.
  </Step>
  <Step title="Concurrent Run Limits">
    Restrict the number of agent instances running simultaneously to prevent system overload.
  </Step>
  <Step title="Execution Timeout">
    Define maximum execution duration for each autonomous run. Agents exceeding this will be terminated.
  </Step>
  <Step title="Resource Monitoring">
    Monitor CPU, memory, and network usage during autonomous execution.
  </Step>
  <Step title="Rate Limiting">
    Implement backoff strategies when external service rate limits are encountered.
  </Step>
  <Step title="Automatic Disabling">
    Configure automatic disable rules based on error rates or resource violations.
  </Step>
</Steps>

### Max Runs Configuration

You can limit how many times a trigger executes by setting `maxRuns` on each trigger. For example, to run a trigger at most 24 times:

```json
{
  "triggerType": "interval",
  "intervalMs": 3600000,
  "instructions": "Check system status",
  "maxRuns": 24,
  "wakeMode": "inject_now"
}
```

The trigger system also enforces a per-creator limit on the total number of active triggers (default: 100, configurable via the `ELIZA_TRIGGERS_MAX_ACTIVE` environment variable or runtime setting).

The autonomous state provider caps event caching at 240 events per agent to bound memory usage.

## Monitoring via Autonomous Panel

The Autonomous Panel provides real-time visibility into your autonomous agent execution:

<Tabs>
  <Tab title="Overview">
    The overview tab displays:
    - Current execution status (running, idle, paused)
    - Last execution timestamp and result
    - Next scheduled execution time
    - Execution success rate (last 30 days)
    - Average execution duration
  </Tab>
  <Tab title="Execution History">
    View detailed logs of all autonomous executions:
    - Start and end times
    - Execution duration
    - Exit code and status
    - Agent output and logs
    - Error messages (if applicable)
    - Resource usage metrics
  </Tab>
  <Tab title="Performance Metrics">
    Monitor agent performance over time:
    - Execution time trends
    - Memory and CPU usage
    - Success/failure rates
    - Average response times
    - Resource utilization graphs
  </Tab>
  <Tab title="Alerts & Notifications">
    Configure notifications for autonomous execution events:
    - Execution failures
    - Resource limit warnings
    - Timeout incidents
    - Rate limit encounters
  </Tab>
</Tabs>

<Tip>
Set up email and Slack notifications for execution failures to catch issues quickly.
</Tip>

## Disabling Autonomy

You can disable autonomous mode at any time through the dashboard or API:

<CodeGroup>
```bash curl
curl -X POST http://localhost:31337/api/agent/autonomy \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": false
  }'
```

```json JSON Response
{
  "ok": true,
  "autonomy": false,
  "thinking": false
}
```
</CodeGroup>

### Dashboard Disabling

To disable via dashboard:

<Steps>
  <Step title="Open Agent Settings">
    Navigate to your agent and select **Settings**.
  </Step>
  <Step title="Toggle Autonomy Off">
    Switch the **Enable Autonomous Execution** toggle to off.
  </Step>
  <Step title="Confirm Disabling">
    Click **Confirm** in the dialog that appears.
  </Step>
</Steps>

<Warning>
Disabling autonomy will prevent any scheduled executions from running. The agent will return to manual (on-demand) execution mode.
</Warning>

## Troubleshooting

<AccordionGroup>
  <Accordion title="Agent runs but doesn't complete within timeout">
    Check your timeout configuration and agent execution logs. If tasks consistently exceed the timeout, increase the `timeoutSeconds` value in safety controls. Consider breaking complex tasks into smaller autonomous executions.
  </Accordion>
  
  <Accordion title="Executions failing with resource limits exceeded">
    Review resource usage in the performance metrics panel. Increase memory or CPU limits in `resourceLimits`, or optimize your agent to use fewer resources. Consider running fewer concurrent executions or at longer intervals.
  </Accordion>
  
  <Accordion title="Cron expression not executing at expected times">
    Verify your cron syntax and timezone settings. Use a cron expression validator to test your pattern. Ensure the timezone matches your intended execution region. Check that the agent's server time is synchronized correctly.
  </Accordion>
  
  <Accordion title="Agent disabled automatically but I don't know why">
    Check the Autonomous Panel alerts and execution history for error messages. Review error rate thresholds and resource violation logs. Look for API rate limiting responses from external services. Enable verbose logging to get more details on why execution failed.
  </Accordion>
  
  <Accordion title="Notification channels not receiving alerts">
    Verify notification channel credentials are correct and permissions are granted. Test sending a manual notification. Check email spam folders or Slack app notification settings. Ensure the agent has sufficient permissions to send to those channels.
  </Accordion>
</AccordionGroup>

## Next Steps

- Learn more about [configuring advanced autonomous mode options](/guides/autonomous-mode)
- Explore [trigger type details and edge cases](/guides/triggers)
- Set up [diagnostics](/guides/developer-diagnostics-and-workspace) for your agents
- Review [security architecture](/security) for production deployments
