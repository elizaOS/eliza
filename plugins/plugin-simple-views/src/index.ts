import type { Plugin, ViewCapability } from "@elizaos/core";
import { simpleViewsRoutes } from "./routes.js";
import { interact } from "./simple-views.interact.js";

const AGENT_SURFACE_CAPABILITIES: ViewCapability[] = [
  {
    id: "list-elements",
    description: "List addressable controls, cards, inputs, and regions in the mounted view.",
  },
  {
    id: "get-agent-state",
    description: "Return the mounted view's agent-surface state and element snapshot.",
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
  {
    id: "agent-focus",
    description: "Focus one mounted view element by stable id.",
    params: {
      id: {
        type: "string",
        description: "Stable agent element id.",
        required: true,
      },
    },
  },
  {
    id: "agent-scroll-to",
    description: "Scroll one mounted view element into the viewport.",
    params: {
      id: {
        type: "string",
        description: "Stable agent element id.",
        required: true,
      },
    },
  },
  {
    id: "set-highlight",
    description: "Toggle visual highlighting for agent-addressable elements.",
    params: {
      on: {
        type: "boolean",
        description: "Whether highlighting should be enabled.",
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
        description: "Sticky color: yellow, green, blue, or pink.",
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
    description: "Clear all sticky notes from local storage.",
  },
];

const CALENDAR_CAPABILITIES: ViewCapability[] = [
  ...AGENT_SURFACE_CAPABILITIES,
  {
    id: "get-calendar-state",
    description: "Return selected date and all simple calendar events as structured data.",
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
    description: "Create a simple calendar event without needing to drive the form.",
    params: {
      title: { type: "string", description: "Event title.", required: true },
      date: { type: "string", description: "Date in YYYY-MM-DD format." },
      time: { type: "string", description: "Time label, for example 09:00." },
      notes: { type: "string", description: "Event notes." },
      color: {
        type: "string",
        description: "Event color: yellow, green, blue, or pink.",
      },
    },
  },
  {
    id: "delete-calendar-event",
    description: "Delete one calendar event by id.",
    params: {
      id: { type: "string", description: "Event id.", required: true },
    },
  },
];

export const simpleViewsPlugin: Plugin = {
  name: "@elizaos/plugin-simple-views",
  description:
    "Lightweight agent-drivable dynamic views: a sticky notes wall and a simple local calendar.",
  routes: simpleViewsRoutes,
  views: [
    {
      id: "notes",
      label: "Notes",
      description:
        "Simple sticky notes wall. The agent can create, read, delete, search visible controls, fill note fields, and click stable note controls.",
      icon: "StickyNote",
      path: "/notes",
      order: 20,
      tags: [
        "notes",
        "notepad",
        "notepad-view",
        "sticky notes",
        "sticky-notes",
        "note wall",
        "scratchpad",
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
      id: "calendar",
      label: "Calendar",
      description:
        "Simple local month calendar. The agent can select days, create events, delete events, fill fields, and click stable controls.",
      icon: "CalendarDays",
      path: "/calendar",
      order: 21,
      tags: [
        "calendar",
        "calender",
        "schedule",
        "events",
        "planner",
        "agent-drivable",
      ],
      bundlePath: "dist/views/bundle.js",
      componentExport: "CalendarView",
      visibleInManager: true,
      desktopTabEnabled: true,
      capabilities: CALENDAR_CAPABILITIES,
      serverInteract: interact,
    },
  ],
};

export default simpleViewsPlugin;
