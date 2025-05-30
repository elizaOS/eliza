// src/components/HomepageHeader/index.jsx
import React from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Link from '@docusaurus/Link';
import Heading from '@theme/Heading';

import styles from './styles.module.css';

function HomepageHeader() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <header className={styles.heroBanner}>
      <div className="container">
        <div className={styles.heroSection}>
          <div className={styles.heroLeft}>
            <h1 className={styles.heroTitle}>
              <span className={styles.heroTitlePrefix}>eliza</span> is a{' '}
              <span className={styles.heroTitleHighlight}>powerful AI agent framework</span> for
              autonomy & personality
            </h1>
            <p className={styles.heroSubtitle}>{siteConfig.tagline}</p>
            <div className={styles.buttonGroup}>
              <Link className="button button--primary button--lg" to="/docs">
                Get Started
              </Link>
              <div className={styles.githubButton}>
                <iframe
                  src="https://ghbtns.com/github-btn.html?user=elizaos&repo=eliza&type=star&count=true&size=large"
                  frameBorder="0"
                  scrolling="0"
                  width="170"
                  height="30"
                  title="GitHub"
                ></iframe>
              </div>
              <div className={styles.llmsCallout}>
                <span className={styles.newBadge}>NEW! </span>
                <span>Copy </span>
                <Link href="/llms-full.txt" target="_blank" className={styles.llmsLink}>
                  llms-full.txt
                </Link>
                <span> to chat with the docs using LLMs 💬</span>
              </div>
            </div>
          </div>
          <div className={styles.heroRight}>
            <div className={styles.heroVisual}>
              <div className={styles.blurCircle}></div>
              <div className={styles.codeBlockWrapper}>
                <div className={styles.codeBlockHeader}>
                  <div className={styles.codeBlockDot}></div>
                  <div className={styles.codeBlockDot}></div>
                  <div className={styles.codeBlockDot}></div>
                  <div className={styles.codeFileName}>terminal</div>
                </div>
                <pre className={styles.codeBlock}>
                  <code>
                    <span className={styles.comment}># Uses node 23+</span>
                    <br />
                    <span className={styles.prompt}>$</span> npm install -g @elizaos/cli
                    <br />
                    <span className={styles.prompt}>$</span> elizaos create
                    <br />
                  </code>
                </pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

export default HomepageHeader;
