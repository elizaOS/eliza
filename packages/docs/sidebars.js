/**
 * ElizaOS Documentation Sidebars
 * Two-track documentation system: Simple (Vibecoders) and Technical (Developers)
 */

/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  // Simple documentation track for non-technical users
  simpleSidebar: [
    {
      type: 'doc',
      id: 'index',
      label: '🏠 Home',
    },
    {
      type: 'category',
      label: '🚀 Getting Started',
      items: [
        'simple/getting-started/quick-start',
        'simple/getting-started/first-agent',
        'simple/getting-started/troubleshooting',
      ],
    },
    {
      type: 'category',
      label: '🎨 Templates & Examples',
      items: [
        'simple/templates/gallery',
        'simple/templates/customization',
        {
          type: 'category',
          label: 'Examples',
          items: [
            'simple/templates/examples/friendly-assistant',
            'simple/templates/examples/gaming-buddy',
            'simple/templates/examples/creative-muse',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: '📚 Guides',
      items: [
        'simple/guides/character-creation',
        'simple/guides/plugin-usage',
        'simple/guides/discord-setup',
        'simple/guides/twitter-setup',
        'simple/guides/deployment',
      ],
    },
    {
      type: 'doc',
      id: 'simple/faq',
      label: '❓ FAQ',
    },
  ],

  // Technical documentation track for developers
  technicalSidebar: [
    {
      type: 'doc',
      id: 'index',
      label: '🏠 Home',
    },
    {
      type: 'category',
      label: '🏗️ Architecture',
      items: [
        'technical/architecture/overview',
        'technical/architecture/core-concepts',
        'technical/architecture/state-management',
        'technical/architecture/plugin-system',
        'technical/architecture/memory-system',
        'technical/architecture/security-model',
      ],
    },
    {
      type: 'category',
      label: '💻 Development',
      items: [
        'technical/development/environment-setup',
        'technical/development/monorepo-guide',
        'technical/development/standalone-guide',
        'technical/development/plugin-development',
        'technical/development/testing-guide',
        'technical/development/debugging',
      ],
    },
    {
      type: 'category',
      label: '📖 API Reference',
      items: [
        'technical/api-reference/core-api',
        'technical/api-reference/runtime-api',
        'technical/api-reference/memory-api',
        'technical/api-reference/plugin-api',
        'technical/api-reference/service-api',
        'technical/api-reference/types',
      ],
    },
    {
      type: 'category',
      label: '🚀 Advanced Topics',
      items: [
        'technical/advanced/performance',
        'technical/advanced/scaling',
        'technical/advanced/security',
        'technical/advanced/deployment',
        'technical/advanced/monitoring',
        'technical/advanced/best-practices',
      ],
    },
    {
      type: 'doc',
      id: 'technical/faq',
      label: '❓ Technical FAQ',
    },
  ],

  // Overview sidebar for documentation structure
  overviewSidebar: [
    {
      type: 'doc',
      id: 'index',
      label: '🏠 Home',
    },
    {
      type: 'doc',
      id: 'overview/documentation-structure',
      label: '📚 Documentation Structure',
    },
    {
      type: 'category',
      label: '🎯 Simple Track',
      collapsed: true,
      items: ['simple/getting-started/quick-start', 'simple/templates/gallery', 'simple/faq'],
    },
    {
      type: 'category',
      label: '🔧 Technical Track',
      collapsed: true,
      items: [
        'technical/architecture/overview',
        'technical/development/plugin-development',
        'technical/faq',
      ],
    },
  ],
};

module.exports = sidebars;
