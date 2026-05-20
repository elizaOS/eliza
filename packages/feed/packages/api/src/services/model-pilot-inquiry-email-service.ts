import {
  calculateModelPilotEstimateRange,
  type ModelPilotDeliverable,
  type ModelPilotOutput,
  type ModelPilotReviewLevel,
  type ModelPilotScenario,
} from '@babylon/shared';
import { escapeHtml } from '../utils/html';
import {
  normalizeEmail,
  resolveSendGridConfig,
  sendViaSendGrid,
} from './email-utils';

const DEFAULT_NOTIFY_EMAIL = 'babylon@elizalabs.ai';

export interface ModelPilotInquiryPayload {
  senderEmail: string;
  modelProvider: string;
  modelName: string;
  apiEndpoint: string;
  toolUse: boolean;
  memory: boolean;
  deliverables: ModelPilotDeliverable[];
  scenarios: ModelPilotScenario[];
  outputs: ModelPilotOutput[];
  concurrentAgents: number;
  scenarioRuns: number;
  humanReview: ModelPilotReviewLevel;
  privateDeployment: boolean;
  dataExclusivity: boolean;
}

function buildPlainTextSummary(payload: ModelPilotInquiryPayload): string {
  const estimate = calculateModelPilotEstimateRange({
    deliverables: payload.deliverables,
    review: payload.humanReview,
    privateDeployment: payload.privateDeployment,
    dataExclusivity: payload.dataExclusivity,
    concurrentAgents: payload.concurrentAgents,
    scenarioRuns: payload.scenarioRuns,
  });

  const lines = [
    'Model pilot inquiry',
    '',
    `Contact: ${payload.senderEmail}`,
    `Model provider: ${payload.modelProvider || '(not provided)'}`,
    `Model name: ${payload.modelName || '(not provided)'}`,
    `API endpoint: ${payload.apiEndpoint || '(not provided)'}`,
    `Tool use: ${payload.toolUse ? 'yes' : 'no'}`,
    `Memory: ${payload.memory ? 'yes' : 'no'}`,
    '',
    `Deliverables: ${payload.deliverables.join(', ') || '(none)'}`,
    `Scenarios: ${payload.scenarios.join(', ') || '(none)'}`,
    `Outputs: ${payload.outputs.join(', ') || '(none)'}`,
    '',
    `Concurrent agents: ${payload.concurrentAgents}`,
    `Scenario runs: ${payload.scenarioRuns}`,
    `Human review: ${payload.humanReview}`,
    `Private deployment: ${payload.privateDeployment ? 'yes' : 'no'}`,
    `Data exclusivity: ${payload.dataExclusivity ? 'yes' : 'no'}`,
    '',
    `Estimated range (indicative): ${estimate}`,
    '',
    'This request was submitted through the Babylon model pilot form.',
  ];

  return lines.join('\n');
}

function buildHtmlSummary(payload: ModelPilotInquiryPayload): string {
  const text = buildPlainTextSummary(payload);
  const escaped = escapeHtml(text).replace(/\n/g, '<br/>');
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
      <h1 style="font-size:18px;margin:0 0 16px;">Model pilot inquiry</h1>
      <p style="font-size:14px;line-height:1.6;color:#222;margin:0;">${escaped}</p>
    </div>
  `;
}

function getNotifyEmail(): string {
  const fromEnv = process.env.MODEL_PILOT_INQUIRY_NOTIFY_EMAIL?.trim();
  if (fromEnv && normalizeEmail(fromEnv)) {
    return normalizeEmail(fromEnv) as string;
  }
  return DEFAULT_NOTIFY_EMAIL;
}

/**
 * Sends one message to the internal team and one to the submitter in a single
 * SendGrid request (different subjects; same body; recipients are not exposed
 * to each other).
 */
export async function sendModelPilotInquiryEmails(
  payload: ModelPilotInquiryPayload
): Promise<{ sent: boolean; reason?: string }> {
  const logContext = { notifyEmail: getNotifyEmail() };
  const config = resolveSendGridConfig('ModelPilotInquiry', logContext);
  if (!config) {
    return { sent: false, reason: 'provider_not_configured' };
  }

  const notifyTo = getNotifyEmail();
  const sender = normalizeEmail(payload.senderEmail);
  if (!sender) {
    return { sent: false, reason: 'invalid_sender_email' };
  }

  const text = buildPlainTextSummary(payload);
  const html = buildHtmlSummary(payload);

  const internalSubject = `[Babylon] Model pilot inquiry from ${sender}`;
  const senderSubject = 'We received your Babylon model pilot request';

  return sendViaSendGrid(
    config.apiKey,
    {
      from: config.from,
      subject: internalSubject,
      personalizations: [
        { to: [{ email: notifyTo }], subject: internalSubject },
        { to: [{ email: sender }], subject: senderSubject },
      ],
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html },
      ],
    },
    'ModelPilotInquiry',
    logContext
  );
}
