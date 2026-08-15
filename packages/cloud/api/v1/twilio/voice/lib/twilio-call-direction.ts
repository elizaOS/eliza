/** Resolves the public Eliza line and remote caller for either PSTN direction. */

export interface TwilioCallParticipants {
  publicLineNumber: string;
  callerNumber: string;
  outbound: boolean;
}

export function resolveTwilioCallParticipants(input: {
  direction?: string;
  from: string;
  to: string;
}): TwilioCallParticipants {
  const outbound = input.direction === "outbound-api";
  return {
    publicLineNumber: outbound ? input.from : input.to,
    callerNumber: outbound ? input.to : input.from,
    outbound,
  };
}
