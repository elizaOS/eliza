import type {
  LocationSuggestionProvider,
  LocationSuggestionRequest,
  MeetingLocation,
} from "./types";

interface VenueData {
  name: string;
  address: string;
  city: string;
  placeId?: string;
  category: string[];
  timeOfDay: Array<"morning" | "afternoon" | "evening">;
  interests: string[];
  notes: string;
}

// Curated venue database (real places)
const CURATED_VENUES: VenueData[] = [
  // San Francisco
  {
    name: "Blue Bottle Coffee (Ferry Building)",
    address: "1 Ferry Building, San Francisco, CA 94111",
    city: "San Francisco",
    placeId: "ChIJ-zZcV7qAhYARpQ-CJF1-6lM",
    category: ["cafe", "coffee"],
    timeOfDay: ["morning", "afternoon"],
    interests: ["coffee", "food", "conversation", "casual"],
    notes: "Popular waterfront cafe with great views",
  },
  {
    name: "Dolores Park",
    address: "Dolores St & 19th St, San Francisco, CA 94114",
    city: "San Francisco",
    placeId: "ChIJyZ7blqB9j4ARCs8WL-ELEkU",
    category: ["park", "outdoor"],
    timeOfDay: ["morning", "afternoon"],
    interests: ["outdoor", "walking", "nature", "casual", "sports"],
    notes: "Popular park for casual meetups",
  },
  {
    name: "Tartine Bakery",
    address: "600 Guerrero St, San Francisco, CA 94110",
    city: "San Francisco",
    category: ["cafe", "bakery"],
    timeOfDay: ["morning", "afternoon"],
    interests: ["food", "coffee", "conversation"],
    notes: "Iconic bakery, perfect for morning meetings",
  },
  {
    name: "The Interval at Long Now",
    address: "2 Marina Blvd, San Francisco, CA 94123",
    city: "San Francisco",
    category: ["bar", "museum"],
    timeOfDay: ["afternoon", "evening"],
    interests: ["technology", "science", "conversation", "intellectual"],
    notes: "Unique space combining bar and museum",
  },
  {
    name: "SFMOMA (San Francisco Museum of Modern Art)",
    address: "151 3rd St, San Francisco, CA 94103",
    city: "San Francisco",
    placeId: "ChIJn8s4RzqAhYARZy8tJXzOAFU",
    category: ["museum", "culture"],
    timeOfDay: ["morning", "afternoon"],
    interests: ["art", "culture", "museums", "intellectual"],
    notes: "World-class modern art museum",
  },
  {
    name: "The Progress",
    address: "1525 Fillmore St, San Francisco, CA 94115",
    city: "San Francisco",
    category: ["restaurant"],
    timeOfDay: ["evening"],
    interests: ["food", "dining", "conversation"],
    notes: "Upscale restaurant for evening meetings",
  },
  {
    name: "Lands End Trail",
    address: "680 Point Lobos Ave, San Francisco, CA 94121",
    city: "San Francisco",
    category: ["trail", "outdoor"],
    timeOfDay: ["morning", "afternoon"],
    interests: ["hiking", "outdoor", "nature", "walking"],
    notes: "Scenic coastal trail",
  },
  {
    name: "Philz Coffee (Multiple Locations)",
    address: "Various locations, San Francisco, CA",
    city: "San Francisco",
    category: ["cafe", "coffee"],
    timeOfDay: ["morning", "afternoon"],
    interests: ["coffee", "casual", "conversation"],
    notes: "Local coffee chain, casual atmosphere",
  },

  // New York
  {
    name: "Blue Bottle Coffee (Rockefeller Center)",
    address: "1 Rockefeller Plaza, New York, NY 10020",
    city: "New York",
    category: ["cafe", "coffee"],
    timeOfDay: ["morning", "afternoon"],
    interests: ["coffee", "business", "conversation"],
    notes: "Central location, good for business meetings",
  },
  {
    name: "Central Park (Sheep Meadow)",
    address: "Central Park West & 69th St, New York, NY 10023",
    city: "New York",
    placeId: "ChIJxcAVDVpYwokRGqE7hAHWvTQ",
    category: ["park", "outdoor"],
    timeOfDay: ["morning", "afternoon"],
    interests: ["outdoor", "nature", "walking", "casual"],
    notes: "Iconic park, perfect for casual meetups",
  },
  {
    name: "The High Line",
    address: "New York, NY 10011",
    city: "New York",
    placeId: "ChIJy7tBjCpZwokR4hgH_sG6xnE",
    category: ["park", "outdoor", "art"],
    timeOfDay: ["morning", "afternoon", "evening"],
    interests: ["art", "walking", "outdoor", "architecture"],
    notes: "Elevated park with art installations",
  },
  {
    name: "Bluestone Lane (Financial District)",
    address: "30 Broad St, New York, NY 10004",
    city: "New York",
    category: ["cafe", "coffee"],
    timeOfDay: ["morning", "afternoon"],
    interests: ["coffee", "business", "casual"],
    notes: "Australian-style cafe, good for business casual",
  },
  {
    name: "The Met (Metropolitan Museum of Art)",
    address: "1000 5th Ave, New York, NY 10028",
    city: "New York",
    placeId: "ChIJb8Jg9pZYwokR-qHGtvSkLzs",
    category: ["museum", "culture"],
    timeOfDay: ["morning", "afternoon"],
    interests: ["art", "culture", "museums", "history"],
    notes: "World-famous art museum",
  },
  {
    name: "Gramercy Tavern",
    address: "42 E 20th St, New York, NY 10003",
    city: "New York",
    category: ["restaurant"],
    timeOfDay: ["evening"],
    interests: ["food", "dining", "conversation"],
    notes: "Upscale American restaurant",
  },
  {
    name: "Bryant Park",
    address: "New York, NY 10018",
    city: "New York",
    placeId: "ChIJZVq97jRYwokR3NiRU8RtKWs",
    category: ["park", "outdoor"],
    timeOfDay: ["morning", "afternoon"],
    interests: ["outdoor", "reading", "casual"],
    notes: "Midtown park with seating and activities",
  },
  {
    name: "Brooklyn Bridge Park",
    address: "Brooklyn, NY 11201",
    city: "New York",
    category: ["park", "outdoor"],
    timeOfDay: ["morning", "afternoon", "evening"],
    interests: ["outdoor", "walking", "views", "nature"],
    notes: "Waterfront park with Manhattan views",
  },
];

