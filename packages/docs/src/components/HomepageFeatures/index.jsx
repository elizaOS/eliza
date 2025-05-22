// src/components/HomepageFeatures/index.jsx
import React from 'react';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import styles from './styles.module.css';
import clsx from 'clsx';

export default function HomepageFeatures() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <section className={styles.features}>
      <div className={styles.container}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Quick Actions</h2>
          <p className={styles.sectionSubtitle}>Get started with elizaOS in just a few clicks</p>
          <br></br>
        </div>

        <div className={styles.quickActions}>
          <div className={styles.actionCard}>
            <div className={styles.actionImageContainer}>
              <img
                src="/img/eliza_banner.jpg"
                alt="Create an Agent"
                className={styles.actionImage}
              />
            </div>
            <h3>🤖 Create an Agent</h3>
            <p>
              Get started building your first autonomous AI agent with our step-by-step quickstart.
            </p>
            <div className={styles.actionLinks}>
              <Link to="/docs/quickstart" className={styles.actionLink}>
                Start Building
              </Link>
              <Link to="/docs/quickstart" className={styles.secondaryLink}>
                <span className={styles.secondaryLinkIcon}>📋</span> View Quickstart Guide
              </Link>
            </div>
          </div>
          <div className={styles.actionCard}>
            <div className={styles.actionImageContainer}>
              <img src="/img/plugins.jpg" alt="Discover Plugins" className={styles.actionImage} />
            </div>
            <h3>🧩 Discover Plugins</h3>
            <p>
              Explore the ecosystem of plugins that extend your agent's abilities and integrations
              across platforms.
            </p>
            <div className={styles.actionLinks}>
              <Link to="/packages" className={styles.actionLink}>
                Browse Plugins
              </Link>
              <Link to="/packages" className={styles.secondaryLink}>
                <span className={styles.secondaryLinkIcon}>📋</span> See package showcase
              </Link>
            </div>
          </div>
          <div className={styles.actionCard}>
            <div className={styles.actionImageContainer}>
              <img src="/img/banner2.png" alt="Get Inspired" className={styles.actionImage} />
            </div>
            <h3>💡 Get Inspired</h3>
            <p>
              Browse examples and resources from the community to spark ideas for your next AI agent
              project.
            </p>
            <div className={styles.actionLinks}>
              <Link to="/docs/awesome-eliza" className={styles.actionLink}>
                Explore Resources
              </Link>
              <Link to="/docs/awesome-eliza" className={styles.secondaryLink}>
                <span className={styles.secondaryLinkIcon}>📋</span> View awesome-eliza
              </Link>
            </div>
          </div>
          <div className={styles.actionCard}>
            <div className={styles.actionImageContainer}>
              <img src="/img/partners.jpg" alt="Explore Partners" className={styles.actionImage} />
            </div>
            <h3>🤝 Explore Partners</h3>
            <p>Discover the organizations and projects collaborating within the Eliza ecosystem.</p>
            <div className={styles.actionLinks}>
              <Link to="/partners" className={styles.actionLink}>
                View Partners
              </Link>
              <Link to="/partners" className={styles.secondaryLink}>
                <span className={styles.secondaryLinkIcon}>📄</span> Partner Docs
              </Link>
            </div>
          </div>
          <div className={styles.actionCard}>
            <div className={styles.actionImageContainer}>
              <img src="/img/videos.jpg" alt="Video Gallery" className={styles.actionImage} />
            </div>
            <h3>🎬 Video Gallery</h3>
            <p>Watch demos, tutorials, and community showcases related to ElizaOS.</p>
            <div className={styles.actionLinks}>
              <Link to="/community/videos" className={styles.actionLink}>
                Watch Videos
              </Link>
              <Link to="/community/videos" className={styles.secondaryLink}>
                <span className={styles.secondaryLinkIcon}>▶️</span> Go to Gallery
              </Link>
            </div>
          </div>
          <div className={styles.actionCard}>
            <div className={styles.actionImageContainer}>
              <img src="/img/stats.png" alt="GitHub Activity" className={styles.actionImage} />
            </div>
            <h3>📊 GitHub Activity</h3>
            <p>See the latest GitHub news, project statistics, and contributor leaderboards.</p>
            <div className={styles.actionLinks}>
              <a
                href="https://elizaos.github.io/"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.actionLink}
              >
                View Stats
              </a>
              <a
                href="https://elizaos.github.io/"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.secondaryLink}
              >
                <span className={styles.secondaryLinkIcon}>🏆</span> Leaderboard
              </a>
            </div>
          </div>
        </div>
        <br></br>

        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Overview</h2>
          <p className={styles.sectionSubtitle}>Explore the core components that power elizaOS</p>
          <br></br>
        </div>

        <div className={styles.componentsOverview}>
          <div className={styles.componentsGrid}>
            <div className={styles.componentSection}>
              <h3>Core Components</h3>
              <div className={styles.componentImageGrid}>
                <div className={styles.componentImageCard}>
                  <img
                    src="/img/agentruntime.jpg"
                    alt="Agent Runtime"
                    className={styles.componentImage}
                  />
                  <Link to="/docs/core/agents" className={styles.componentImageLink}>
                    <strong>🤖 Agent Runtime</strong>
                    <span>
                      Orchestrates agent behavior, manages state, and coordinates components.
                    </span>
                  </Link>
                </div>
                <div className={styles.componentImageCard}>
                  <img src="/img/services.jpg" alt="Services" className={styles.componentImage} />
                  <Link to="/docs/core/services" className={styles.componentImageLink}>
                    <strong>📚 Services</strong>
                    <span>
                      Enables agents to communicate across Discord, Twitter, Telegram, and other
                      platforms.
                    </span>
                  </Link>
                </div>
                <div className={styles.componentImageCard}>
                  <img src="/img/database.jpg" alt="Database" className={styles.componentImage} />
                  <Link to="/docs/core/database" className={styles.componentImageLink}>
                    <strong>💾 Database</strong>
                    <span>
                      Stores memories, entity data, relationships, and configuration using vector
                      search.
                    </span>
                  </Link>
                </div>
              </div>
            </div>

            <div className={styles.componentSection}>
              <h3>Intelligence & Behavior</h3>
              <div className={styles.componentImageGrid}>
                <div className={styles.componentImageCard}>
                  <img src="/img/actions.jpg" alt="Actions" className={styles.componentImage} />
                  <Link to="/docs/core/actions" className={styles.componentImageLink}>
                    <strong>⚡ Actions</strong>
                    <span>
                      Executable capabilities for agents to respond and interact with systems.
                    </span>
                  </Link>
                </div>
                <div className={styles.componentImageCard}>
                  <img src="/img/providers.jpg" alt="Providers" className={styles.componentImage} />
                  <Link to="/docs/core/providers" className={styles.componentImageLink}>
                    <strong>🔌 Providers</strong>
                    <span>Supplies context to inform agent decisions in real time.</span>
                  </Link>
                </div>
                <div className={styles.componentImageCard}>
                  <img
                    src="/img/evaluators.jpg"
                    alt="Evaluators"
                    className={styles.componentImage}
                  />
                  <Link to="/docs/core/evaluators" className={styles.componentImageLink}>
                    <strong>📊 Evaluators</strong>
                    <span>
                      Analyzes conversations to extract insights and improve future responses.
                    </span>
                  </Link>
                </div>
              </div>
            </div>

            <div className={styles.componentSection}>
              <h3>Structure & Organization</h3>
              <div className={styles.componentImageGrid}>
                <div className={styles.componentImageCard}>
                  <img src="/img/worlds.jpg" alt="Worlds" className={styles.componentImage} />
                  <Link to="/docs/core/worlds" className={styles.componentImageLink}>
                    <strong>🌐 Worlds</strong>
                    <span>Organizes environments like servers or projects.</span>
                  </Link>
                </div>
                <div className={styles.componentImageCard}>
                  <img src="/img/rooms.jpg" alt="Rooms" className={styles.componentImage} />
                  <Link to="/docs/core/rooms" className={styles.componentImageLink}>
                    <strong>💬 Rooms</strong>
                    <span>Spaces for conversation, like channels or DMs.</span>
                  </Link>
                </div>
                <div className={styles.componentImageCard}>
                  <img src="/img/entities.jpg" alt="Entities" className={styles.componentImage} />
                  <Link to="/docs/core/entities" className={styles.componentImageLink}>
                    <strong>👤 Entities</strong>
                    <span>Represents users, bots, and other participants.</span>
                  </Link>
                </div>
              </div>
            </div>

            <div className={styles.componentSection}>
              <h3>Development & Integration</h3>
              <div className={styles.componentImageGrid}>
                <div className={styles.componentImageCard}>
                  <img src="/img/knowledge.jpg" alt="Knowledge" className={styles.componentImage} />
                  <Link to="/docs/core/knowledge" className={styles.componentImageLink}>
                    <strong>🧠 Knowledge</strong>
                    <span>RAG system for document processing and semantic memory.</span>
                  </Link>
                </div>
                <div className={styles.componentImageCard}>
                  <img src="/img/project.jpg" alt="Projects" className={styles.componentImage} />
                  <Link to="/docs/core/project" className={styles.componentImageLink}>
                    <strong>📝 Projects</strong>
                    <span>Defines and deploys agents with configurations.</span>
                  </Link>
                </div>
                <div className={styles.componentImageCard}>
                  <img src="/img/tasks.jpg" alt="Tasks" className={styles.componentImage} />
                  <Link to="/docs/core/tasks" className={styles.componentImageLink}>
                    <strong>📋 Tasks</strong>
                    <span>Manages scheduled and deferred operations.</span>
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className={styles.learnMore}>
          <h2>Learn More About ElizaOS</h2>
          <div className={styles.buttonGroup}>
            <Link to="/docs/intro" className={styles.learnMoreLink}>
              Explore Documentation
            </Link>
            <a
              href="https://calendar.google.com/calendar/embed?src=c_ed31cea342d3e2236f549161e6446c3e407e5625ee7a355c0153befc7a602e7f%40group.calendar.google.com&ctz=America%2FToronto"
              className={styles.calendarLink}
              target="_blank"
              rel="noopener noreferrer"
            >
              <svg className={styles.calendarIcon} viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zM9 14H7v-2h2v2zm4 0h-2v-2h2v2zm4 0h-2v-2h2v2zm-8 4H7v-2h2v2zm4 0h-2v-2h2v2zm4 0h-2v-2h2v2z" />
              </svg>
              View Calendar
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
