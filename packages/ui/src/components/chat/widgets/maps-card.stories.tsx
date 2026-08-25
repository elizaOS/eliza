/** Storybook + story-gate visual states for the inline MapsCardWidget. */
import type { Meta, StoryObj } from "@storybook/react";
import type { InlineWidgetContext } from "./inline-registry";
import { MapsCardWidget } from "./maps-card";

const noopCtx: InlineWidgetContext = {
  sendAction: () => {},
  navigate: () => {},
  prefillComposer: () => {},
  submitForm: () => {},
};

const place = {
  name: "Blue Bottle Coffee",
  latitude: 37.77,
  longitude: -122.42,
  provider: "contract-maps",
  providerPlaceId: "p-1",
  formattedAddress: "300 Webster St, Oakland, CA",
  categories: ["coffee", "cafe"],
};

const meta = {
  title: "Chat/Widgets/MapsCard",
  component: MapsCardWidget,
  tags: ["autodocs"],
} satisfies Meta<typeof MapsCardWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Place: Story = {
  args: {
    card: {
      kind: "place",
      place,
      attribution: "Places by Contract Maps",
    },
    ctx: noopCtx,
  },
};

export const Places: Story = {
  args: {
    card: {
      kind: "places",
      query: "coffee",
      places: [
        place,
        { ...place, providerPlaceId: "p-2", name: "Ritual Roasters" },
        { ...place, providerPlaceId: "p-3", name: "Sightglass" },
      ],
      nextCursor: "next-page",
      attribution: "Places by Contract Maps",
    },
    ctx: noopCtx,
  },
};

export const RouteSummary: Story = {
  args: {
    card: {
      kind: "route",
      origin: place,
      destination: { ...place, providerPlaceId: "p-4", name: "Office" },
      travelMode: "transit",
      distanceMeters: 12_345,
      durationSeconds: 4_020,
      warnings: ["Toll road", "Partial closure on Broadway"],
      attribution: "Routes by Contract Maps",
    },
    ctx: noopCtx,
  },
};

export const ShareHandoff: Story = {
  args: {
    card: {
      kind: "handoff",
      handoffKind: "share",
      place,
      geoUri: "geo:37.77,-122.42?q=37.77,-122.42(Blue%20Bottle)",
      appleMapsUri: "https://maps.apple.com/?ll=37.77,-122.42",
      webUri: "https://www.openstreetmap.org/?mlat=37.77&mlon=-122.42",
      sharedAt: "2026-08-20T18:30:00.000Z",
    },
    ctx: noopCtx,
  },
};

export const NavigateHandoff: Story = {
  args: {
    card: {
      kind: "handoff",
      handoffKind: "navigate",
      place,
      geoUri: "geo:37.77,-122.42?q=37.77,-122.42(Blue%20Bottle)",
      appleMapsUri: "https://maps.apple.com/?daddr=37.77,-122.42",
      webUri: "https://www.openstreetmap.org/directions?to=37.77%2C-122.42",
    },
    ctx: noopCtx,
  },
};

export const Locate: Story = {
  args: {
    card: {
      kind: "locate",
      intent: "route-origin",
      prompt: "I need your precise location to start the route to Office.",
    },
    ctx: noopCtx,
  },
};