const calculateInterestMatch = (
  venueInterests: string[],
  userInterests: string[],
): number => {
  if (venueInterests.length === 0 || userInterests.length === 0) return 0.3;

  const venueSet = new Set(venueInterests.map((i) => i.toLowerCase()));
  const userSet = new Set(userInterests.map((i) => i.toLowerCase()));

  let matches = 0;
  for (const interest of userSet) {
    if (venueSet.has(interest)) matches++;
  }

  const union = new Set([...venueSet, ...userSet]);
  return matches / union.size;
};

const scoreVenue = (
  venue: VenueData,
  request: LocationSuggestionRequest,
): { venue: VenueData; score: number } => {
  if (venue.city !== request.city) return { venue, score: -1 };

  let score = venue.timeOfDay.includes(request.timeOfDay) ? 40 : 0;
  score += calculateInterestMatch(venue.interests, request.interests) * 60;

  return { venue, score };
};

export class CuratedLocationProvider implements LocationSuggestionProvider {
  private venues: VenueData[];

  constructor(customVenues?: VenueData[]) {
    this.venues = customVenues || CURATED_VENUES;
  }

  async suggest(
    request: LocationSuggestionRequest,
  ): Promise<MeetingLocation[]> {
    const scored = this.venues
      .map((venue) => scoreVenue(venue, request))
      .filter((item) => item.score >= 0);

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, request.limit || 3).map((item) => ({
      name: item.venue.name,
      address: item.venue.address,
      city: item.venue.city,
      placeId: item.venue.placeId,
      notes: item.venue.notes,
    }));
  }

  addVenue(venue: VenueData): void {
    this.venues.push(venue);
  }

  getVenuesForCity(city: string): VenueData[] {
    return this.venues.filter((v) => v.city === city);
  }
}

export const createDefaultLocationProvider = () =>
  new CuratedLocationProvider();
export { CURATED_VENUES, type VenueData };
