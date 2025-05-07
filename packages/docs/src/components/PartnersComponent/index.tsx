import React, { useMemo } from 'react';
import type { JSX } from 'react';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';
import { partners } from '@site/src/data/partners';

// Define the PartnerType interface
interface PartnerType {
  title: string;
  description: string;
  preview: string;
  tags: string[];
  twitter?: string;
  discord?: string;
  telegram?: string;
  slug: string;
}

// Memoized partner card component to prevent unnecessary re-renders
const PartnerCard = React.memo(({ partner }: { partner: PartnerType }) => {
  return (
    <div className={styles.partnerCard}>
      <div className={styles.partnerImageContainer}>
        <img
          src={partner.preview}
          alt={`${partner.title} logo`}
          className={styles.partnerImage}
          loading="lazy"
          width="200"
          height="200"
        />
      </div>

      <div className={styles.partnerContent}>
        <div className={styles.partnerTitleContainer}>
          <Link to={`/partners/${partner.slug}/`} className={styles.partnerTitle}>
            {partner.title}
          </Link>
          {partner.twitter && (
            <a
              href={partner.twitter}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.socialLink}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
          )}
        </div>
        <p className={styles.partnerDescription}>{partner.description}</p>
      </div>
    </div>
  );
});

PartnerCard.displayName = 'PartnerCard';

export default function PartnersComponent(): JSX.Element {
  // Memoize the sorted partners to prevent recalculation on every render
  const sortedPartners = useMemo(() => {
    return [...partners].sort((a, b) => a.title.localeCompare(b.title));
  }, []);

  return (
    <div className={styles.partnersContainer}>
      <div className={styles.partnersHeader}>
        <h1>Our Partners</h1>
        <p>
          Discover the innovative projects and organizations we collaborate with to advance Web3
          technology.
        </p>
      </div>
      <div className={styles.partnersGrid}>
        {sortedPartners.map((partner) => (
          <PartnerCard key={partner.title} partner={partner} />
        ))}
      </div>
    </div>
  );
}
