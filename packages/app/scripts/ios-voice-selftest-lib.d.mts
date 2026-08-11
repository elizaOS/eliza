/** Type surface shared by the renderer and host-side verifier. */
export interface IosVoiceSelfTestVerdict {
  pass: boolean;
  reasons: string[];
  stageStatuses: Record<string, string>;
  transcript: string;
  reply: string;
  overall: string;
}

export function evaluateVoiceSelfTestReport(
  report: unknown,
  options?: { requireLocalInference?: boolean },
): IosVoiceSelfTestVerdict;
