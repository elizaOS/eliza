// src/components/HomepageFeatures/index.jsx
import React from 'react';
import clsx from 'clsx';
import Heading from '@theme/Heading';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

const FeatureList = [
  {
    icon: '🤖',
    title: 'Multi-Agent Framework',
    description: (
      <>
        Build and deploy <strong>autonomous AI agents</strong> with consistent personalities across
        platforms. Full support for voice, text, and media interactions.
      </>
    ),
    link: '/docs/core/agents',
  },
  {
    icon: '🧠',
    title: 'Knowledge Management',
    description: (
      <>
        Powerful RAG system with document processing and semantic search. Import PDFs, markdown, and
        text files to build comprehensive knowledge bases.
      </>
    ),
    link: '/docs/core/knowledge',
  },
  {
    icon: '🔌',
    title: 'Extensible Design',
    description: (
      <>
        Create custom actions, add new platform integrations, and extend functionality through a{' '}
        <b>modular plugin system</b>. Full TypeScript support.
      </>
    ),
    link: '/docs/core/plugins',
  },
  {
    icon: '💭',
    title: 'Self-Reflection',
    description: (
      <>
        Agents learn from interactions through built-in reflection mechanisms that extract facts,
        build relationships, and improve responses over time.
      </>
    ),
    link: '/docs/core/reflection',
  },
  {
    icon: '💬',
    title: 'Platform Integrations',
    description: (
      <>
        Connect seamlessly with Discord, Twitter, Telegram, Slack, Farcaster, and more through
        standardized service abstractions.
      </>
    ),
    link: '/docs/core/services',
  },
  {
    icon: '🌐',
    title: 'Worlds & Rooms',
    description: (
      <>
        Organize interactions with flexible world and room structures. Create multi-agent
        environments with defined relationships and contexts.
      </>
    ),
    link: '/docs/core/worlds',
  },
  {
    icon: '⚡',
    title: 'Action System',
    description: (
      <>
        Define agent capabilities with the actions system. From simple replies to complex
        interactions like blockchain transactions or content generation.
      </>
    ),
    link: '/docs/core/actions',
  },
  {
    icon: '📅',
    title: 'Task Management',
    description: (
      <>
        Schedule activities, implement reminders, and create multi-step workflows with the built-in
        task system for deferred and recurring operations.
      </>
    ),
    link: '/docs/core/tasks',
  },
  {
    icon: '👤',
    title: 'Entity-Component Architecture',
    description: (
      <>
        Flexible data modeling with entities, components, and relationships. Build rich
        representations of users, objects, and their connections.
      </>
    ),
    link: '/docs/core/entities',
  },
];

const QuickActionsList = [
  {
    image: '/img/eliza_banner.jpg',
    title: 'Create an Agent',
    description: (
      <>
        Get started building your first <strong>autonomous AI agent</strong> with our step-by-step
        quickstart.
        <div className={styles.secondaryLinks}>
          <a href="/docs/quickstart" className={styles.secondaryLink}>
            <span className={styles.secondaryLinkIcon}>📋</span> View Quickstart Guide
          </a>
        </div>
      </>
    ),
    link: '/docs/quickstart',
  },
  {
    image: '/img/montage-plugins.jpg',
    title: 'Discover Plugins',
    description: (
      <>
        Explore the ecosystem of plugins that extend your agent's abilities and integrations across
        platforms.
      </>
    ),
    link: '/packages',
  },
  {
    image: '/img/banner2.png',
    title: 'Get Inspired',
    description: (
      <>
        Browse examples and resources from the community to spark ideas for your next AI agent
        project.
      </>
    ),
    link: '/docs/intro',
  },
];

