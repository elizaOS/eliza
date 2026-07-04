# WI-5 UI vocabulary — before/after string diff (#12360)

## Chat home widget (packages/ui/src/components/chat/widgets/)
```
BEFORE: workflows.tsx  export WorkflowsWidget   label="Tasks"   aria "Running tasks: ..."
AFTER:  automations.tsx export AutomationsWidget label="Automations" aria "Running automations: ..."
```

## Navigation (packages/ui/src/navigation/index.ts)
```
BEFORE: description "Scheduled tasks and recurring workflows"
AFTER:  description "Workflows, triggers, and scheduled items"
```

## Automations feed filter chip (packages/ui/src/utils/automation-feed-filter.ts + AutomationsFeed.tsx)
```
BEFORE: filter value "tasks"   label "Tasks"
AFTER:  filter value "prompts" label "Prompts"
```

## Prompt-automation editor (packages/ui/src/components/pages/TaskEditor.tsx)
```
BEFORE: "Create task" / "Save task" / header "simple automation"
AFTER:  "Create prompt automation" / "Save prompt automation" / header "prompt automation (glossary term)"
```

## Scheduled-item editor (packages/ui/src/components/pages/ScheduledTaskEditor.tsx)
```
BEFORE: header "scheduled task ... unified Tasks feed"; "Failed to update task."
AFTER:  header "scheduled item (glossary term) ... unified Automations feed"; "Failed to update scheduled item."
```

## Launcher app card (packages/ui/src/components/apps/internal-tool-apps.ts)
```
BEFORE: "Create, inspect, and manage scheduled tasks and workflows."
AFTER:  "Create, inspect, and manage workflows, triggers, and scheduled items."
```
