// src/pages/index.jsx
import React from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import HomepageHeader from '../components/HomepageHeader';
import HomepageFeatures from '../components/HomepageFeatures';
import DailyNews from '../components/DailyNews';
import styles from './index.module.css';

export default function Home() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout title={siteConfig.title} description={siteConfig.tagline}>
      <main className={styles.mainContent}>
        <HomepageHeader />
        <HomepageFeatures />
        <div className={styles.newsSectionWrapper}>
          <DailyNews />
        </div>
      </main>
    </Layout>
  );
}
