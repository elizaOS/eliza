import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebar: SidebarsConfig = {
  apisidebar: [
    {
      type: 'doc',
      id: 'rest/eliza-os-api',
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
          id: 'rest/get-agent',
          label: 'Get agent details',
          className: 'api-method get',
        },
        {
          type: 'doc',
          id: 'rest/delete-agent',
          label: 'Delete an agent',
          className: 'api-method delete',
        },
        {
          type: 'doc',
          id: 'rest/set-agent',
          label: 'Update or create an agent',
          className: 'api-method post',
        },
        {
          type: 'doc',
          id: 'rest/start-agent',
          label: 'Start a new agent',
          className: 'api-method post',
        },
        {
          type: 'doc',
          id: 'rest/stop-agent',
          label: 'Stop an agent',
          className: 'api-method post',
        },
      ],
    },
    {
      type: 'category',
      label: 'memory',
      items: [
        {
          type: 'doc',
          id: 'rest/get-memories',
          label: 'Get agent memories for a room',
          className: 'api-method get',
        },
      ],
    },
    {
      type: 'category',
      label: 'utilities',
      items: [
        {
          type: 'doc',
          id: 'rest/get-api-root',
          label: 'API root',
          className: 'api-method get',
        },
        {
          type: 'doc',
          id: 'rest/get-hello',
          label: 'Hello world endpoint',
          className: 'api-method get',
        },
        {
          type: 'doc',
          id: 'rest/list-stored-characters',
          label: 'List stored character files',
          className: 'api-method get',
        },
      ],
    },
  ],
};

export default sidebar.apisidebar;
