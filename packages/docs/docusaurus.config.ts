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
              const labelA = a.label || ''; // Ensure `label` exists
              const labelB = b.label || ''; // Ensure `label` exists
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
        //entryPoints: ['../core/src/index.ts'],
        tsconfig: '../core/tsconfig.json',
        out: './api',
        skipErrorChecking: true,
        excludeExternals: false,
        excludePrivate: true,
        excludeProtected: false,
        excludeInternal: false,
        excludeNotDocumented: false,
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
        editUrl: 'https://github.com/elizaos/eliza/tree/v2-develop/docs/blog/',
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
          editUrl: 'https://github.com/elizaos/eliza/tree/v2-develop/packages/docs/news',
          blogSidebarTitle: 'All posts',
          blogSidebarCount: 'ALL',
          showLastUpdateAuthor: true,
          feedOptions: {
            type: 'all',
            title: 'ElizaOS Updates',
            description: 'Stay up to date with the latest from ElizaOS',
          },
          path: 'news',
          routeBasePath: 'news',
        },
        docs: {
          docItemComponent: '@theme/ApiItem',
          sidebarPath: require.resolve('./sidebars.ts'),
          editUrl: 'https://github.com/elizaos/eliza/tree/v2-develop/packages/docs/',
          exclude: ['**/_media/**'],
          showLastUpdateAuthor: true,
          showLastUpdateTime: true,
          lastVersion: 'current',
          versions: {
            current: {
              label: '1.0.0-beta',
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
          priority: 0.5,
          ignorePatterns: ['/tags/**'],
          filename: 'sitemap.xml',
          createSitemapItems: async (params) => {
            const { defaultCreateSitemapItems, ...rest } = params;
            const items = await defaultCreateSitemapItems(rest);
            return items.filter((item) => !item.url.includes('/page/'));
          },
        },
      },
    ],
  ],
  themeConfig: {
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
          type: 'doc',
          docsPluginId: 'packages',
          position: 'left',
          label: 'Packages',
          docId: 'index',
        },
        {
          type: 'doc',
          docsPluginId: 'community',
          position: 'left',
          label: 'Community',
          docId: 'index',
        },
        {
          to: 'blog',
          label: 'Blog',
          position: 'left',
        },
        {
          href: '/news',
          position: 'right',
          className: 'header-rss-link',
          'aria-label': 'RSS Feed',
          to: '/news',
          items: [
            { label: 'RSS (XML)', href: '/news/rss.xml', target: '_blank' },
            { label: 'Atom', href: '/news/atom.xml', target: '_blank' },
            { label: 'JSON Feed', href: '/news/feed.json', target: '_blank' },
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
              href: 'llms.txt',
            },
            {
              label: 'llms-full.txt',
              href: 'llms-full.txt',
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
