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
        Discord, X, Telegram, and more. Full support for voice, text, and media interactions.
      </>
    ),
    link: '/docs/core/agents',
  },
  {
    icon: '🧠',
    title: 'Intelligent Abilities',
    description: (
      <>
        Built-in RAG memory system, document processing, media analysis. Supports 24+ AI providers
        like openrouter, Anthropic, Ollama, and others.
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
    link: '/docs/core/actions',
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

function Feature({ icon, title, description, link }) {
  return (
    <div className={styles.featureCard}>
      <div className={styles.featureIconWrapper}>
        <div className={styles.featureIcon}>{icon}</div>
      </div>
      <div className={styles.featureContent}>
        <Heading as="h3" className={styles.featureTitle}>
          {title}
        </Heading>
        <p className={styles.featureDescription}>{description}</p>
        {link && (
          <Link className={styles.featureLink} to={link}>
            Learn more <span className={styles.arrowIcon}>→</span>
          </Link>
        )}
      </div>
    </div>
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

export default function HomepageFeatures() {
  return (
    <section className={styles.features}>
      <div className="container">
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
      </div>
    </section>
  );
}
