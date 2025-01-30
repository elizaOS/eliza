export type MatchData = {
    league: string;
    matches: Array<{
        homeTeam: string;
        awayTeam: string;
        score: string;
        status: string;
        events: string[];
    }>;
};

export type StandingsData = {
    league: string;
    standings: Array<{
        position: number;
        team: string;
        points: number;
        goalDifference: number;
    }>;
};
