import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebar: SidebarsConfig = {
  apisidebar: [
    {
      type: 'doc',
      id: 'rest/eliza-os-api',
    },
    {
      type: 'category',
      label: 'system',
      items: [
        {
          type: 'doc',
          id: 'rest/get-hello',
          label: 'Basic health check',
          className: 'api-method get',
        },
        {
          type: 'doc',
          id: 'rest/get-status',
          label: 'Get system status',
          className: 'api-method get',
        },
        {
          type: 'doc',
          id: 'rest/get-health',
          label: 'Health check endpoint',
          className: 'api-method get',
        },
        {
          type: 'doc',
          id: 'rest/stop-server',
          label: 'Stop the server',
          className: 'api-method get',
        },
      ],
    },
    {
      type: 'category',
      label: 'agents',
      items: [
        {
          type: 'doc',
          id: 'rest/list-agents',
          label: 'List all agents',
          className: 'api-method get',
        },
        {
          type: 'doc',
          id: 'rest/create-agent',
          label: 'Create a new agent',
          className: 'api-method post',
        },
        {
          type: 'doc',
          id: 'rest/get-agent',
          label: 'Get agent details',
          className: 'api-method get',
        },
        {
          type: 'doc',
          id: 'rest/start-agent',
          label: 'Start an agent',
          className: 'api-method post',
        },
        {
          type: 'doc',
          id: 'rest/update-agent',
          label: 'Update agent',
          className: 'api-method patch',
        },
        {
          type: 'doc',
          id: 'rest/stop-agent',
          label: 'Stop an agent',
          className: 'api-method put',
        },
        {
          type: 'doc',
          id: 'rest/delete-agent',
          label: 'Delete an agent',
          className: 'api-method delete',
        },
        {
          type: 'doc',
          id: 'rest/get-agent-logs',
          label: 'Get agent logs',
          className: 'api-method get',
        },
        {
          type: 'doc',
          id: 'rest/delete-agent-log',
          label: 'Delete an agent log',
          className: 'api-method delete',
        },
        {
          type: 'doc',
          id: 'rest/get-agent-memories',
          label: 'Get agent memories',
          className: 'api-method get',
        },
        {
          type: 'doc',
          id: 'rest/update-memory',
          label: 'Update a memory',
          className: 'api-method patch',
        },
        {
          type: 'doc',
          id: 'rest/delete-memory',
          label: 'Delete a memory',
          className: 'api-method delete',
        },
        {
          type: 'doc',
          id: 'rest/get-agent-rooms',
          label: 'Get agent rooms',
          className: 'api-method get',
        },
        {
          type: 'doc',
          id: 'rest/create-room',
          label: 'Create a room',
          className: 'api-method post',
        },
        {
          type: 'doc',
          id: 'rest/get-room',
          label: 'Get room details',
          className: 'api-method get',
        },
        {
          type: 'doc',
          id: 'rest/update-room',
          label: 'Update a room',
          className: 'api-method patch',
        },
        {
          type: 'doc',
          id: 'rest/delete-room',
          label: 'Delete a room',
          className: 'api-method delete',
        },
        {
          type: 'doc',
          id: 'rest/get-room-memories',
          label: 'Get room memories',
          className: 'api-method get',
        },
        {
          type: 'doc',
          id: 'rest/send-message',
          label: 'Send a message to an agent',
          className: 'api-method post',
        },
        {
          type: 'doc',
          id: 'rest/send-audio-message',
          label: 'Send an audio message',
          className: 'api-method post',
        },
        {
          type: 'doc',
          id: 'rest/synthesize-speech',
          label: 'Convert text to speech',
          className: 'api-method post',
        },
        {
          type: 'doc',
          id: 'rest/generate-speech',
          label: 'Generate speech from text',
          className: 'api-method post',
        },
        {
          type: 'doc',
          id: 'rest/conversation-to-speech',
          label: 'Process conversation and return speech',
          className: 'api-method post',
        },
        {
          type: 'doc',
          id: 'rest/transcribe-audio',
          label: 'Transcribe audio to text',
          className: 'api-method post',
        },
      ],
    },
    {
      type: 'category',
      label: 'rooms',
      items: [
        {
          type: 'doc',
          id: 'rest/get-agent-rooms',
          label: 'Get agent rooms',
          className: 'api-method get',
        },
        {
          type: 'doc',
          id: 'rest/create-room',
          label: 'Create a room',
          className: 'api-method post',
        },
        {
          type: 'doc',
          id: 'rest/get-room',
          label: 'Get room details',
          className: 'api-method get',
        },
        {
          type: 'doc',
          id: 'rest/update-room',
          label: 'Update a room',
          className: 'api-method patch',
        },
        {
          type: 'doc',
          id: 'rest/delete-room',
          label: 'Delete a room',
          className: 'api-method delete',
        },
        {
          type: 'doc',
          id: 'rest/get-room-memories',
          label: 'Get room memories',
          className: 'api-method get',
        },
      ],
    },
    {
      type: 'category',
      label: 'messages',
      items: [
        {
          type: 'doc',
          id: 'rest/send-message',
          label: 'Send a message to an agent',
          className: 'api-method post',
        },
      ],
    },
    {
      type: 'category',
      label: 'memories',
      items: [
        {
          type: 'doc',
          id: 'rest/get-agent-memories',
          label: 'Get agent memories',
          className: 'api-method get',
        },
        {
          type: 'doc',
          id: 'rest/update-memory',
          label: 'Update a memory',
          className: 'api-method patch',
        },
        {
          type: 'doc',
          id: 'rest/delete-memory',
          label: 'Delete a memory',
          className: 'api-method delete',
        },
        {
          type: 'doc',
          id: 'rest/get-room-memories',
          label: 'Get room memories',
          className: 'api-method get',
        },
      ],
    },
    {
      type: 'category',
      label: 'logs',
      items: [
        {
          type: 'doc',
          id: 'rest/get-logs',
          label: 'Get system logs',
          className: 'api-method get',
        },
        {
          type: 'doc',
          id: 'rest/post-logs',
          label: 'Get system logs (POST)',
          className: 'api-method post',
        },
        {
          type: 'doc',
          id: 'rest/get-agent-logs',
          label: 'Get agent logs',
          className: 'api-method get',
        },
        {
          type: 'doc',
          id: 'rest/delete-agent-log',
          label: 'Delete an agent log',
          className: 'api-method delete',
        },
        {
          type: 'doc',
          id: 'rest/query-tee-logs',
          label: 'Query TEE logs',
          className: 'api-method post',
        },
      ],
    },
    {
      type: 'category',
      label: 'speech',
      items: [
        {
          type: 'doc',
          id: 'rest/send-audio-message',
          label: 'Send an audio message',
          className: 'api-method post',
        },
        {
          type: 'doc',
          id: 'rest/synthesize-speech',
          label: 'Convert text to speech',
          className: 'api-method post',
        },
        {
          type: 'doc',
          id: 'rest/generate-speech',
          label: 'Generate speech from text',
          className: 'api-method post',
        },
        {
          type: 'doc',
          id: 'rest/conversation-to-speech',
          label: 'Process conversation and return speech',
          className: 'api-method post',
        },
        {
          type: 'doc',
          id: 'rest/transcribe-audio',
          label: 'Transcribe audio to text',
          className: 'api-method post',
        },
      ],
    },
    {
      type: 'category',
      label: 'tee',
      items: [
        {
          type: 'doc',
          id: 'rest/list-tee-agents',
          label: 'List TEE agents',
          className: 'api-method get',
        },
        {
          type: 'doc',
          id: 'rest/get-tee-agent',
          label: 'Get TEE agent details',
          className: 'api-method get',
        },
        {
          type: 'doc',
          id: 'rest/query-tee-logs',
          label: 'Query TEE logs',
          className: 'api-method post',
        },
      ],
    },
  ],
};

export default sidebar.apisidebar;
