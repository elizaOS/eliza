import type { Plugin, ViewCapability } from "@elizaos/core";
import { simpleViewsRoutes } from "./routes.js";
import { interact } from "./simple-views.interact.js";

const AGENT_SURFACE_CAPABILITIES: ViewCapability[] = [
  {
    id: "list-elements",
    description:
      "List addressable controls, cards, inputs, and regions in the mounted view.",
  },
  {
    id: "get-agent-state",
    description:
      "Return the mounted view's agent-surface state and element snapshot.",
  },
  {
    id: "describe-element",
    description: "Describe one mounted view element by stable id.",
    params: {
      id: {
        type: "string",
        description: "Stable agent element id.",
        required: true,
      },
    },
  },
  {
    id: "agent-click",
    description: "Click or activate one mounted view element by stable id.",
    params: {
      id: {
        type: "string",
        description: "Stable agent element id.",
        required: true,
      },
    },
  },
  {
    id: "agent-fill",
    description: "Fill one mounted view input or textarea by stable id.",
    params: {
      id: {
        type: "string",
        description: "Stable agent element id.",
        required: true,
      },
      value: {
        type: "string",
        description: "Text value to enter.",
        required: true,
      },
    },
  },
];

const NOTES_CAPABILITIES: ViewCapability[] = [
  ...AGENT_SURFACE_CAPABILITIES,
  {
    id: "get-notes",
    description: "Return all sticky notes as structured data.",
  },
  {
    id: "create-note",
    description: "Create a sticky note without needing to drive the form.",
    params: {
      title: { type: "string", description: "Note title." },
      body: { type: "string", description: "Note body." },
      color: {
        type: "string",
        description: "Sticky color: yellow, green, rose, or slate.",
      },
    },
  },
  {
    id: "delete-note",
    description: "Delete one sticky note by id, exact title, or search query.",
    params: {
      id: { type: "string", description: "Note id." },
      title: { type: "string", description: "Exact note title." },
      query: { type: "string", description: "Title/body search query." },
      name: { type: "string", description: "Alias for title or query." },
    },
  },
  {
    id: "clear-notes",
    description: "Clear all sticky notes from storage.",
  },
];

const CALENDAR_CAPABILITIES: ViewCapability[] = [
  ...AGENT_SURFACE_CAPABILITIES,
  {
    id: "get-calendar-state",
    description:
      "Return selected date and all simple calendar events as structured data.",
  },
  {
    id: "select-calendar-date",
    description: "Select a calendar date by ISO day.",
    params: {
      date: {
        type: "string",
        description: "Date in YYYY-MM-DD format.",
        required: true,
      },
    },
  },
  {
    id: "create-calendar-event",
    description: "Create a simple calendar event without driving the form.",
    params: {
      title: { type: "string", description: "Event title.", required: true },
      date: { type: "string", description: "Date in YYYY-MM-DD format." },
      time: { type: "string", description: "Time label, for example 09:00." },
      notes: { type: "string", description: "Event notes." },
      color: {
        type: "string",
        description: "Event color: yellow, green, rose, or slate.",
      },
    },
  },
  {
    id: "delete-calendar-event",
    description: "Delete one simple calendar event by id.",
    params: {
      id: { type: "string", description: "Event id.", required: true },
    },
  },
];

export const simpleViewsPlugin: Plugin = {
  name: "@elizaos/plugin-simple-views",
  description:
    "Agent-drivable Notes and Simple Calendar app views for view switching, split-pane, and capability QA.",
  routes: simpleViewsRoutes,
  views: [
    {
      id: "notes",
      label: "Notes",
      description:
        "Simple sticky notes wall. The agent can create, read, delete, fill fields, and click stable controls.",
      icon: "StickyNote",
      path: "/notes",
      order: 920,
      viewKind: "developer",
      modalities: ["gui", "xr"],
      tags: [
        "notes",
        "notepad",
        "sticky notes",
        "scratchpad",
        "qa",
        "agent-drivable",
      ],
      bundlePath: "dist/views/bundle.js",
      componentExport: "NotesView",
      visibleInManager: true,
      desktopTabEnabled: true,
      capabilities: NOTES_CAPABILITIES,
      serverInteract: interact,
    },
    {
      id: "simple-calendar",
      label: "Simple Calendar",
      description:
        "Simple local calendar for view switching QA. The production Calendar view remains the main user calendar.",
      icon: "CalendarDays",
      path: "/simple-calendar",
      order: 921,
      viewKind: "developer",
      modalities: ["gui", "xr"],
      tags: [
        "calendar",
        "calender",
        "schedule",
        "events",
        "planner",
        "qa",
        "agent-drivable",
      ],
      bundlePath: "dist/views/bundle.js",
      componentExport: "SimpleCalendarView",
      visibleInManager: true,
      desktopTabEnabled: true,
      capabilities: CALENDAR_CAPABILITIES,
      serverInteract: interact,
    },
  ],
};

export default simpleViewsPlugin;
