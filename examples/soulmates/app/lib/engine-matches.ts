import type {
  DomainMode,
  EngineState,
  MatchRecord,
  MatchStatus,
  MeetingRecord,
  Persona,
  PersonaId,
} from "@engine/types";

export type MatchAction = "accept" | "decline";

export type MatchPartnerSummary = {
  personaId: PersonaId;
  name: string;
  city: string;
  timeZone: string;
};

export type MatchSummary = {
  matchId: string;
  domain: DomainMode;
  status: MatchStatus;
  score: number;
  createdAt: string;
  reasons: string[];
  partner: MatchPartnerSummary;
  meeting: MeetingRecord | null;
};

const findMeeting = (
  state: EngineState,
  match: MatchRecord,
): MeetingRecord | null => {
  if (!match.scheduledMeetingId) return null;
  return (
    state.meetings.find(
      (meeting) => meeting.meetingId === match.scheduledMeetingId,
    ) ?? null
  );
};

const partnerSummary = (persona: Persona): MatchPartnerSummary => ({
  personaId: persona.id,
  name: persona.profile.name || persona.general.name,
  city: persona.general.location.city,
  timeZone: persona.profile.availability.timeZone,
});

export const listMatchesForPersona = (
  state: EngineState,
  personaId: PersonaId,
): MatchSummary[] => {
  const personaIndex = new Map<PersonaId, Persona>();
  for (const persona of state.personas) {
    personaIndex.set(persona.id, persona);
  }

  return state.matches
    .filter(
      (match) =>
        (match.personaA === personaId || match.personaB === personaId) &&
        match.status !== "expired",
    )
    .map((match) => {
      const partnerId =
        match.personaA === personaId ? match.personaB : match.personaA;
      const partner = personaIndex.get(partnerId);
      return {
        matchId: match.matchId,
        domain: match.domain,
        status: match.status,
        score: match.assessment.score,
        createdAt: match.createdAt,
        reasons: match.reasoning,
        partner: partner
          ? partnerSummary(partner)
          : {
              personaId: partnerId,
              name: "Unknown",
              city: "Unknown",
              timeZone: "UTC",
            },
        meeting: findMeeting(state, match),
      };
    });
};

export const applyMatchAction = (
  state: EngineState,
  personaId: PersonaId,
  matchId: string,
  action: MatchAction,
): MatchRecord | null => {
  const match = state.matches.find(
    (candidate) => candidate.matchId === matchId,
  );
  if (!match) return null;
  if (match.personaA !== personaId && match.personaB !== personaId) return null;

  if (action === "accept") {
    if (match.status === "proposed") {
      match.status = "accepted";
    }
    return match;
  }

  if (action === "decline") {
    match.status = "canceled";
    return match;
  }

  return match;
};
