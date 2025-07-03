import dotenv from 'dotenv';
import * as Plugin from '@docusaurus/types/src/plugin';
import type * as OpenApiPlugin from 'docusaurus-plugin-openapi-docs';

dotenv.config();

const config = {
  title: 'eliza',
  tagline: 'Flexible, scalable AI agents for everyone',
  favicon: 'img/favicon.ico',
  url: 'https://eliza.how',
  baseUrl: '/',
  organizationName: 'elizaos',
  projectName: 'eliza',
  deploymentBranch: 'gh-pages',
  trailingSlash: false,
  onBrokenLinks: 'ignore',
  onBrokenMarkdownLinks: 'warn',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },
  markdown: {
    mermaid: true,
    mdx1Compat: {
      comments: false,
      admonitions: false,
      headingIds: false,
    },
  },
  themes: ['@docusaurus/theme-mermaid', 'docusaurus-theme-openapi-docs'],
  plugins: [
    [
      '@docusaurus/plugin-content-docs',
      {
        id: 'partners',
        path: './partners',
        routeBasePath: 'partners',
        sidebarItemsGenerator: async ({ defaultSidebarItemsGenerator, ...args }) => {
          const sidebarItems = await defaultSidebarItemsGenerator(args);
          return sidebarItems
            .map((item) => {
              if (item.type === 'category') {
                item.label = '🤝 ' + item.label;
              }
              return item;
            })
            .sort((a, b) => {
              const labelA = a.label || '';
              const labelB = b.label || '';
              return labelA.localeCompare(labelB, undefined, {
                numeric: true,
              });
            });
        },
      },
    ],
    [
      '@docusaurus/plugin-content-docs',
      {
        id: 'community',
        path: 'community',
        routeBasePath: 'community',
        sidebarItemsGenerator: async ({ defaultSidebarItemsGenerator, ...args }) => {
          const sidebarItems = await defaultSidebarItemsGenerator(args);
          return sidebarItems
            .map((item) => {
              if (item.type === 'category') {
                switch (item.label.toLowerCase()) {
                  case 'streams':
                    item.label = '📺 ' + item.label;
                    break;
                  case 'development':
                    item.label = '💻 ' + item.label;
                    break;
                  case 'the_arena':
                    item.label = '🏟️ ' + item.label;
                    break;
                  default:
                    item.label = '📄 ' + item.label;
                }
              }
              return item;
            })
            .sort((a, b) => {
              const labelA = a.label || '';
              const labelB = b.label || '';
              return labelA.localeCompare(labelB, undefined, {
                numeric: true,
              });
            });
        },
      },
    ],
    [
      '@docusaurus/plugin-content-docs',
      {
        id: 'packages',
        path: 'packages',
        routeBasePath: 'packages',
        includeCurrentVersion: true,
        sidebarItemsGenerator: async ({ defaultSidebarItemsGenerator, ...args }) => {
          const sidebarItems = await defaultSidebarItemsGenerator(args);
          // Add icons to categories
          return sidebarItems
            .map((item) => {
              if (item.type === 'category') {
                switch (item.label.toLowerCase()) {
                  case 'adapters':
                    item.label = '🔌 ' + item.label;
                    break;
                  case 'clients':
                    item.label = '🔗 ' + item.label;
                    break;
                  case 'plugins':
                    item.label = '🧩 ' + item.label;
                    break;
                  default:
                    item.label = '📦 ' + item.label;
                }
              }
              return item;
            })
            .sort((a, b) => {
              const labelA = a.label || '';
              const labelB = b.label || '';
              return labelA.localeCompare(labelB, undefined, {
                numeric: true,
              });
            });
        },
      },
    ],
    [
      'docusaurus-plugin-typedoc',
      {
        entryPoints: ['../core/src/index.ts'],
        tsconfig: '../core/tsconfig.json',
        out: './api',
        skipErrorChecking: true,
        excludeExternals: false,
        excludePrivate: true,
        excludeProtected: false,
        excludeInternal: false,
        excludeNotDocumented: true,
        plugin: ['typedoc-plugin-markdown'],
        hideGenerator: true,
        cleanOutputDir: true,
        categorizeByGroup: true,
        pretty: true,
        includeVersion: true,
        sort: ['source-order', 'required-first', 'visibility'],
        gitRevision: 'main',
        readme: 'none',
        commentStyle: 'block',
        preserveAnchorCasing: true,
        hideBreadcrumbs: false,
        preserveWatchOutput: true,
        disableSources: false,
        validation: {
          notExported: true,
          invalidLink: true,
          notDocumented: false,
        },
        exclude: [
          '**/_media/**',
          '**/node_modules/**',
          '**/dist/**',
          '**/*.test.ts',
          '**/*.spec.ts',
        ],
        watch: false,
        treatWarningsAsErrors: true,
        treatValidationWarningsAsErrors: true,
        searchInComments: true,
        navigationLinks: {
          GitHub: 'https://github.com/elizaos/eliza',
          Documentation: '/docs/intro',
        },
      },
    ],
    require.resolve('docusaurus-lunr-search'),
    [
      '@docusaurus/plugin-content-docs',
      {
        id: 'api',
        path: 'api',
        routeBasePath: 'api',
      },
    ],
    [
      'docusaurus-plugin-openapi-docs',
      {
        id: 'rest-api',
        docsPluginId: 'classic',
        config: {
          eliza_api: {
            specPath: './src/openapi/eliza-v1.yaml',
            outputDir: 'docs/rest',
            sidebarOptions: {
              groupPathsBy: 'tag',
            },
          },
        },
      },
    ],
    [
      '@docusaurus/plugin-content-blog',
      {
        showReadingTime: true,
        onUntruncatedBlogPosts: 'ignore',
        editUrl: 'https://github.com/elizaos/eliza/tree/develop/docs',
        blogSidebarTitle: 'Recent posts',
        blogSidebarCount: 'ALL',
        showLastUpdateAuthor: true,
        feedOptions: {
          type: 'all',
          title: 'ElizaOS Updates',
          description: 'Stay up to date with the latest from ElizaOS',
        },
        path: 'blog',
        routeBasePath: 'blog',
      },
    ],
  ],
  presets: [
    [
      '@docusaurus/preset-classic',
      {
        blog: {
          id: 'News',
          routeBasePath: 'news',
          onUntruncatedBlogPosts: 'ignore',
          blogTitle: 'AI News',
          blogDescription: 'Automated aggregating and summarization of elizaOS ecosystem updates',
          showReadingTime: true,
          editUrl: 'https://github.com/elizaos/eliza/tree/develop/packages/docs',
          blogSidebarTitle: 'All posts',
          blogSidebarCount: 'ALL',
          showLastUpdateAuthor: true,
          feedOptions: {
            type: 'all',
            title: 'ElizaOS Updates',
            description: 'Stay up to date with the latest from ElizaOS',
          },
          path: 'news',
        },
        docs: {
          docItemComponent: '@theme/ApiItem',
          sidebarPath: require.resolve('./sidebars.ts'),
          editUrl: 'https://github.com/elizaos/eliza/tree/develop/packages/docs/',
          exclude: ['**/_media/**'],
          showLastUpdateAuthor: true,
          showLastUpdateTime: true,
          lastVersion: 'current',
          versions: {
            current: {
              label: '1.0.10',
              path: '',
              banner: 'none',
            },
            '0.25.9': {
              label: '0.25.9',
              path: '0.25.9',
            },
          },
        },
        theme: {
          customCss: './src/css/custom.css',
        },
        sitemap: {
          lastmod: 'date',
          changefreq: 'weekly',
          ignorePatterns: ['/tags/**'],
          filename: 'sitemap.xml',
          createSitemapItems: async (params) => {
            const { defaultCreateSitemapItems, ...rest } = params;
            const items = await defaultCreateSitemapItems(rest);

            return items
              .filter((item) => !item.url.includes('/page/'))
              .map((item) => {
                let priority = 0.5;

                if (item.url === '/') {
                  priority = 1.0; // homepage
                } else if (item.url.startsWith('/docs') || item.url.startsWith('/packages')) {
                  priority = 0.8; // important docs
                } else if (item.url.startsWith('/api') || item.url.startsWith('/rest')) {
                  priority = 0.7; // API reference
                } else if (item.url.startsWith('/blog')) {
                  priority = 0.6; // blog updates
                } else if (item.url.startsWith('/news')) {
                  priority = 0.6; // news posts
                } else if (item.url.startsWith('/community')) {
                  priority = 0.4; // community contributions
                }

                return {
                  ...item,
                  priority,
                };
              });
          },
        },
      },
    ],
  ],
  themeConfig: {
    announcementBar: {
      id: 'llms_full_feature',
      content:
        '🔥 Interact with our full documentation using your favorite LLM! <a href="/llms-full.txt" target="_blank" rel="noopener noreferrer">Copy <code>llms-full.txt</code></a> to get started. ✨',
      backgroundColor: 'var(--ifm-color-warning-light)',
      textColor: '#1f1f1f',
      isCloseable: true,
    },
    prism: {
      theme: require('prism-react-renderer').themes.github,
      darkTheme: require('prism-react-renderer').themes.dracula,
      additionalLanguages: ['bash', 'shell-session', 'typescript', 'markdown'],
    },
    mermaid: {
      theme: {
        light: 'default',
        dark: 'dark',
      },
      options: {
        fontSize: 16,
        flowchart: {
          htmlLabels: true,
          padding: 20,
          nodeSpacing: 50,
          rankSpacing: 50,
          curve: 'cardinal',
        },
      },
    },
    colorMode: {
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },
    docs: {
      sidebar: {
        hideable: true,
        autoCollapseCategories: true,
      },
    },
    navbar: {
      title: 'elizaOS',
      logo: {
        alt: 'Eliza Logo',
        src: 'img/icon.png',
        srcDark: 'img/icon.png',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'tutorialSidebar',
          position: 'left',
          label: 'Documentation',
        },
        {
          type: 'dropdown',
          label: 'Learn',
          position: 'left',
          items: [
            {
              type: 'docSidebar',
              sidebarId: 'simpleSidebar',
              label: '🎯 Simple Track (Non-Technical)',
            },
            {
              type: 'docSidebar',
              sidebarId: 'technicalSidebar',
              label: '🔧 Technical Track (Developers)',
            },
          ],
        },
        {
          type: 'docsVersionDropdown',
          position: 'right',
        },
        {
          type: 'doc',
          docsPluginId: 'api',
          position: 'left',
          label: 'API',
          docId: 'index',
        },
        {
          type: 'dropdown',
          label: 'Packages',
          position: 'left',
          to: '/packages',
          items: [
            {
              label: 'Adapters',
              to: '/packages?tags=adapter',
            },
            {
              label: 'Clients',
              to: '/packages?tags=client',
            },
            {
              label: 'Plugins',
              to: '/packages?tags=plugin',
            },
          ],
        },
        {
          type: 'dropdown',
          label: 'Community',
          position: 'left',
          to: '/community',
          items: [
            {
              label: 'Partners',
              to: '/partners',
            },
            {
              label: 'Calendar',
              to: 'https://calendar.google.com/calendar/embed?src=c_ed31cea342d3e2236f549161e6446c3e407e5625ee7a355c0153befc7a602e7f%40group.calendar.google.com&ctz=America%2FToronto',
              target: '_blank',
            },
            {
              label: 'Video Gallery',
              to: '/community/videos',
            },
          ],
        },
        {
          type: 'dropdown',
          label: 'Blog',
          position: 'left',
          items: [
            {
              label: 'Main Blog',
              to: '/blog',
            },
            {
              label: 'GitHub Activity',
              href: 'https://elizaos.github.io/',
              target: '_blank',
              rel: 'noopener noreferrer',
            },
          ],
        },
        {
          href: '/blog',
          position: 'right',
          className: 'header-rss-link',
          'aria-label': 'RSS Feed',
          to: '/news',
          items: [
            { label: 'RSS (XML)', href: '/blog/rss.xml', target: '_blank' },
            { label: 'Atom', href: '/blog/atom.xml', target: '_blank' },
            { label: 'JSON Feed', href: '/blog/feed.json', target: '_blank' },
          ],
        },
        {
          href: 'https://github.com/elizaos/eliza',
          className: 'header-github-link',
          'aria-label': 'GitHub repository',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'General',
              href: './',
            },
            {
              label: 'llms.txt',
              href: 'https://eliza.how/llms.txt',
            },
            {
              label: 'llms-full.txt',
              href: 'https://eliza.how/llms-full.txt',
            },
          ],
        },
        {
          title: 'Community',
          items: [
            {
              label: 'Website',
              href: 'https://www.elizaos.ai/',
            },
            {
              label: 'Discord',
              href: 'https://discord.gg/elizaos',
            },
            {
              label: 'Twitter',
              href: 'https://twitter.com/elizaos',
            },
          ],
        },
        {
          title: 'More',
          items: [
            {
              label: 'Blog',
              href: '/blog',
            },
            {
              label: 'RSS',
              href: '/news/rss.xml',
            },
            {
              label: 'GitHub',
              href: 'https://github.com/elizaos/eliza',
            },
          ],
        },
      ],
    },
  },
  customFields: {
    GITHUB_ACCESS_TOKEN: process.env.GITHUB_ACCESS_TOKEN,
  },
};

export default config;
