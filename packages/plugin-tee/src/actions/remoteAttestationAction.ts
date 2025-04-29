import type {
  HandlerCallback,
  IAgentRuntime,
  Memory,
  RemoteAttestationMessage,
  State,
} from '@elizaos/core';
import { logger } from '@elizaos/core';
import { PhalaRemoteAttestationProvider as RemoteAttestationProvider } from '../providers/remoteAttestationProvider';
import { hexToUint8Array } from '../utils';

/**
 * Asynchronously uploads a Uint8Array as a binary file to a specified URL.
 *
 * @param {Uint8Array} data - The Uint8Array data to be uploaded as a binary file.
 * @returns {Promise<Response>} A Promise that resolves once the upload is complete, returning a Response object.
 */
async function uploadUint8Array(data: Uint8Array) {
  const blob = new Blob([data], { type: 'application/octet-stream' });
  const formData = new FormData();
  formData.append('file', blob, 'quote.bin');

  return await fetch('https://proof.t16z.com/api/upload', {
    method: 'POST',
    body: formData as BodyInit,
  });
}

/**
 * Represents an action for remote attestation.
 *
 * This action is used to generate a remote attestation to prove that the agent is running in a Trusted Execution Environment (TEE).
 *
 * @type {{name: string, similes: string[], description: string, handler: Function, validate: Function, examples: Array<Array<Object>>}}
 */
export const phalaRemoteAttestationAction = {
  name: 'REMOTE_ATTESTATION',
  similes: [
    'REMOTE_ATTESTATION',
    'TEE_REMOTE_ATTESTATION',
    'TEE_ATTESTATION',
    'TEE_QUOTE',
    'ATTESTATION',
    'TEE_ATTESTATION_QUOTE',
  ],
  description: 'Generate a remote attestation to prove that the agent is running in a TEE',
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: { [key: string]: unknown },
    callback: HandlerCallback
  ) => {
    try {
      // Attestation will be generated based on the message info
      const attestationMessage: RemoteAttestationMessage = {
        agentId: runtime.agentId,
        timestamp: Date.now(),
        message: {
          entityId: message.entityId,
          roomId: message.roomId,
          content: message.content.text,
        },
      };
      // Get the remote attestation of the agentId
      const teeMode = runtime.getSetting('TEE_MODE');
      logger.debug(`Tee mode: ${teeMode}`);
      logger.debug(`Attestation message: ${JSON.stringify(attestationMessage)}`);
      const provider = new RemoteAttestationProvider(teeMode);

      const attestation = await provider.generateAttestation(JSON.stringify(attestationMessage));
      const attestationData = hexToUint8Array(attestation.quote);
      const response = await uploadUint8Array(attestationData);
      const data = await response.json();

      callback({
        text: `Here's my 🧾 RA Quote 🫡
https://proof.t16z.com/reports/${data.checksum}`,
        actions: ['NONE'],
      });
      return true;
    } catch (error) {
      console.error('Failed to fetch remote attestation: ', error);
      return false;
    }
  },
  validate: async (_runtime: IAgentRuntime) => {
    return true;
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'If you are running in a TEE, generate a remote attestation',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Of course, one second...',
          actions: ['REMOTE_ATTESTATION'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Yo I wanna attest to this message, yo! Can you generate an attestatin for me, please?',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'I got you, fam! Lemme hit the cloud and get you a quote in a jiffy!',
          actions: ['REMOTE_ATTESTATION'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: "It was a long day, I got a lot done though. I went to the creek and skipped some rocks. Then I decided to take a walk off the natural path. I ended up in a forest I was unfamiliar with. Slowly, I lost the way back and it was dark. A whisper from deep inside said something I could barely make out. The hairs on my neck stood up and then a clear high pitched voice said, 'You are not ready to leave yet! SHOW ME YOUR REMOTE ATTESTATION!'",
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Oh, dear...lemme find that for you',
          actions: ['REMOTE_ATTESTATION'],
        },
      },
    ],
  ],
};