const UseCases = [
  {
    title: 'Social Media Personas',
    description:
      'Create autonomous agents that post content, respond to mentions, and engage with followers',
    icon: '💬',
  },
  {
    title: 'Community Managers',
    description: 'Build AI moderators that enforce rules, answer questions, and foster engagement',
    icon: '👥',
  },
  {
    title: 'Autonomous Traders',
    description: 'Deploy agents that monitor markets, execute trades, and manage portfolios',
    icon: '📈',
  },
  {
    title: 'Content Creation',
    description: 'Generate blog posts, newsletters, and social content with consistent voice',
    icon: '✍️',
  },
];

function Feature({ icon, title, description, link, image }) {
  return (
    <div className={styles.featureCard}>
      <div className={styles.featureIconWrapper}>
        {image ? (
          <img src={image} alt={title} className={styles.featureImage} />
        ) : (
          <div className={styles.featureIcon}>{icon}</div>
        )}
      </div>
      <div className={styles.featureContent}>
        <Heading as="h3" className={styles.featureTitle}>
          {title}
        </Heading>
        <div className={styles.featureDescription}>{description}</div>
        {link && (
          <Link className={styles.featureLink} to={link}>
            Learn more <span className={styles.arrowIcon}>→</span>
          </Link>
        )}
      </div>
    </div>
  );
}

function ClickableFeature({ icon, title, description, link, image }) {
  return (
    <Link to={link} className={styles.cardLink}>
      <div className={styles.featureCard}>
        <div className={styles.featureIconWrapper}>
          {image ? (
            <img src={image} alt={title} className={styles.featureImage} />
          ) : (
            <div className={styles.featureIcon}>{icon}</div>
          )}
        </div>
        <div className={styles.featureContent}>
          <Heading as="h3" className={styles.featureTitle}>
            {title}
          </Heading>
          <div className={styles.featureDescription}>{description}</div>
        </div>
      </div>
    </Link>
  );
}

function UseCase({ title, description, icon }) {
  return (
    <div className={styles.useCaseItem}>
      <div className={styles.useCaseIcon}>{icon}</div>
      <div className={styles.useCaseContent}>
        <h4 className={styles.useCaseTitle}>{title}</h4>
        <p className={styles.useCaseDescription}>{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures({ type = 'features', showUseCases = true }) {
  const renderFeatures = () => (
    <>
      <div className={styles.sectionHeader}>
        <Heading as="h2" className={styles.sectionTitle}>
          Core Features
        </Heading>
        <p className={styles.sectionSubtitle}>
          Everything you need to build powerful AI agents with personality and purpose
        </p>
      </div>

      <div className={styles.featureGrid}>
        {FeatureList.map((props, idx) => (
          <Feature key={idx} {...props} />
        ))}
      </div>

      {showUseCases && (
        <>
          <div className={styles.sectionDivider}></div>

          <div className={styles.sectionHeader}>
            <Heading as="h2" className={styles.sectionTitle}>
              Use Cases
            </Heading>
            <p className={styles.sectionSubtitle}>Versatile applications across various domains</p>
          </div>

          <div className={styles.useCaseGrid}>
            {UseCases.map((useCase, idx) => (
              <UseCase key={idx} {...useCase} />
            ))}
          </div>

          <div className={styles.actionSection}>
            <Link to="/docs/intro" className="button button--primary button--lg">
              Get Started with Eliza
            </Link>
            <Link to="/community" className={styles.communityLink}>
              Join our Community <span className={styles.arrowIcon}>→</span>
            </Link>
          </div>
        </>
      )}
    </>
  );

  const renderQuickActions = () => (
    <>
      <div className={styles.sectionHeader}>
        <Heading as="h2" className={styles.sectionTitle}>
          Quick Actions
        </Heading>
        <p className={styles.sectionSubtitle}>Everything you need to get started with elizaOS</p>
      </div>
      <div className={styles.featureGrid}>
        {QuickActionsList.map((props, idx) => (
          <ClickableFeature key={idx} {...props} />
        ))}
      </div>
    </>
  );

  return (
    <section className={styles.features}>
      <div className="container">
        {type === 'quickactions' ? renderQuickActions() : renderFeatures()}
      </div>
    </section>
  );
}
